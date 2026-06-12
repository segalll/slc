import { Server, type Socket } from "socket.io";
import { coordToUint16, directionToVector, Direction, gameStatePacket, gameTailPacket, uint16Max, worldStatePacket } from "../shared/model.js";
import {
    buildFieldSegments,
    getConvexHull,
    getFieldMinRadius,
    getPortalCapSegments,
    getSegmentIntersection,
    isPointInField,
    isPointInPolygon,
    isSegmentInField,
    pointToSegmentDistanceSq,
    segmentToQuad
} from "../shared/geometry.js";
import type { Point, Segment, PortalPair, PlayerInfo, GameSettings, FieldShape } from "../shared/model.js";

interface Player {
    id: string;
    index: number;
    name: string;
    color: [number, number, number];
    score: number;

    startingDirection: Direction | null;
    direction: Direction;
    segments: Segment[];
    fieldPartitions: Set<number>[]; // each partition is a set of indices into segments
    dead: boolean;

    socket: Socket;
    lastSentSegmentIndices: Map<string, number>; // per player
    pendingReliableState: boolean;
}

interface PortalHit {
    point: Point;
    exitPoint: Point;
    exitDirection: Direction;
    pairIndex: number;
    side: 0 | 1;
}

interface IgnoredPortal {
    pairIndex: number;
    side: 0 | 1;
}

const settingLimits = {
    moveSpeed: { min: 0.1, max: 2.0 },
    lineWidth: { min: 0.001, max: 0.02 },
    aspectRatio: { min: 0.2, max: 5.0 }
} as const;

const isNumberInRange = (value: number, limit: { readonly min: number; readonly max: number }) => {
    return typeof value === "number" && Number.isFinite(value) && value >= limit.min && value <= limit.max;
}

const colorFromHex = (hex: string): [number, number, number] => {
    const r = parseInt(hex.slice(1, 3), 16) / 255.0;
    const g = parseInt(hex.slice(3, 5), 16) / 255.0;
    const b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [ r, g, b ];
}

export class Game {
    private server: Server;
    private players: Map<string, Player>;

    private numPartitions: number = 10; // number of partitions per axis
    private moveSpeed: number = 0.3;
    private tickRate: number = 60;
    private subTickRate: number = 3;
    private aspectRatio: number = 1.5;
    private fieldShape: FieldShape = "rectangle";
    private lineWidth: number = 0.002;
    private fieldSegments: Segment[] = buildFieldSegments(this.aspectRatio, this.fieldShape);
    private obstacles: boolean = false;
    private portals: boolean = false;
    private worldSegments: Segment[] = [];
    private portalPairs: PortalPair[] = [];
    private portalCapSegments: Segment[] = [];
    private worldPartitions: Set<number>[];
    private minSpawnDistanceFromEdge: number = 0.1;
    private minSpawnDistanceFromObstacle: number = 0.12;

    private static readonly defaultMoveSpeed = 0.3;
    private static readonly defaultLineWidth = 0.002;
    private static readonly defaultAspectRatio = 1.5;
    private static readonly defaultFieldShape: FieldShape = "rectangle";
    private static readonly defaultObstacles = false;
    private static readonly defaultPortals = false;
    private static readonly countdownDuration = 3000;

    private playing: boolean = false;
    private roundStartTime: number | null = null;
    private prevAlive: string[] = []; // list of ids of players that were alive last tick
    private nextPlayerIndex: number = 0;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        this.worldPartitions = this.createPartitionGrid();
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    getSettings(): GameSettings {
        return {
            aspectRatio: this.aspectRatio,
            fieldShape: this.fieldShape,
            lineWidth: this.lineWidth,
            moveSpeed: this.moveSpeed,
            obstacles: this.obstacles,
            portals: this.portals
        };
    }

