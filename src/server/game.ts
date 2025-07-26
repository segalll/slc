import { Server, Socket } from "socket.io";
import { 
    directionToVector, 
    Direction, 
    DirectionInput, 
    Point, 
    Segment, 
    GameState, 
    PlayerState, 
    oppositeDirection, 
    PlayerInfo,
    GAME_CONSTANTS,
    isValidDirectionChange
} from "../shared/model";

interface Player {
    id: string;
    name: string;
    color: [number, number, number];
    score: number;

    startingDirection: Direction | null;
    direction: Direction;
    pendingDirectionInputs: DirectionInput[];
    segments: Segment[];
    fieldPartitions: Set<number>[]; // each partition is a set of indices into segments
    dead: boolean;

    socket: Socket;
    lastSentSegmentIndices: Map<string, number>; // per player
    pendingRedraw: boolean;
}

interface BoundingBox {
    min: Point;
    max: Point;
}

interface CollisionResult {
    collisionStart: Point | null;
    collisionEnd: Point | null;
}

const colorFromHex = (hex: string): [number, number, number] => {
    const r = parseInt(hex.slice(1, 3), 16) / 255.0;
    const g = parseInt(hex.slice(3, 5), 16) / 255.0;
    const b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
};

const createPoint = (x: number, y: number): Point => [x, y];

const createSegment = (start: Point, end: Point): Segment => [start, end];

const clonePoint = (point: Point): Point => [point[0], point[1]];

export class Game {
    private readonly server: Server;
    private readonly players: Map<string, Player>;
    private readonly partitionSizeX: number;
    private readonly partitionSizeY: number;

    private playing: boolean = false;
    private prevAlive: string[] = [];
    private lastTickEndTimestamp: number;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        this.lastTickEndTimestamp = Date.now();
        
        this.partitionSizeX = 2 * GAME_CONSTANTS.DEFAULT_ASPECT_RATIO / GAME_CONSTANTS.NUM_PARTITIONS;
        this.partitionSizeY = 2.0 / GAME_CONSTANTS.NUM_PARTITIONS;
        
