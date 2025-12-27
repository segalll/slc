import { Server, Socket } from "socket.io";
import { directionToVector, Direction, Point, Segment, PlayerInfo } from "../shared/model";

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
    pendingRedraw: boolean;
}

const colorFromHex = (hex: string): [number, number, number] => {
    const r = parseInt(hex.slice(1, 3), 16) / 255.0;
    const g = parseInt(hex.slice(3, 5), 16) / 255.0;
    const b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [ r, g, b ];
}

export class Game {
    server: Server;
    players: Map<string, Player>;

    numPartitions: number = 10; // number of partitions per axis
    moveSpeed: number = 0.3;
    tickRate: number = 30;
    subTickRate: number = 2;
    aspectRatio: number = 1.5;
    lineWidth: number = 0.002;
    minSpawnDistanceFromEdge: number = 0.1;

    playing: boolean = false;
    prevAlive: string[] = []; // list of ids of players that were alive last tick
    nextPlayerIndex: number = 0;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    private segmentToPartitions(segment: Segment): number[] {
        const partitionSizeX = 2 * this.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x1 = (segment[0][0] + this.aspectRatio) / partitionSizeX;
        const y1 = (segment[0][1] + 1.0) / partitionSizeY;
        const x2 = (segment[1][0] + this.aspectRatio) / partitionSizeX;
        const y2 = (segment[1][1] + 1.0) / partitionSizeY;
        const partitions: number[] = [];
        if (x1 === x2) {
            const width = this.lineWidth / partitionSizeX;
            for (let y = Math.floor(Math.min(y1, y2)); y <= Math.floor(Math.max(y1, y2)); y++) {
                for (let x = Math.floor(Math.min(x1, x2) - width); x <= Math.floor(Math.max(x1, x2) + width); x++) {
                    partitions.push(y * this.numPartitions + x);
                }
            }
        } else if (y1 === y2) {
            const width = this.lineWidth / partitionSizeY;
            for (let x = Math.floor(Math.min(x1, x2)); x <= Math.floor(Math.max(x1, x2)); x++) {
                for (let y = Math.floor(Math.min(y1, y2) - width); y <= Math.floor(Math.max(y1, y2) + width); y++) {
                    partitions.push(y * this.numPartitions + x);
                }
            }
        }
        return partitions;
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
            const collisionStart: Point = [
                line1Vertical ? line1[1][0] : (line1[0][0] < line1[1][0] ? line2BoundingBox[0][0] : line2BoundingBox[1][0]),
                line1Vertical ? (line1[0][1] < line1[1][1] ? line2BoundingBox[0][1] : line2BoundingBox[1][1]) : line1[1][1]
            ];
            const collisionEnd: Point = [
                line1Vertical ? line1[1][0] : (line1[0][0] < line1[1][0] ? line2BoundingBox[1][0] : line2BoundingBox[0][0]),
                line1Vertical ? (line1[0][1] < line1[1][1] ? line2BoundingBox[1][1] : line2BoundingBox[0][1]) : line1[1][1]
            ];
            return [collisionStart, collisionEnd];
        } else {
            return [null, null];
        }
    }

    startRound() {
        if (this.playing || this.players.size < 2) {
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
                    const endPoint: Point = [ startPoint[0] + directionVector[0] * this.lineWidth, startPoint[1] + directionVector[1] * this.lineWidth ];
                    player.segments = [[ startPoint, endPoint ] as Segment];
                }
            }
            this.playing = true;
        }, 3000);
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
                pendingRedraw: false
            });
        } else {
            this.players.get(id)!.socket = socket;
            this.redraw(id);
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

        this.addSegment(player, direction);
    }

    redraw(id: string) {
        if (!this.players.has(id)) {
            return;
        }
        const player = this.players.get(id)!;
        for (const playerId of this.players.keys()) {
            player.lastSentSegmentIndices.set(playerId, 0);
        }
        player.pendingRedraw = true;
    }

    private addSegment(player: Player, direction: Direction) {
        if (player.dead) {
            return;
        }

        const lastDirection = directionToVector(player.direction);
        if ((direction === Direction.Right && lastDirection[1] === 0.0) ||
            (direction === Direction.Up && lastDirection[0] === 0.0) ||
            (direction === Direction.Down && lastDirection[0] === 0.0) ||
            (direction === Direction.Left && lastDirection[1] === 0.0)) {
            return;
        }

        player.direction = direction;

        const newPoint: Point = structuredClone(player.segments[player.segments.length - 1][1]);
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
        player.segments.push([ newPoint, structuredClone(newPoint) ] as Segment);
    }

    private extendLastSegment(player: Player, duration: number) {
        if (player.dead) {
            return;
        }

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        const spatialLength = duration * this.moveSpeed / 1000;
        const oldSegmentEnd = structuredClone(lastSegment[1]);
        lastSegment[1][0] += direction[0] * spatialLength;
        lastSegment[1][1] += direction[1] * spatialLength;

        if (lastSegment[1][0] < -this.aspectRatio || lastSegment[1][0] > this.aspectRatio || lastSegment[1][1] < -1.0 || lastSegment[1][1] > 1.0) {
            player.dead = true;
            return;
        }

        const newPartitions = this.segmentToPartitions([ oldSegmentEnd, lastSegment[1] ]);
        for (const partition of newPartitions) {
            player.fieldPartitions[partition].add(player.segments.length - 1);
            for (const player2 of this.players.values()) {
                for (const segmentIndex of player2.fieldPartitions[partition]) {
                    // disallow collisions with our turn immediately after segment
                    if (player.id === player2.id && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                    const consideredSegment = [ oldSegmentEnd, lastSegment[1] ] as Segment;
                    const [collisionStart, collisionEnd] = this.lineToLineCollision(consideredSegment, player2.segments[segmentIndex]);
                    if (collisionStart && collisionEnd) {
                        player.dead = true;
                        lastSegment[1] = collisionStart;
                        break;
                    }
                }
            }
        }
    }

    private sendGameState(receiver: Player, sources?: Player[]) {
        const playerData: { index: number; segments: Segment[] }[] = [];
        let totalSegments = 0;

        for (const source of (sources ?? this.players.values())) {
            const lastSentIndex = receiver.lastSentSegmentIndices.get(source.id) ?? 0;
            const segments = source.segments.slice(lastSentIndex);
            if (segments.length > 0) {
                playerData.push({ index: source.index, segments });
                totalSegments += segments.length;
                receiver.lastSentSegmentIndices.set(source.id, source.segments.length - 1);
            }
        }

        if (playerData.length === 0) return;

        const headerSize = 1 + playerData.length * 3;
        const buffer = new ArrayBuffer(headerSize + totalSegments * 16);
        const view = new DataView(buffer);

        view.setUint8(0, playerData.length);

        let offset = 1;
        let floatOffset = headerSize;

        for (const { index, segments } of playerData) {
            view.setUint8(offset, index);
            view.setUint16(offset + 1, segments.length, true);
            offset += 3;

            for (let i = 0; i < segments.length; i++) {
                view.setFloat32(floatOffset, segments[i][0][0], true);
                view.setFloat32(floatOffset + 4, segments[i][0][1], true);
                view.setFloat32(floatOffset + 8, segments[i][1][0], true);
                view.setFloat32(floatOffset + 12, segments[i][1][1], true);
                floatOffset += 16;
            }
        }

        receiver.socket.volatile.emit("game_state", buffer);
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

    gameLoop() {
        if (!this.playing) {
            for (const player of this.players.values()) {
                if (player.pendingRedraw) {
                    player.pendingRedraw = false;
                    this.sendGameState(player);
                }
            }
            return;
        }

        for (let i = 0; i < this.subTickRate; i++) {
            const alive = this.processSubTick();
            if (alive.length <= 1) {
                this.playing = false;

                const winners = alive.length === 1 ? alive : this.prevAlive;
                for (const id of winners) {
                    const player = this.players.get(id)!;
                    player.score++;
                    this.server.emit("round_over");
                    this.server.emit("modify_player", {
                        id,
                        index: player.index,
                        name: player.name,
                        color: player.color,
                        score: player.score
                    } as PlayerInfo);
                }
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
    }
}