    updateSettings(settings: Partial<GameSettings>) {
        let moveSpeed = this.moveSpeed;
        let lineWidth = this.lineWidth;
        let aspectRatio = this.aspectRatio;
        let fieldShape = this.fieldShape;
        let obstacles = this.obstacles;
        let portals = this.portals;
        let changed = false;
        let worldChanged = false;
        let obstaclesChanged = false;
        let portalsChanged = false;
        let fieldChanged = false;

        if (settings.moveSpeed !== undefined) {
            if (!isNumberInRange(settings.moveSpeed, settingLimits.moveSpeed)) return;
            moveSpeed = settings.moveSpeed;
            changed = true;
        }
        if (settings.lineWidth !== undefined) {
            if (!isNumberInRange(settings.lineWidth, settingLimits.lineWidth)) return;
            lineWidth = settings.lineWidth;
            changed = true;
            worldChanged = true;
        }
        if (settings.aspectRatio !== undefined) {
            if (!isNumberInRange(settings.aspectRatio, settingLimits.aspectRatio)) return;
            aspectRatio = settings.aspectRatio;
            changed = true;
            worldChanged = true;
            fieldChanged = true;
        }
        if (settings.fieldShape !== undefined) {
            fieldShape = settings.fieldShape;
            changed = true;
            fieldChanged = true;
        }
        if (settings.obstacles !== undefined) {
            obstacles = settings.obstacles;
            changed = true;
            worldChanged = true;
            obstaclesChanged = true;
        }
        if (settings.portals !== undefined) {
            portals = settings.portals;
            changed = true;
            worldChanged = true;
            portalsChanged = true;
        }
        if (!changed) {
            return;
        }

        this.moveSpeed = moveSpeed;
        this.lineWidth = lineWidth;
        this.aspectRatio = aspectRatio;
        this.fieldShape = fieldShape;
        this.obstacles = obstacles;
        this.portals = portals;
        if (fieldChanged) {
            this.rebuildFieldSegments();
        }
        if (worldChanged) {
            this.rebuildWorldPartitions();
            this.setPortalPairs(this.portalPairs);
        }
        this.server.emit("game_settings", this.getSettings());
        if ((obstaclesChanged || portalsChanged || fieldChanged) && !this.playing) {
            if (this.roundStartTime !== null) {
                this.buildRoundWorld();
            } else {
                this.setWorldSegments([]);
                this.setPortalPairs([]);
            }
            this.sendWorldState();
        } else if (worldChanged && (this.worldSegments.length > 0 || this.portalPairs.length > 0)) {
            this.sendWorldState();
        }
    }