        setInterval(() => this.gameLoop(), 1000 / GAME_CONSTANTS.TICK_RATE);
    }

    private worldToPartition(worldPos: Point): number {
        const x = (worldPos[0] + GAME_CONSTANTS.DEFAULT_ASPECT_RATIO) / this.partitionSizeX;
        const y = (worldPos[1] + 1.0) / this.partitionSizeY;
        return Math.floor(y) * GAME_CONSTANTS.NUM_PARTITIONS + Math.floor(x);
    }

    private segmentToPartitions(segment: Segment): number[] {
        const partitions = new Set<number>();
        const width = GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
        
        const x1 = (segment[0][0] + GAME_CONSTANTS.DEFAULT_ASPECT_RATIO) / this.partitionSizeX;
        const y1 = (segment[0][1] + 1.0) / this.partitionSizeY;
        const x2 = (segment[1][0] + GAME_CONSTANTS.DEFAULT_ASPECT_RATIO) / this.partitionSizeX;
        const y2 = (segment[1][1] + 1.0) / this.partitionSizeY;
        
        const isVertical = Math.abs(x1 - x2) < 0.001;
        const isHorizontal = Math.abs(y1 - y2) < 0.001;
        
        if (isVertical) {
            const widthPartitions = Math.ceil(width / this.partitionSizeX);
            const minY = Math.floor(Math.min(y1, y2));
            const maxY = Math.floor(Math.max(y1, y2));
            const x = Math.floor(x1);
            
            for (let y = minY; y <= maxY; y++) {
                for (let dx = -widthPartitions; dx <= widthPartitions; dx++) {
                    const partitionX = x + dx;
                    if (partitionX >= 0 && partitionX < GAME_CONSTANTS.NUM_PARTITIONS && y >= 0 && y < GAME_CONSTANTS.NUM_PARTITIONS) {
                        partitions.add(y * GAME_CONSTANTS.NUM_PARTITIONS + partitionX);
                    }
                }
            }
        } else if (isHorizontal) {
            const widthPartitions = Math.ceil(width / this.partitionSizeY);
            const minX = Math.floor(Math.min(x1, x2));
            const maxX = Math.floor(Math.max(x1, x2));
            const y = Math.floor(y1);
            
            for (let x = minX; x <= maxX; x++) {
                for (let dy = -widthPartitions; dy <= widthPartitions; dy++) {
                    const partitionY = y + dy;
                    if (x >= 0 && x < GAME_CONSTANTS.NUM_PARTITIONS && partitionY >= 0 && partitionY < GAME_CONSTANTS.NUM_PARTITIONS) {
                        partitions.add(partitionY * GAME_CONSTANTS.NUM_PARTITIONS + x);
                    }
                }
            }
        }
        
        return Array.from(partitions);
    }

    private getSegmentBoundingBox(segment: Segment, lineWidth: number): BoundingBox {
        const isVertical = Math.abs(segment[0][0] - segment[1][0]) < 0.001;
        
        const minX = Math.min(segment[0][0], segment[1][0]) - (isVertical ? lineWidth : 0);
        const maxX = Math.max(segment[0][0], segment[1][0]) + (isVertical ? lineWidth : 0);
        const minY = Math.min(segment[0][1], segment[1][1]) - (isVertical ? 0 : lineWidth);
        const maxY = Math.max(segment[0][1], segment[1][1]) + (isVertical ? 0 : lineWidth);
        
        return {
            min: createPoint(minX, minY),
            max: createPoint(maxX, maxY)
        };
    }

    private boundingBoxesOverlap(box1: BoundingBox, box2: BoundingBox): boolean {
        return box1.min[0] <= box2.max[0] &&
               box1.max[0] >= box2.min[0] &&
               box1.min[1] <= box2.max[1] &&
               box1.max[1] >= box2.min[1];
    }

    private lineToLineCollision(line1: Segment, line2: Segment): CollisionResult {
        const lineWidth = GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
        const box1 = this.getSegmentBoundingBox(line1, lineWidth);
        const box2 = this.getSegmentBoundingBox(line2, lineWidth);

        if (!this.boundingBoxesOverlap(box1, box2)) {
            return { collisionStart: null, collisionEnd: null };
        }

        const isLine1Vertical = Math.abs(line1[0][0] - line1[1][0]) < 0.001;
        const isLine2Vertical = Math.abs(line2[0][0] - line2[1][0]) < 0.001;

        let collisionStart: Point;
        let collisionEnd: Point;

        if (isLine1Vertical) {
            collisionStart = createPoint(
                line1[1][0],
                line1[0][1] < line1[1][1] ? box2.min[1] : box2.max[1]
            );
            collisionEnd = createPoint(
                line1[1][0],
                line1[0][1] < line1[1][1] ? box2.max[1] : box2.min[1]
            );
        } else {
            collisionStart = createPoint(
                line1[0][0] < line1[1][0] ? box2.min[0] : box2.max[0],
                line1[1][1]
            );
            collisionEnd = createPoint(
                line1[0][0] < line1[1][0] ? box2.max[0] : box2.min[0],
                line1[1][1]
            );
        }

        return { collisionStart, collisionEnd };
    }

    private isOutOfBounds(point: Point): boolean {
        return point[0] < -GAME_CONSTANTS.DEFAULT_ASPECT_RATIO || 
               point[0] > GAME_CONSTANTS.DEFAULT_ASPECT_RATIO || 
               point[1] < -1.0 || 
               point[1] > 1.0;
    }

    private generateSpawnPoint(): Point {
        const margin = GAME_CONSTANTS.MIN_SPAWN_DISTANCE_FROM_EDGE;
        const maxX = GAME_CONSTANTS.DEFAULT_ASPECT_RATIO - margin;
        const maxY = 1.0 - margin;
        
        const x = (Math.random() * 2 * maxX) - maxX;
        const y = (Math.random() * 2 * maxY) - maxY;
        
        return createPoint(x, y);
    }

    private initializePlayerSegments(player: Player): void {
        const startPoint = this.generateSpawnPoint();
        const direction = Math.floor(Math.random() * 4) as Direction;
        const directionVector = directionToVector(direction);
        
        const endPoint = createPoint(
            startPoint[0] + directionVector[0] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH,
            startPoint[1] + directionVector[1] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH
        );
        
        const segment = createSegment(startPoint, endPoint);
        player.segments = [segment];
        player.direction = direction;
        
        this.updatePlayerPartitions(player, [segment]);
    }

    private updatePlayerPartitions(player: Player, segments: Segment[]): void {
        for (const segment of segments) {
            const partitions = this.segmentToPartitions(segment);
            const segmentIndex = player.segments.length - segments.length + segments.indexOf(segment);
            
            for (const partition of partitions) {
                player.fieldPartitions[partition].add(segmentIndex);
            }
        }
    }

    private initializePlayerPartitions(player: Player): void {
        player.fieldPartitions = new Array(GAME_CONSTANTS.NUM_PARTITIONS * GAME_CONSTANTS.NUM_PARTITIONS);
        for (let i = 0; i < player.fieldPartitions.length; i++) {
            player.fieldPartitions[i] = new Set<number>();
        }
    }

    startRound(): void {
        if (this.playing || this.players.size < 2) {
            return;
        }

        for (const player of this.players.values()) {
            this.initializePlayerPartitions(player);
            this.initializePlayerSegments(player);
            player.pendingDirectionInputs = [];
            player.dead = false;

            for (const id of this.players.keys()) {
                player.lastSentSegmentIndices.set(id, 0);
            }
        }

        this.server.emit("starting");

        this.prevAlive = Array.from(this.players.keys());
        setTimeout(() => {
            for (const player of this.players.values()) {
                if (player.startingDirection !== null) {
                    player.direction = player.startingDirection;
                    const directionVector = directionToVector(player.direction);
                    const startPoint = player.segments[0][0];
                    const endPoint = createPoint(
                        startPoint[0] + directionVector[0] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH,
                        startPoint[1] + directionVector[1] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH
                    );
                    player.segments = [createSegment(startPoint, endPoint)];
                    this.updatePlayerPartitions(player, player.segments);
                }
            }
            this.lastTickEndTimestamp = Date.now();
            this.playing = true;
        }, GAME_CONSTANTS.ROUND_START_DELAY);
    }

    addPlayer(socket: Socket, id: string, name: string, color: string): void {
        if (!this.players.has(id)) {
            const colorVector = colorFromHex(color);
            const score = 0;

            socket.broadcast.emit("modify_player", {
                id,
                name,
                color: colorVector,
                score
            } as PlayerInfo);

            const newPlayer: Player = {
                id,
                name,
                color: colorVector,
                score,
                startingDirection: null,
                direction: Direction.Up,
                pendingDirectionInputs: [],
                segments: [],
                fieldPartitions: new Array(GAME_CONSTANTS.NUM_PARTITIONS * GAME_CONSTANTS.NUM_PARTITIONS).fill(null).map(() => new Set<number>()),
                dead: true,
                socket,
                lastSentSegmentIndices: new Map<string, number>(),
                pendingRedraw: false
            };

            this.players.set(id, newPlayer);
        } else {
            this.players.get(id)!.socket = socket;
            this.redraw(id);
        }

        for (const player of this.players.values()) {
            socket.emit("modify_player", {
                id: player.id,
                name: player.name,
                color: player.color,
                score: player.score
            } as PlayerInfo);
            socket.emit("game_state", {
                players: [{
                    id: player.id,
                    missingSegments: player.segments
                } as PlayerState]
            } as GameState);
            this.players.get(id)!.lastSentSegmentIndices.set(player.id, player.segments.length - 1);
        }
    }

    removePlayer(id: string): void {
        if (!this.players.has(id)) {
            return;
        }
        this.players.delete(id);
        this.server.emit("remove", id);
    }

    processInput(id: string, direction: Direction): void {
        const player = this.players.get(id);
        if (!player) return;

        if (!this.playing) {
            player.startingDirection = direction;
            return;
        }
        if (player.dead) return;

        player.pendingDirectionInputs.push({
            direction,
            receivedTimestamp: Date.now()
        });
    }

    redraw(id: string): void {
        const player = this.players.get(id);
        if (!player) return;
        
        for (const playerId of this.players.keys()) {
            player.lastSentSegmentIndices.set(playerId, 0);
        }
        player.pendingRedraw = true;
    }

    private addSegment(player: Player, direction: Direction): void {
        if (player.dead || !isValidDirectionChange(player.direction, direction)) {
            return;
        }

        const lastSegment = player.segments[player.segments.length - 1];
        const oldDirection = directionToVector(player.direction);
        const newPoint = clonePoint(lastSegment[1]);

        switch (direction) {
            case Direction.Left:
                newPoint[0] -= GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                newPoint[1] -= oldDirection[1] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                break;
            case Direction.Right:
                newPoint[0] += GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                newPoint[1] -= oldDirection[1] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                break;
            case Direction.Up:
                newPoint[1] += GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                newPoint[0] -= oldDirection[0] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                break;
            case Direction.Down:
                newPoint[1] -= GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                newPoint[0] -= oldDirection[0] * GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
                break;
        }

        player.direction = direction;
        const newSegment = createSegment(newPoint, clonePoint(newPoint));
        player.segments.push(newSegment);
    }

    private extendLastSegment(player: Player, duration: number): void {
        if (player.dead) return;

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        const spatialLength = duration * GAME_CONSTANTS.MOVE_SPEED / 1000;
        const oldSegmentEnd = clonePoint(lastSegment[1]);
        
        lastSegment[1][0] += direction[0] * spatialLength;
        lastSegment[1][1] += direction[1] * spatialLength;

        if (this.isOutOfBounds(lastSegment[1])) {
            player.dead = true;
            return;
        }

        const newSegment = createSegment(oldSegmentEnd, lastSegment[1]);
        const newPartitions = this.segmentToPartitions(newSegment);
        
        for (const partition of newPartitions) {
            player.fieldPartitions[partition].add(player.segments.length - 1);
            
            for (const otherPlayer of this.players.values()) {
                for (const segmentIndex of otherPlayer.fieldPartitions[partition]) {
                    if (player.id === otherPlayer.id && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                                         const collision = this.lineToLineCollision(newSegment, otherPlayer.segments[segmentIndex]);
                     if (collision.collisionStart && collision.collisionEnd) {
                         player.dead = true;
                         lastSegment[1] = collision.collisionStart;
                         return;
                     }
                }
            }
        }
    }

    private sendGameState(player: Player): void {
        const playerState = Array.from(this.players.values()).map(otherPlayer => {
            const lastSentSegmentIndex = player.lastSentSegmentIndices.get(otherPlayer.id)!;
            const missingSegments = otherPlayer.segments.slice(lastSentSegmentIndex);
            
            if (lastSentSegmentIndex < otherPlayer.segments.length - 1) {
                player.lastSentSegmentIndices.set(otherPlayer.id, otherPlayer.segments.length - 1);
            }
            
            return {
                id: otherPlayer.id,
                missingSegments
            } as PlayerState;
        });

        player.socket.emit("game_state", { players: playerState } as GameState);
    }

    private processSubTick(subTickIndex: number): string[] {
        const alive: string[] = [];
        
        for (const player of this.players.values()) {
            if (player.dead) continue;
            
            alive.push(player.id);
            const beginCutoff = this.lastTickEndTimestamp + subTickIndex * (1000 / (GAME_CONSTANTS.TICK_RATE * GAME_CONSTANTS.SUB_TICK_RATE));
            const endCutoff = beginCutoff + (1000 / (GAME_CONSTANTS.TICK_RATE * GAME_CONSTANTS.SUB_TICK_RATE));
            
            const validInputIndex = player.pendingDirectionInputs.findIndex(input =>
                input.receivedTimestamp >= beginCutoff &&
                input.receivedTimestamp < endCutoff &&
                input.direction !== oppositeDirection(player.direction) &&
                input.direction !== player.direction
            );
            
            if (validInputIndex !== -1) {
                this.addSegment(player, player.pendingDirectionInputs[validInputIndex].direction);
                player.pendingDirectionInputs = player.pendingDirectionInputs.slice(validInputIndex + 1);
            }
            
            this.extendLastSegment(player, 1000 / (GAME_CONSTANTS.TICK_RATE * GAME_CONSTANTS.SUB_TICK_RATE));
        }
        
        return alive;
    }

    private handleRoundEnd(winners: string[]): void {
        for (const id of winners) {
            const player = this.players.get(id)!;
            player.score++;
            this.server.emit("round_over");
            this.server.emit("modify_player", {
                id,
                name: player.name,
                color: player.color,
                score: player.score
            } as PlayerInfo);
        }
    }

    gameLoop(): void {
        if (!this.playing) {
            for (const player of this.players.values()) {
                if (player.pendingRedraw) {
                    player.pendingRedraw = false;
                    this.sendGameState(player);
                }
            }
            return;
        }

        for (let i = 0; i < GAME_CONSTANTS.SUB_TICK_RATE; i++) {
            const alive = this.processSubTick(i);
            if (alive.length <= 1) {
                this.playing = false;
                const winners = alive.length === 1 ? alive : this.prevAlive;
                this.handleRoundEnd(winners);
                this.prevAlive = alive;
                break;
            }
            this.prevAlive = alive;
        }

        for (const player of this.players.values()) {
            player.pendingRedraw = false;
            player.startingDirection = null;
            this.sendGameState(player);
        }

        this.lastTickEndTimestamp = Date.now();
    }
}