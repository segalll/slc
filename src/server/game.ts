import { Server, type Socket } from "socket.io";
import { coordToUint16, directionToVector, Direction, gameStatePacket, gameTailPacket } from "../shared/model.js";
import type { Point, Segment, PlayerInfo, GameSettings } from "../shared/model.js";

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
    private lineWidth: number = 0.002;
    private minSpawnDistanceFromEdge: number = 0.1;

    private static readonly defaultMoveSpeed = 0.3;
    private static readonly defaultLineWidth = 0.002;
    private static readonly defaultAspectRatio = 1.5;
    private static readonly countdownDuration = 3000;

    private playing: boolean = false;
    private roundStartTime: number | null = null;
    private prevAlive: string[] = []; // list of ids of players that were alive last tick
    private nextPlayerIndex: number = 0;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    getSettings(): GameSettings {
        return {
            aspectRatio: this.aspectRatio,
            lineWidth: this.lineWidth,
            moveSpeed: this.moveSpeed
        };
    }

    updateSettings(settings: Partial<GameSettings>) {
        let moveSpeed = this.moveSpeed;
        let lineWidth = this.lineWidth;
        let aspectRatio = this.aspectRatio;
        let changed = false;

        if (settings.moveSpeed !== undefined) {
            if (!isNumberInRange(settings.moveSpeed, settingLimits.moveSpeed)) return;
            moveSpeed = settings.moveSpeed;
            changed = true;
        }
        if (settings.lineWidth !== undefined) {
            if (!isNumberInRange(settings.lineWidth, settingLimits.lineWidth)) return;
            lineWidth = settings.lineWidth;
            changed = true;
        }
        if (settings.aspectRatio !== undefined) {
            if (!isNumberInRange(settings.aspectRatio, settingLimits.aspectRatio)) return;
            aspectRatio = settings.aspectRatio;
            changed = true;
        }
        if (!changed) {
            return;
        }

        this.moveSpeed = moveSpeed;
        this.lineWidth = lineWidth;
        this.aspectRatio = aspectRatio;
        this.server.emit("game_settings", this.getSettings());
    }

    private segmentToPartitions(segment: Segment): number[] {
        const partitionSizeX = 2 * this.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x1 = (segment[0][0] + this.aspectRatio) / partitionSizeX;
        const y1 = (segment[0][1] + 1.0) / partitionSizeY;
        const x2 = (segment[1][0] + this.aspectRatio) / partitionSizeX;
        const y2 = (segment[1][1] + 1.0) / partitionSizeY;
        const partitions = new Set<number>();
        const addPartition = (x: number, y: number) => {
            if (x >= 0 && x < this.numPartitions && y >= 0 && y < this.numPartitions) {
                partitions.add(y * this.numPartitions + x);
            }
        }

        if (x1 === x2) {
            const width = this.lineWidth / partitionSizeX;
            for (let y = Math.floor(Math.min(y1, y2)); y <= Math.floor(Math.max(y1, y2)); y++) {
                for (let x = Math.floor(Math.min(x1, x2) - width); x <= Math.floor(Math.max(x1, x2) + width); x++) {
                    addPartition(x, y);
                }
            }
        } else if (y1 === y2) {
            const width = this.lineWidth / partitionSizeY;
            for (let x = Math.floor(Math.min(x1, x2)); x <= Math.floor(Math.max(x1, x2)); x++) {
                for (let y = Math.floor(Math.min(y1, y2) - width); y <= Math.floor(Math.max(y1, y2) + width); y++) {
                    addPartition(x, y);
                }
            }
        }
        return [...partitions];
    }

    private lineToLineCollision(line1: Segment, line2: Segment): [Point | null, Point | null] {
        const lineWidth = this.lineWidth;

        const line1Vertical = line1[0][0] === line1[1][0];
        const line2Vertical = line2[0][0] === line2[1][0];

        const line1BoundingBox = [
            [
                Math.min(line1[0][0], line1[1][0]) - (line1Vertical ? lineWidth : 0),
                Math.min(line1[0][1], line1[1][1]) - (line1Vertical ? 0 : lineWidth)
            ],
            [
                Math.max(line1[0][0], line1[1][0]) + (line1Vertical ? lineWidth : 0),
                Math.max(line1[0][1], line1[1][1]) + (line1Vertical ? 0 : lineWidth)
            ]
        ];
        const line2BoundingBox = [
            [
                Math.min(line2[0][0], line2[1][0]) - (line2Vertical ? lineWidth : 0),
                Math.min(line2[0][1], line2[1][1]) - (line2Vertical ? 0 : lineWidth)
            ],
            [
                Math.max(line2[0][0], line2[1][0]) + (line2Vertical ? lineWidth : 0),
                Math.max(line2[0][1], line2[1][1]) + (line2Vertical ? 0 : lineWidth)
            ]
        ];

        if (
            line1BoundingBox[0][0] <= line2BoundingBox[1][0] &&
            line1BoundingBox[1][0] >= line2BoundingBox[0][0] &&
            line1BoundingBox[0][1] <= line2BoundingBox[1][1] &&
            line1BoundingBox[1][1] >= line2BoundingBox[0][1]
        ) {
            const movingRight = line1[0][0] < line1[1][0];
            const movingUp = line1[0][1] < line1[1][1];
            const collisionStart: Point = [
                line1Vertical ? line1[0][0] : (movingRight ? line2BoundingBox[0][0] : line2BoundingBox[1][0]),
                line1Vertical ? (movingUp ? line2BoundingBox[0][1] : line2BoundingBox[1][1]) : line1[0][1]
            ];
            const collisionEnd: Point = [
                line1Vertical ? line1[0][0] : (movingRight ? line2BoundingBox[1][0] : line2BoundingBox[0][0]),
                line1Vertical ? (movingUp ? line2BoundingBox[1][1] : line2BoundingBox[0][1]) : line1[0][1]
            ];
            return [collisionStart, collisionEnd];
        } else {
            return [null, null];
        }
    }

    startRound() {
        if (this.playing || this.roundStartTime !== null || this.players.size < 2) {
            return;
        }
        for (const player of this.players.values()) {
            const startX = Math.random() * 2 * (this.aspectRatio - this.minSpawnDistanceFromEdge) - this.aspectRatio + this.minSpawnDistanceFromEdge;
            const startY = Math.random() * 2 * (1.0 - this.minSpawnDistanceFromEdge) - 1.0 + this.minSpawnDistanceFromEdge;
            const startPoint: Point = [ startX, startY ];

            player.direction = Math.floor(Math.random() * 4);
            const directionVector = directionToVector(player.direction);
            const endPoint: Point = [ startPoint[0] + directionVector[0] * this.lineWidth, startPoint[1] + directionVector[1] * this.lineWidth ];
            const segment = [ startPoint, endPoint ] as Segment;

            player.segments = [segment];
            player.fieldPartitions = new Array<Set<number>>(this.numPartitions * this.numPartitions);
            for (let i = 0; i < player.fieldPartitions.length; i++) {
                player.fieldPartitions[i] = new Set<number>();
            }
            for (const partition of this.segmentToPartitions(segment)) {
                player.fieldPartitions[partition].add(0);
            }

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
            const index = this.nextPlayerIndex++;

            // introduce new player to existing players
            socket.broadcast.emit("modify_player", {
                id,
                index,
                name,
                color: colorVector,
                score
            } as PlayerInfo);

            const fieldPartitions = new Array<Set<number>>(this.numPartitions * this.numPartitions);
            for (let i = 0; i < fieldPartitions.length; i++) {
                fieldPartitions[i] = new Set<number>();
            }

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
    }

    removePlayer(id: string) {
        if (!this.players.has(id)) {
            return;
        }
        this.players.delete(id);
        this.server.emit("remove", id);

        if (this.players.size === 0) {
            this.moveSpeed = Game.defaultMoveSpeed;
            this.lineWidth = Game.defaultLineWidth;
            this.aspectRatio = Game.defaultAspectRatio;
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

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        const spatialLength = duration * this.moveSpeed / 1000;
        const oldSegmentEnd: Point = [lastSegment[1][0], lastSegment[1][1]];
        lastSegment[1][0] += direction[0] * spatialLength;
        lastSegment[1][1] += direction[1] * spatialLength;

        if (lastSegment[1][0] < -this.aspectRatio) {
            lastSegment[1][0] = -this.aspectRatio;
            player.dead = true;
            player.pendingReliableState = true;
            return;
        }
        if (lastSegment[1][0] > this.aspectRatio) {
            lastSegment[1][0] = this.aspectRatio;
            player.dead = true;
            player.pendingReliableState = true;
            return;
        }
        if (lastSegment[1][1] < -1.0) {
            lastSegment[1][1] = -1.0;
            player.dead = true;
            player.pendingReliableState = true;
            return;
        }
        if (lastSegment[1][1] > 1.0) {
            lastSegment[1][1] = 1.0;
            player.dead = true;
            player.pendingReliableState = true;
            return;
        }

        const newPartitions = this.segmentToPartitions([ oldSegmentEnd, lastSegment[1] ]);
        for (const partition of newPartitions) {
            player.fieldPartitions[partition].add(player.segments.length - 1);
        }

        let closestCollision: Point | null = null;
        let closestDistSq = Infinity;

        for (const partition of newPartitions) {
            for (const player2 of this.players.values()) {
                for (const segmentIndex of player2.fieldPartitions[partition]) {
                    if (player.id === player2.id && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                    const consideredSegment = [ oldSegmentEnd, lastSegment[1] ] as Segment;
                    const [collisionStart, collisionEnd] = this.lineToLineCollision(consideredSegment, player2.segments[segmentIndex]);
                    if (collisionStart && collisionEnd) {
                        const dx = collisionStart[0] - oldSegmentEnd[0];
                        const dy = collisionStart[1] - oldSegmentEnd[1];
                        const distSq = dx * dx + dy * dy;
                        if (distSq < closestDistSq) {
                            closestDistSq = distSq;
                            closestCollision = collisionStart;
                        }
                    }
                }
            }
        }

        if (closestCollision) {
            player.dead = true;
            player.pendingReliableState = true;
            lastSegment[1] = closestCollision;
        }
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
            view.setUint8(offset + gameStatePacket.playerIndexOffset, index);
            view.setUint32(offset + gameStatePacket.playerStartIndexOffset, startIndex, true);
            view.setUint16(offset + gameStatePacket.playerSegmentCountOffset, segments.length, true);
            offset += gameStatePacket.playerHeaderBytes;

            for (const segment of segments) {
                view.setUint16(segmentOffset + gameStatePacket.segmentStartXOffset, coordToUint16(segment[0][0], -this.aspectRatio, this.aspectRatio), true);
                view.setUint16(segmentOffset + gameStatePacket.segmentStartYOffset, coordToUint16(segment[0][1], -1.0, 1.0), true);
                view.setUint16(segmentOffset + gameStatePacket.segmentEndXOffset, coordToUint16(segment[1][0], -this.aspectRatio, this.aspectRatio), true);
                view.setUint16(segmentOffset + gameStatePacket.segmentEndYOffset, coordToUint16(segment[1][1], -1.0, 1.0), true);
                segmentOffset += gameStatePacket.segmentBytes;
            }
        }

        receiver.socket.emit("game_state", buffer);
    }

    private sendGameTail(receiver: Player, reliable: boolean = false) {
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
            view.setUint8(offset + gameTailPacket.playerIndexOffset, index);
            view.setUint32(offset + gameTailPacket.playerSegmentIndexOffset, segmentIndex, true);
            view.setUint16(offset + gameTailPacket.playerEndXOffset, coordToUint16(end[0], -this.aspectRatio, this.aspectRatio), true);
            view.setUint16(offset + gameTailPacket.playerEndYOffset, coordToUint16(end[1], -1.0, 1.0), true);
            offset += gameTailPacket.playerBytes;
        }

        if (reliable) {
            receiver.socket.emit("game_tail", buffer);
        } else {
            receiver.socket.volatile.emit("game_tail", buffer);
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

    private gameLoop() {
        if (this.roundStartTime !== null && Date.now() >= this.roundStartTime) {
            this.beginPlaying();
        }

        if (!this.playing) {
            return;
        }

        for (let i = 0; i < this.subTickRate; i++) {
            const alive = this.processSubTick();
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
            this.sendGameTail(receiver, reliableSources.length > 0);
        }
        for (const player of reliableSources) {
            player.pendingReliableState = false;
        }
    }
}