    private segmentToPartitions(segment: Segment): number[] {
        const partitionSizeX = 2 * this.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const minX = Math.floor((Math.min(segment[0][0], segment[1][0]) - this.lineWidth + this.aspectRatio) / partitionSizeX);
        const maxX = Math.floor((Math.max(segment[0][0], segment[1][0]) + this.lineWidth + this.aspectRatio) / partitionSizeX);
        const minY = Math.floor((Math.min(segment[0][1], segment[1][1]) - this.lineWidth + 1.0) / partitionSizeY);
        const maxY = Math.floor((Math.max(segment[0][1], segment[1][1]) + this.lineWidth + 1.0) / partitionSizeY);
        const partitions = new Set<number>();
        const addPartition = (x: number, y: number) => {
            if (x >= 0 && x < this.numPartitions && y >= 0 && y < this.numPartitions) {
                partitions.add(y * this.numPartitions + x);
            }
        }

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                addPartition(x, y);
            }
        }
        return [...partitions];
    }

    private createPartitionGrid() {
        const partitions = new Array<Set<number>>(this.numPartitions * this.numPartitions);
        for (let i = 0; i < partitions.length; i++) {
            partitions[i] = new Set<number>();
        }
        return partitions;
    }

    private addSegmentToPartitions(partitions: Set<number>[], segmentIndex: number, segment: Segment) {
        for (const partition of this.segmentToPartitions(segment)) {
            partitions[partition].add(segmentIndex);
        }
    }

    private rebuildFieldSegments() {
        this.fieldSegments = buildFieldSegments(this.aspectRatio, this.fieldShape);
    }

    private setWorldSegments(segments: Segment[]) {
        this.worldSegments = segments;
        this.rebuildWorldPartitions();
    }

    private setPortalPairs(pairs: PortalPair[]) {
        this.portalPairs = pairs;
        this.portalCapSegments = pairs.flatMap(pair => pair.flatMap(segment => getPortalCapSegments(segment, this.lineWidth)));
    }

    private buildRoundWorld() {
        this.setWorldSegments(this.obstacles ? this.buildRandomObstacles() : []);
        this.setPortalPairs(this.portals ? this.buildRandomPortalPairs() : []);
    }

    private rebuildWorldPartitions() {
        this.worldPartitions = this.createPartitionGrid();
        for (let i = 0; i < this.worldSegments.length; i++) {
            this.addSegmentToPartitions(this.worldPartitions, i, this.worldSegments[i]);
        }
    }

    private buildRandomObstacles(): Segment[] {
        const segments: Segment[] = [];
        const numSegments = 2 + Math.floor(Math.random() * 5);
        for (let i = 0; i < numSegments; i++) {
            const segment = this.buildRandomObstacle();
            if (segment) {
                segments.push(segment);
            }
        }
        return segments;
    }

    private buildRandomObstacle(): Segment | null {
        const fieldMargin = this.getFieldMargin();
        for (let i = 0; i < 64; i++) {
            const center = this.getRandomFieldPoint(fieldMargin);
            const angle = Math.random() * Math.PI * 2;
            const length = getFieldMinRadius(this.aspectRatio) * (0.25 + Math.random() * 0.35);
            const dx = Math.cos(angle) * length / 2;
            const dy = Math.sin(angle) * length / 2;
            const segment: Segment = [[center[0] - dx, center[1] - dy], [center[0] + dx, center[1] + dy]];
            if (isSegmentInField(segment, this.fieldSegments, fieldMargin)) {
                return segment;
            }
        }
        return null;
    }

    private buildRandomPortalPairs(): PortalPair[] {
        const first = this.buildRandomPortalSegment([]);
        if (!first) {
            return [];
        }

        const second = this.buildRandomPortalSegment([first]);
        return second ? [[first, second]] : [];
    }

    private buildRandomPortalSegment(existingSegments: Segment[]): Segment | null {
        const fieldMargin = this.getFieldMargin();
        for (let i = 0; i < 64; i++) {
            const center = this.getRandomFieldPoint(fieldMargin);
            const length = getFieldMinRadius(this.aspectRatio) * (0.18 + Math.random() * 0.16);
            const horizontal = Math.random() < 0.5;
            const half = length / 2;
            let segment: Segment = horizontal
                ? [[center[0] - half, center[1]], [center[0] + half, center[1]]]
                : [[center[0], center[1] - half], [center[0], center[1] + half]];
            if (Math.random() < 0.5) {
                segment = [segment[1], segment[0]];
            }
            if (this.isPortalSegmentClear(segment, existingSegments, fieldMargin)) {
                return segment;
            }
        }
        return null;
    }

    private isPortalSegmentClear(segment: Segment, existingSegments: Segment[], fieldMargin: number) {
        const candidateSegments = [segment, ...getPortalCapSegments(segment, this.lineWidth)];
        const blockingSegments = [
            ...this.worldSegments,
            ...existingSegments.flatMap(segment => [segment, ...getPortalCapSegments(segment, this.lineWidth)])
        ];
        if (candidateSegments.some(segment => !isSegmentInField(segment, this.fieldSegments, fieldMargin))) {
            return false;
        }
        for (const candidate of candidateSegments) {
            for (const blocker of blockingSegments) {
                if (this.lineToLineCollision(candidate, blocker)) {
                    return false;
                }
            }
        }
        return true;
    }

    private getRandomFieldPoint(margin: number = 0): Point {
        let point: Point = [0, 0];
        for (let i = 0; i < 64; i++) {
            point = [
                Math.random() * 2 * this.aspectRatio - this.aspectRatio,
                Math.random() * 2 - 1
            ];
            if (isPointInField(point, this.fieldSegments, margin)) {
                return point;
            }
        }
        return [0, 0];
    }

    private getFieldMargin() {
        if (this.fieldShape === "rectangle") {
            return this.minSpawnDistanceFromEdge;
        }
        return Math.min(this.minSpawnDistanceFromEdge, getFieldMinRadius(this.aspectRatio) * 0.25);
    }

    private getSpawnPoint(): Point {
        let spawnPoint: Point = [0, 0];
        const fieldMargin = this.getFieldMargin();
        for (let i = 0; i < 32; i++) {
            spawnPoint = this.getRandomFieldPoint(fieldMargin);
            if (this.isSpawnPointClear(spawnPoint, fieldMargin)) {
                break;
            }
        }
        return spawnPoint;
    }

    private isSpawnPointClear(point: Point, fieldMargin: number) {
        if (!isPointInField(point, this.fieldSegments, fieldMargin)) {
            return false;
        }

        const minDistSq = this.minSpawnDistanceFromObstacle * this.minSpawnDistanceFromObstacle;
        for (const segment of this.worldSegments) {
            if (pointToSegmentDistanceSq(point, segment) < minDistSq) {
                return false;
            }
        }
        for (const [portalA, portalB] of this.portalPairs) {
            if (pointToSegmentDistanceSq(point, portalA) < minDistSq || pointToSegmentDistanceSq(point, portalB) < minDistSq) {
                return false;
            }
        }
        return true;
    }

    private getBoundaryCollision(oldEnd: Point, newEnd: Point): Point | null {
        if (isPointInField(newEnd, this.fieldSegments, this.lineWidth)) {
            return null;
        }

        const movement: Segment = [oldEnd, newEnd];
        let closestCollision: Point | null = null;
        let closestDistSq = Infinity;
        for (const boundary of this.fieldSegments) {
            const collision = this.lineToLineCollision(movement, boundary);
            if (!collision) {
                continue;
            }

            const dx = collision[0] - oldEnd[0];
            const dy = collision[1] - oldEnd[1];
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestCollision = collision;
            }
        }
        return closestCollision ?? oldEnd;
    }

    private lineToLineCollision(line1: Segment, line2: Segment): Point | null {
        const dx = line1[1][0] - line1[0][0];
        const dy = line1[1][1] - line1[0][1];
        const length = Math.hypot(dx, dy);
        if (length === 0) {
            return null;
        }

        const normal: Point = [-dy / length * this.lineWidth, dx / length * this.lineWidth];
        const quad = segmentToQuad(line2, this.lineWidth);
        if (!quad) {
            return null;
        }
        const collisionPolygon = getConvexHull(quad.flatMap(point => [
            [point[0] + normal[0], point[1] + normal[1]] as Point,
            [point[0] - normal[0], point[1] - normal[1]] as Point
        ]));

        if (isPointInPolygon(line1[0], collisionPolygon)) {
            return line1[0];
        }

        let closestCollision: Point | null = null;
        let closestDistSq = Infinity;
        for (let i = 0; i < collisionPolygon.length; i++) {
            const edge: Segment = [collisionPolygon[i], collisionPolygon[(i + 1) % collisionPolygon.length]];
            const collision = getSegmentIntersection(line1, edge);
            if (!collision) {
                continue;
            }

            const dx = collision[0] - line1[0][0];
            const dy = collision[1] - line1[0][1];
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestCollision = collision;
            }
        }
        return closestCollision;
    }

    private getPortalNormal(segment: Segment): Point {
        const dx = segment[1][0] - segment[0][0];
        const dy = segment[1][1] - segment[0][1];
        const length = Math.hypot(dx, dy);
        return [-dy / length, dx / length];
    }

    private directionFromVector(vector: Point): Direction {
        if (vector[0] > 0) return Direction.Right;
        if (vector[0] < 0) return Direction.Left;
        if (vector[1] > 0) return Direction.Up;
        return Direction.Down;
    }

    private pointOnSegment(segment: Segment, t: number): Point {
        return [
            segment[0][0] + (segment[1][0] - segment[0][0]) * t,
            segment[0][1] + (segment[1][1] - segment[0][1]) * t
        ];
    }

    private getSegmentT(segment: Segment, point: Point) {
        const dx = segment[1][0] - segment[0][0];
        const dy = segment[1][1] - segment[0][1];
        const lengthSq = dx * dx + dy * dy;
        return ((point[0] - segment[0][0]) * dx + (point[1] - segment[0][1]) * dy) / lengthSq;
    }

    private getPortalHit(direction: Direction, oldEnd: Point, newEnd: Point): PortalHit | null {
        const movement: Segment = [oldEnd, newEnd];
        const directionVector = directionToVector(direction);
        let closestHit: PortalHit | null = null;
        let closestDistSq = Infinity;

        for (let pairIndex = 0; pairIndex < this.portalPairs.length; pairIndex++) {
            const pair = this.portalPairs[pairIndex];
            for (const side of [0, 1] as const) {
                const entry = pair[side];
                const exit = pair[side === 0 ? 1 : 0];
                const normal = this.getPortalNormal(entry);
                const sideSign = directionVector[0] * normal[0] + directionVector[1] * normal[1];
                if (sideSign === 0) {
                    continue;
                }

                const point = this.lineToLineCollision(movement, entry);
                if (!point) {
                    continue;
                }

                const t = this.getSegmentT(entry, point);
                if (t < 0 || t > 1) {
                    continue;
                }

                const dx = point[0] - oldEnd[0];
                const dy = point[1] - oldEnd[1];
                const distSq = dx * dx + dy * dy;
                if (distSq >= closestDistSq || distSq <= 0) {
                    continue;
                }

                const exitNormal = this.getPortalNormal(exit);
                const exitVector: Point = [exitNormal[0] * Math.sign(sideSign), exitNormal[1] * Math.sign(sideSign)];
                closestDistSq = distSq;
                closestHit = {
                    point,
                    exitPoint: this.pointOnSegment(exit, t),
                    exitDirection: this.directionFromVector(exitVector),
                    pairIndex,
                    side
                };
            }
        }

        return closestHit;
    }

    private getClosestTrailCollision(
        player: Player,
        oldSegmentEnd: Point,
        newSegmentEnd: Point,
        partitions: number[],
        ignoredPortal?: IgnoredPortal
    ): Point | null {
        const consideredSegment = [ oldSegmentEnd, newSegmentEnd ] as Segment;
        let closestCollision: Point | null = null;
        let closestDistSq = Infinity;
        const considerCollision = (collision: Point | null) => {
            if (!collision) {
                return;
            }

            const dx = collision[0] - oldSegmentEnd[0];
            const dy = collision[1] - oldSegmentEnd[1];
            const distSq = dx * dx + dy * dy;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestCollision = collision;
            }
        }

        for (const partition of partitions) {
            for (const player2 of this.players.values()) {
                for (const segmentIndex of player2.fieldPartitions[partition]) {
                    if (player.id === player2.id && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                    considerCollision(this.lineToLineCollision(consideredSegment, player2.segments[segmentIndex]));
                }
            }
            for (const segmentIndex of this.worldPartitions[partition]) {
                considerCollision(this.lineToLineCollision(consideredSegment, this.worldSegments[segmentIndex]));
            }
        }

        for (const cap of this.portalCapSegments) {
            considerCollision(this.lineToLineCollision(consideredSegment, cap));
        }

        for (let pairIndex = 0; pairIndex < this.portalPairs.length; pairIndex++) {
            const pair = this.portalPairs[pairIndex];
            for (const side of [0, 1] as const) {
                if (ignoredPortal?.pairIndex === pairIndex && ignoredPortal.side === side) {
                    continue;
                }
                considerCollision(this.lineToLineCollision(consideredSegment, pair[side]));
            }
        }

        return closestCollision;
    }

    startRound() {
        if (this.playing || this.roundStartTime !== null || this.players.size < 2) {
            return;
        }
        this.buildRoundWorld();
        this.sendWorldState();

        for (const player of this.players.values()) {
            const startPoint = this.getSpawnPoint();

            player.direction = Math.floor(Math.random() * 4);
            const directionVector = directionToVector(player.direction);
            const endPoint: Point = [ startPoint[0] + directionVector[0] * this.lineWidth, startPoint[1] + directionVector[1] * this.lineWidth ];
            const segment = [ startPoint, endPoint ] as Segment;

            player.segments = [segment];
            player.fieldPartitions = this.createPartitionGrid();
            this.addSegmentToPartitions(player.fieldPartitions, 0, segment);

            player.dead = false;
            player.pendingReliableState = false;

            for (const id of this.players.keys()) {
                player.lastSentSegmentIndices.set(id, 0);
            }
        }

        this.server.emit("starting");
        for (const receiver of this.players.values()) {
            this.sendGameState(receiver);
        }

        this.prevAlive = Array.from(this.players.keys());
        this.roundStartTime = Date.now() + Game.countdownDuration;
    }

    addPlayer(socket: Socket, id: string, name: string, color: string) {
        if (!this.players.has(id)) {
            const colorVector = colorFromHex(color);
            const score = 0;
            if (this.nextPlayerIndex > uint16Max) {
                socket.disconnect(true);
                return;
            }
            const index = this.nextPlayerIndex++;

            // introduce new player to existing players
            socket.broadcast.emit("modify_player", {
                id,
                index,
                name,
                color: colorVector,
                score
            } as PlayerInfo);

            const fieldPartitions = this.createPartitionGrid();

            this.players.set(id, {
                id,
                index,
                name,
                color: colorVector,
                score,

                startingDirection: null,
                direction: Direction.Up, // doesn't matter, will be overwritten
                segments: [],
                fieldPartitions,
                dead: true,

                socket,
                lastSentSegmentIndices: new Map<string, number>(),
                pendingReliableState: false
            });
        } else {
            const player = this.players.get(id)!;
            player.socket = socket;
            this.resetSentSegments(player);
        }

        for (const player of this.players.values()) {
            socket.emit("modify_player", {
                id: player.id,
                index: player.index,
                name: player.name,
                color: player.color,
                score: player.score
            } as PlayerInfo);
            this.sendGameState(this.players.get(id)!, [player]);
        }
        this.sendWorldState(socket);
    }

    removePlayer(id: string) {
        if (!this.players.has(id)) {
            return;
        }
        this.players.delete(id);
        for (const otherPlayer of this.players.values()) {
            otherPlayer.lastSentSegmentIndices.delete(id);
        }
        this.server.emit("remove", id);

        if (this.players.size === 0) {
            this.moveSpeed = Game.defaultMoveSpeed;
            this.lineWidth = Game.defaultLineWidth;
            this.aspectRatio = Game.defaultAspectRatio;
            this.fieldShape = Game.defaultFieldShape;
            this.rebuildFieldSegments();
            this.obstacles = Game.defaultObstacles;
            this.portals = Game.defaultPortals;
            this.setWorldSegments([]);
            this.setPortalPairs([]);
            this.nextPlayerIndex = 0;
        }
    }

    processInput(id: string, direction: Direction) {
        if (!this.players.has(id)) {
            return;
        }

        const player = this.players.get(id)!;
        if (!this.playing) {
            player.startingDirection = direction;
            return;
        }
        if (player.dead) {
            return;
        }

        if (this.addSegment(player, direction)) {
            for (const receiver of this.players.values()) {
                this.sendGameState(receiver, [player]);
            }
        }
    }

    private resetSentSegments(player: Player) {
        for (const playerId of this.players.keys()) {
            player.lastSentSegmentIndices.set(playerId, 0);
        }
    }

    private addSegment(player: Player, direction: Direction): boolean {
        if (player.dead) {
            return false;
        }
        if (player.segments.length >= uint16Max) {
            return false;
        }

        const lastDirection = directionToVector(player.direction);
        if ((direction === Direction.Right && lastDirection[1] === 0.0) ||
            (direction === Direction.Up && lastDirection[0] === 0.0) ||
            (direction === Direction.Down && lastDirection[0] === 0.0) ||
            (direction === Direction.Left && lastDirection[1] === 0.0)) {
            return false;
        }

        player.direction = direction;
        player.pendingReliableState = true;

        const lastEnd = player.segments[player.segments.length - 1][1];
        const newPoint: Point = [lastEnd[0], lastEnd[1]];
        switch (direction) {
            case Direction.Left:
                newPoint[0] -= this.lineWidth;
                newPoint[1] -= lastDirection[1] * this.lineWidth;
                break;
            case Direction.Right:
                newPoint[0] += this.lineWidth;
                newPoint[1] -= lastDirection[1] * this.lineWidth;
                break;
            case Direction.Up:
                newPoint[1] += this.lineWidth;
                newPoint[0] -= lastDirection[0] * this.lineWidth;
                break;
            case Direction.Down:
                newPoint[1] -= this.lineWidth;
                newPoint[0] -= lastDirection[0] * this.lineWidth;
                break;
        }
        player.segments.push([ newPoint, [newPoint[0], newPoint[1]] ] as Segment);
        return true;
    }

    private extendLastSegment(player: Player, duration: number) {
        if (player.dead) {
            return;
        }

        this.movePlayer(player, duration * this.moveSpeed / 1000);
    }

    private movePlayer(player: Player, distance: number, portalDepth: number = 0) {
        if (player.dead || distance <= 0) {
            return;
        }

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        const oldSegmentEnd: Point = [lastSegment[1][0], lastSegment[1][1]];
        lastSegment[1][0] += direction[0] * distance;
        lastSegment[1][1] += direction[1] * distance;

        const portalHit = portalDepth < 4 ? this.getPortalHit(player.direction, oldSegmentEnd, lastSegment[1]) : null;
        if (portalHit) {
            lastSegment[1] = portalHit.point;
        }

        const boundaryCollision = this.getBoundaryCollision(oldSegmentEnd, lastSegment[1]);
        if (boundaryCollision) {
            lastSegment[1] = boundaryCollision;
            player.dead = true;
            player.pendingReliableState = true;
            return;
        }

        const newPartitions = this.segmentToPartitions([ oldSegmentEnd, lastSegment[1] ]);
        for (const partition of newPartitions) {
            player.fieldPartitions[partition].add(player.segments.length - 1);
        }

        const ignoredPortal = portalHit ? { pairIndex: portalHit.pairIndex, side: portalHit.side } : undefined;
        const closestCollision = this.getClosestTrailCollision(player, oldSegmentEnd, lastSegment[1], newPartitions, ignoredPortal);
        if (closestCollision) {
            player.dead = true;
            player.pendingReliableState = true;
            lastSegment[1] = closestCollision;
            return;
        }

        if (portalHit) {
            this.exitPortal(player, portalHit);
            const dx = portalHit.point[0] - oldSegmentEnd[0];
            const dy = portalHit.point[1] - oldSegmentEnd[1];
            const remainingDistance = distance - Math.hypot(dx, dy);
            this.movePlayer(player, remainingDistance, portalDepth + 1);
        }
    }

    private exitPortal(player: Player, portalHit: PortalHit) {
        if (player.segments.length >= uint16Max) {
            player.dead = true;
            return;
        }

        const directionVector = directionToVector(portalHit.exitDirection);
        const startPoint: Point = [
            portalHit.exitPoint[0] + directionVector[0] * this.lineWidth * 2,
            portalHit.exitPoint[1] + directionVector[1] * this.lineWidth * 2
        ];
        player.direction = portalHit.exitDirection;
        player.segments.push([startPoint, [startPoint[0], startPoint[1]]] as Segment);
        player.pendingReliableState = true;
    }

    private writeSegment(view: DataView, offset: number, segment: Segment) {
        view.setUint16(offset + worldStatePacket.segmentStartXOffset, coordToUint16(segment[0][0], -this.aspectRatio, this.aspectRatio), true);
        view.setUint16(offset + worldStatePacket.segmentStartYOffset, coordToUint16(segment[0][1], -1.0, 1.0), true);
        view.setUint16(offset + worldStatePacket.segmentEndXOffset, coordToUint16(segment[1][0], -this.aspectRatio, this.aspectRatio), true);
        view.setUint16(offset + worldStatePacket.segmentEndYOffset, coordToUint16(segment[1][1], -1.0, 1.0), true);
    }

    private sendGameState(receiver: Player, sources?: Iterable<Player>) {
        const playerData: { index: number; startIndex: number; segments: Segment[] }[] = [];
        let totalSegments = 0;

        for (const source of (sources ?? this.players.values())) {
            const lastSentIndex = receiver.lastSentSegmentIndices.get(source.id) ?? 0;
            const segments = source.segments.slice(lastSentIndex);
            if (segments.length > 0) {
                playerData.push({ index: source.index, startIndex: lastSentIndex, segments });
                totalSegments += segments.length;
                receiver.lastSentSegmentIndices.set(source.id, source.segments.length - 1);
            }
        }

        if (playerData.length === 0) return;

        const headerSize = gameStatePacket.playerCountBytes + playerData.length * gameStatePacket.playerHeaderBytes;
        const buffer = new ArrayBuffer(headerSize + totalSegments * gameStatePacket.segmentBytes);
        const view = new DataView(buffer);

        view.setUint8(gameStatePacket.playerCountOffset, playerData.length);

        let offset = gameStatePacket.playerCountBytes;
        let segmentOffset = headerSize;

        for (const { index, startIndex, segments } of playerData) {
            view.setUint16(offset + gameStatePacket.playerIndexOffset, index, true);
            view.setUint16(offset + gameStatePacket.playerStartIndexOffset, startIndex, true);
            view.setUint16(offset + gameStatePacket.playerSegmentCountOffset, segments.length, true);
            offset += gameStatePacket.playerHeaderBytes;

            for (const segment of segments) {
                this.writeSegment(view, segmentOffset, segment);
                segmentOffset += gameStatePacket.segmentBytes;
            }
        }

        receiver.socket.emit("game_state", buffer);
    }

    private sendWorldState(socket?: Socket) {
        const portalPairCountOffset = worldStatePacket.segmentCountBytes + this.worldSegments.length * worldStatePacket.segmentBytes;
        const buffer = new ArrayBuffer(
            portalPairCountOffset +
            worldStatePacket.portalPairCountBytes +
            this.portalPairs.length * worldStatePacket.portalPairBytes
        );
        const view = new DataView(buffer);
        view.setUint16(worldStatePacket.segmentCountOffset, this.worldSegments.length, true);

        let offset = worldStatePacket.segmentCountBytes;
        for (const segment of this.worldSegments) {
            this.writeSegment(view, offset, segment);
            offset += worldStatePacket.segmentBytes;
        }
        view.setUint8(offset, this.portalPairs.length);
        offset += worldStatePacket.portalPairCountBytes;

        for (const [portalA, portalB] of this.portalPairs) {
            this.writeSegment(view, offset + worldStatePacket.portalSegmentAOffset, portalA);
            this.writeSegment(view, offset + worldStatePacket.portalSegmentBOffset, portalB);
            offset += worldStatePacket.portalPairBytes;
        }

        if (socket) {
            socket.emit("world_state", buffer);
        } else {
            this.server.emit("world_state", buffer);
        }
    }

    private sendGameTail(reliable: boolean = false) {
        const playerData: { index: number; segmentIndex: number; end: Point }[] = [];

        for (const source of this.players.values()) {
            if (source.dead || source.segments.length === 0) {
                continue;
            }
            const segmentIndex = source.segments.length - 1;
            playerData.push({
                index: source.index,
                segmentIndex,
                end: source.segments[segmentIndex][1]
            });
        }

        if (playerData.length === 0) return;

        const buffer = new ArrayBuffer(gameTailPacket.playerCountBytes + playerData.length * gameTailPacket.playerBytes);
        const view = new DataView(buffer);

        view.setUint8(gameTailPacket.playerCountOffset, playerData.length);

        let offset = gameTailPacket.playerCountBytes;
        for (const { index, segmentIndex, end } of playerData) {
            view.setUint16(offset + gameTailPacket.playerIndexOffset, index, true);
            view.setUint16(offset + gameTailPacket.playerSegmentIndexOffset, segmentIndex, true);
            view.setUint16(offset + gameTailPacket.playerEndXOffset, coordToUint16(end[0], -this.aspectRatio, this.aspectRatio), true);
            view.setUint16(offset + gameTailPacket.playerEndYOffset, coordToUint16(end[1], -1.0, 1.0), true);
            offset += gameTailPacket.playerBytes;
        }

        for (const receiver of this.players.values()) {
            if (reliable) {
                receiver.socket.emit("game_tail", buffer);
            } else {
                receiver.socket.volatile.emit("game_tail", buffer);
            }
        }
    }

    private processSubTick() {
        const alive: string[] = [];
        for (const player of this.players.values()) {
            if (!player.dead) {
                alive.push(player.id);
                this.extendLastSegment(player, 1000 / (this.tickRate * this.subTickRate));
            }
        }
        return alive;
    }

    private beginPlaying() {
        for (const player of this.players.values()) {
            if (player.startingDirection !== null) {
                player.direction = player.startingDirection;
                const directionVector = directionToVector(player.direction);
                const startPoint = player.segments[0][0];
                const endPoint: Point = [ startPoint[0] + directionVector[0] * this.lineWidth, startPoint[1] + directionVector[1] * this.lineWidth ];
                player.segments = [[ startPoint, endPoint ] as Segment];
                this.resetSentSegments(player);
            }
        }
        this.roundStartTime = null;
        this.playing = true;
    }

    private sendDeathEvents(alive: string[]) {
        const aliveIds = new Set(alive);
        for (const id of this.prevAlive) {
            if (!aliveIds.has(id) && this.players.has(id)) {
                this.server.emit("death", id);
            }
        }
    }

    private gameLoop() {
        if (this.roundStartTime !== null && Date.now() >= this.roundStartTime) {
            this.beginPlaying();
        }

        if (!this.playing) {
            return;
        }

        for (let i = 0; i < this.subTickRate; i++) {
            const alive = this.processSubTick();
            this.sendDeathEvents(alive);
            if (alive.length <= 1) {
                this.playing = false;

                const winners = (alive.length === 1 ? alive : this.prevAlive).filter(id => this.players.has(id));
                if (winners.length > 0) {
                    this.server.emit("round_over");
                }
                for (const id of winners) {
                    const player = this.players.get(id)!;
                    player.score++;
                    this.server.emit("modify_player", {
                        id,
                        index: player.index,
                        name: player.name,
                        color: player.color,
                        score: player.score
                    } as PlayerInfo);
                }
                for (const player of this.players.values()) {
                    player.startingDirection = null;
                    player.pendingReliableState = false;
                    this.sendGameState(player);
                }
                let worldStateChanged = false;
                if (!this.obstacles && this.worldSegments.length > 0) {
                    this.setWorldSegments([]);
                    worldStateChanged = true;
                }
                if (!this.portals && this.portalPairs.length > 0) {
                    this.setPortalPairs([]);
                    worldStateChanged = true;
                }
                if (worldStateChanged) {
                    this.sendWorldState();
                }

                this.prevAlive = alive;
                return;
            }
            this.prevAlive = alive;
        }

        const reliableSources = Array.from(this.players.values()).filter(player => player.pendingReliableState);
        for (const receiver of this.players.values()) {
            receiver.startingDirection = null;
            if (reliableSources.length > 0) {
                this.sendGameState(receiver, reliableSources);
            }
        }
        this.sendGameTail(reliableSources.length > 0);
        for (const player of reliableSources) {
            player.pendingReliableState = false;
        }
    }
}
