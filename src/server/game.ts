import { Server, Socket } from "socket.io";
import { directionToVector, Direction, DirectionInput, Point, Segment, GameSettings, GameState, PlayerState, oppositeDirection, PlayerInfo } from "../shared/model";

interface RecentlyAddedSegment {
    startPoint: Point;
    index: number;
    duration: number;
    startTime: number;
}

interface Player {
    id: string;
    name: string;
    color: [number, number, number];
    score: number;

    direction: Direction;
    pendingDirectionInputs: DirectionInput[];
    segments: Segment[];
    fieldPartitions: Set<number>[]; // each partition is a set of indices into segments
    dead: boolean;
    deathTime: number;
    recentlyAddedSegments: RecentlyAddedSegment[];

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

const linterpTimeFromSegment = (segment: Segment, x: Point, duration: number, startTime: number): number => {
    const [[x1, y1], [x2, y2]] = segment;

    let t: number;
    if (x2 === x1) { // vertical line
        t = (x[1] - y1) / (y2 - y1);
    } else { // horizontal line
        t = (x[0] - x1) / (x2 - x1);
    }

    return startTime + (t * duration);
}

const linterpSegmentFromTime = (segment: Segment, t: number, duration: number): Point => {
    const [[x1, y1], [x2, y2]] = segment;
    return [
        x1 + (x2 - x1) * t / duration,
        y1 + (y2 - y1) * t / duration
    ];
}

export class Game {
    server: Server;
    players: Map<string, Player>;
    settings: GameSettings;
    numPartitions: number = 10; // number of partitions per axis
    moveSpeed: number = 0.3;
    tickRate: number = 4;
    minSpawnDistanceFromEdge: number = 0.1;
    playing: boolean = false;
    prevAlive: string[] = []; // list of ids of players that were alive last tick
    lastTickEndTimestamp: number;
    currentTickTimestamp: number = 0;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        this.settings = {
            aspectRatio: 1.5,
            lineWidth: 0.01
        };
        this.lastTickEndTimestamp = Date.now();
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    private adjustDeathTimeForHeadOn(segment1: Segment, segment2: Segment, deathTime: number): number {
        const [[x11, y11], [x12, y12]] = segment1;
        const [[x21, y21], [x22, y22]] = segment2;

        const overlapPosition = (x11 === x12) ? (y12 + y22) / 2 : (x12 + x22) / 2;
        const overlapDelta = (x11 === x12) ? Math.abs(y22 - overlapPosition) : Math.abs(x22 - overlapPosition);
        return deathTime + (1000 * overlapDelta / this.moveSpeed);
    }

    private pointToPartition(point: Point): number {
        const partitionSizeX = 2 * this.settings.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x = Math.floor((point[0] + this.settings.aspectRatio) / partitionSizeX);
        const y = Math.floor((point[1] + 1.0) / partitionSizeY);
        return y * this.numPartitions + x;
    }

    private segmentToPartitions(segment: Segment): number[] {
        const partitionSizeX = 2 * this.settings.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x1 = (segment[0][0] + this.settings.aspectRatio) / partitionSizeX;
        const y1 = (segment[0][1] + 1.0) / partitionSizeY;
        const x2 = (segment[1][0] + this.settings.aspectRatio) / partitionSizeX;
        const y2 = (segment[1][1] + 1.0) / partitionSizeY;
        const partitions: number[] = [];
        if (x1 === x2) {
            const width = this.settings.lineWidth / partitionSizeX;
            for (let y = Math.floor(Math.min(y1, y2)); y <= Math.floor(Math.max(y1, y2)); y++) {
                for (let x = Math.floor(Math.min(x1, x2) - width); x <= Math.floor(Math.max(x1, x2) + width); x++) {
                    partitions.push(y * this.numPartitions + x);
                }
            }
        } else if (y1 === y2) {
            const width = this.settings.lineWidth / partitionSizeY;
            for (let x = Math.floor(Math.min(x1, x2)); x <= Math.floor(Math.max(x1, x2)); x++) {
                for (let y = Math.floor(Math.min(y1, y2) - width); y <= Math.floor(Math.max(y1, y2) + width); y++) {
                    partitions.push(y * this.numPartitions + x);
                }
            }
        }
        return partitions;
    }

    private lineToLineCollision(line1: Segment, line2: Segment): [Point | null, Point | null] {
        const lineWidth = this.settings.lineWidth;

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
            const startX = Math.random() * 2 * (this.settings.aspectRatio - this.minSpawnDistanceFromEdge) - this.settings.aspectRatio + this.minSpawnDistanceFromEdge;
            const startY = Math.random() * 2 * (1.0 - this.minSpawnDistanceFromEdge) - 1.0 + this.minSpawnDistanceFromEdge;
            const startPoint: Point = [ startX, startY ];
            const startPointPartition = this.pointToPartition(startPoint);

            player.segments = [[ startPoint, structuredClone(startPoint) ] as Segment];
            player.fieldPartitions = new Array<Set<number>>(this.numPartitions * this.numPartitions);
            for (let i = 0; i < player.fieldPartitions.length; i++) {
                player.fieldPartitions[i] = new Set<number>();
            }
            player.fieldPartitions[startPointPartition].add(0);

            player.pendingDirectionInputs = [];
            player.direction = Math.floor(Math.random() * 4);
            player.dead = false;
            player.deathTime = Number.MAX_VALUE;

            for (const id of this.players.keys()) {
                player.lastSentSegmentIndices.set(id, 0);
            }
        }
        this.server.emit("starting");

        this.prevAlive = Array.from(this.players.keys());
        this.playing = true;
    }

    addPlayer(socket: Socket, id: string, name: string, color: string) {
        if (!this.players.has(id)) {
            const colorVector = colorFromHex(color);
            const score = 0;

            // introduce new player to existing players
            socket.broadcast.emit("modify_player", {
                id,
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
                name,
                color: colorVector,
                score,

                direction: Direction.Up, // doesn't matter, will be overwritten
                pendingDirectionInputs: [],
                segments: [],
                fieldPartitions,
                dead: true,
                deathTime: 0,
                recentlyAddedSegments: [],

                socket,
                lastSentSegmentIndices: new Map<string, number>(),
                pendingRedraw: false
            });
        } else {
            this.players.get(id)!.socket = socket;
            this.redraw(id);
        }

        // introduce existing players (including self) to player
        for (const player of this.players.values()) {
            socket.emit("modify_player", {
                id: player.id,
                name: player.name,
                color: player.color,
                score: player.score
            } as PlayerInfo);
            socket.emit("game_state", {
                players: [
                    {
                        id: player.id,
                        missingSegments: player.segments
                    } as PlayerState
                ],
                timestamp: Date.now()
            } as GameState);
            this.players.get(id)!.lastSentSegmentIndices.set(player.id, player.segments.length - 1);
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
        if (!this.players.has(id) || !this.playing) {
            return;
        }

        const player = this.players.get(id)!;
        if (player.dead) {
            return;
        }

        if (player.pendingDirectionInputs.length > 0) {
            const lastInput = player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1];
            if (direction === lastInput.direction || direction === oppositeDirection(lastInput.direction)) {
                return;
            }
        } else {
            if (direction === player.direction || direction === oppositeDirection(player.direction)) {
                return;
            }
        }
        player.pendingDirectionInputs.push({
            direction,
            receivedTimestamp: Date.now()
        });
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

    private checkNewSegmentCollision(player: Player, index: number, oldEndPoint: Point, duration: number, startTime: number) {
        const newPoint = player.segments[index][1];
        const checkedSegment = [ oldEndPoint, newPoint ] as Segment;

        if (newPoint[0] < -this.settings.aspectRatio || newPoint[0] > this.settings.aspectRatio || newPoint[1] < -1.0 || newPoint[1] > 1.0) {
            // technically don't have to adjust point since it's not in the canvas anyways
            player.dead = true;

            const deathPoint = [
                Math.min(Math.max(newPoint[0], -this.settings.aspectRatio), this.settings.aspectRatio),
                Math.min(Math.max(newPoint[1], -1.0), 1.0)
            ] as Point;
            player.deathTime = linterpTimeFromSegment(checkedSegment, deathPoint, duration, startTime);
            return;
        }

        const traversedPartitions = this.segmentToPartitions([ oldEndPoint, newPoint ]);
        for (const partition of traversedPartitions) {
            if (partition < 0 || partition >= player.fieldPartitions.length) {
                continue;
            }
            for (const player2 of this.players.values()) {
                for (const segmentIndex of player2.fieldPartitions[partition]) {
                    if (player.id === player2.id && Math.abs(index - segmentIndex) < 2) {
                        continue;
                    }

                    let consideredSegment = structuredClone(player2.segments[segmentIndex]);
                    let recentlyAddedSegment: RecentlyAddedSegment | null = null;
                    if (segmentIndex >= player2.segments.length - player2.recentlyAddedSegments.length) {
                        const recentlyAddedIndex = segmentIndex - (player2.segments.length - player2.recentlyAddedSegments.length);
                        recentlyAddedSegment = player2.recentlyAddedSegments[recentlyAddedIndex];
                        if (recentlyAddedSegment.startTime > startTime + duration) {
                            continue;
                        } else if (recentlyAddedSegment.startTime + recentlyAddedSegment.duration >= startTime) {
                            const timeElapsed = startTime + duration - recentlyAddedSegment.startTime;
                            consideredSegment[1] = linterpSegmentFromTime([ recentlyAddedSegment.startPoint, consideredSegment[1] ], timeElapsed, recentlyAddedSegment.duration);
                        }
                    }

                    const [collisionStart, collisionEnd] = this.lineToLineCollision(checkedSegment, consideredSegment);
                    if (collisionStart && collisionEnd) {
                        const deathTime = linterpTimeFromSegment(checkedSegment, collisionStart!, duration, startTime);
                        if (recentlyAddedSegment) {
                            const exitTime = linterpTimeFromSegment(checkedSegment, collisionEnd!, duration, startTime);
                            const consideredSegmentAtExit = linterpSegmentFromTime([recentlyAddedSegment.startPoint, consideredSegment[1]], exitTime - recentlyAddedSegment.startTime, startTime + duration - recentlyAddedSegment.startTime);
                            const [exitCollisionStart, exitCollisionEnd] = this.lineToLineCollision(checkedSegment, [consideredSegment[0], consideredSegmentAtExit]);
                            if (!exitCollisionStart && !exitCollisionEnd) {
                                continue;
                            }
                            const [otherCollisionStart, otherCollisionEnd] = this.lineToLineCollision(consideredSegment, checkedSegment);
                            if (otherCollisionStart && otherCollisionEnd) {
                                const otherDeathTime = linterpTimeFromSegment([recentlyAddedSegment.startPoint, consideredSegment[1]], otherCollisionStart, recentlyAddedSegment.duration, recentlyAddedSegment.startTime);
                                if (otherDeathTime > deathTime) {
                                    continue;
                                }
                            }
                        }
                        player.dead = true;
                        player.deathTime = Math.min(player.deathTime, deathTime);
                        if (player.id != player2.id && player.deathTime === player2.deathTime) {
                            const newDeathTime = this.adjustDeathTimeForHeadOn(checkedSegment, consideredSegment, player.deathTime);
                            player.deathTime = newDeathTime;
                            player2.deathTime = newDeathTime;
                            return;
                        }
                    }
                }
            }
        }
    }

    private checkNewCollisions(player: Player) {
        for (const newSegment of player.recentlyAddedSegments) {
            this.checkNewSegmentCollision(player, newSegment.index, newSegment.startPoint, newSegment.duration, newSegment.startTime);
        }
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
                newPoint[0] -= this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Right:
                newPoint[0] += this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Up:
                newPoint[1] += this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                break;
            case Direction.Down:
                newPoint[1] -= this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                break;
        }
        player.segments.push([ newPoint, structuredClone(newPoint) ] as Segment);
    }

    private extendLastSegment(player: Player, duration: number, startTime: number) {
        if (player.dead) {
            return;
        }

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        const spatialLength = duration * this.moveSpeed / 1000;
        const oldSegmentEnd = structuredClone(lastSegment[1]);
        lastSegment[1][0] += direction[0] * spatialLength;
        lastSegment[1][1] += direction[1] * spatialLength;

        const newPartitions = this.segmentToPartitions([ oldSegmentEnd, lastSegment[1] ]);
        for (const partition of newPartitions) {
            // necessary because we only check bounds of field when checking for collisions
            // and we are processing movement for the whole tick before checking collisions
            if (partition >= 0 && partition < player.fieldPartitions.length) {
                player.fieldPartitions[partition].add(player.segments.length - 1);
            }
        }

        player.recentlyAddedSegments.push({
            startPoint: oldSegmentEnd,
            index: player.segments.length - 1,
            duration,
            startTime
        });
    }

    private addSegmentWithDuration(player: Player, direction: Direction, duration: number, startTime: number) {
        this.addSegment(player, direction);
        this.extendLastSegment(player, duration, startTime);
    }

    private processPendingInputs(player: Player) {
        if (player.pendingDirectionInputs.length === 0) {
            return;
        }

        const deltaFromTickStartMs = player.pendingDirectionInputs[0].receivedTimestamp - this.lastTickEndTimestamp;
        this.extendLastSegment(player, deltaFromTickStartMs, this.lastTickEndTimestamp);

        let totalTime = deltaFromTickStartMs;
        for (let i = 0; i < player.pendingDirectionInputs.length - 1; i++) {
            const deltams = player.pendingDirectionInputs[i + 1].receivedTimestamp - player.pendingDirectionInputs[i].receivedTimestamp;
            this.addSegmentWithDuration(player, player.pendingDirectionInputs[i].direction, deltams, this.lastTickEndTimestamp + totalTime);
            totalTime += deltams;
        }
        const tickTime = 1000 / this.tickRate;
        const remainingTimeMs = tickTime - (player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1].receivedTimestamp - this.lastTickEndTimestamp);
        this.addSegmentWithDuration(player, player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1].direction, remainingTimeMs, this.lastTickEndTimestamp + totalTime);

        player.pendingDirectionInputs = [];
    }

    private sendGameState(player: Player) {
        for (const player2 of this.players.values()) {
            const lastSentSegmentIndex = player.lastSentSegmentIndices.get(player2.id)!;
            player.socket.emit("game_state", {
                players: [
                    {
                        id: player2.id,
                        missingSegments: player2.segments.slice(lastSentSegmentIndex),
                    } as PlayerState
                ],
                timestamp: this.currentTickTimestamp
            } as GameState);

            if (lastSentSegmentIndex < player2.segments.length - 1) {
                player.lastSentSegmentIndices.set(player2.id, player2.segments.length - 1);
            }
        }
    }

    private correctPlayerPosition(player: Player, deathTime: number) {
        // could use a kd-tree but linear search isn't too bad considering there won't be tons of inputs per tick
        for (const segment of player.recentlyAddedSegments) {
            if (deathTime >= segment.startTime && deathTime < segment.startTime + segment.duration) {
                const timeRemaining = deathTime - segment.startTime;
                const timeRatio = timeRemaining / segment.duration;
                let [x1, y1] = segment.startPoint;
                let [x2, y2] = player.segments[segment.index][1];

                const x = x1 + (x2 - x1) * timeRatio;
                const y = y1 + (y2 - y1) * timeRatio;
                player.segments[segment.index][1] = [ x, y ];
                player.segments = player.segments.slice(0, segment.index + 1);
                return;
            }
        }
    }

    gameLoop() {
        this.currentTickTimestamp = Date.now();

        if (!this.playing) {
            for (const player of this.players.values()) {
                if (player.pendingRedraw) {
                    player.pendingRedraw = false;
                    this.sendGameState(player);
                }
            }
            return;
        }

        const alive: string[] = [];
        for (const player of this.players.values()) {
            player.pendingRedraw = false;
            player.recentlyAddedSegments = [];

            if (!player.dead) {
                if (player.pendingDirectionInputs.length > 0) {
                    this.processPendingInputs(player);
                } else {
                    this.extendLastSegment(player, 1000 / this.tickRate, this.lastTickEndTimestamp);
                }
            }
        }

        for (const player of this.players.values()) {
            if (!player.dead) {
                this.checkNewCollisions(player);
                if (!player.dead) {
                    alive.push(player.id);
                }
            }
        }

        if (alive.length <= 1) {
            this.playing = false;

            const playersSortedByDeathTime = Array.from(this.players.values())
                .sort((a, b) => a.deathTime - b.deathTime);

            const endTime = playersSortedByDeathTime[this.players.size - 2].deathTime;

            for (const player of this.players.values()) {
                this.correctPlayerPosition(player, endTime);
            }

            const winners = playersSortedByDeathTime[this.players.size - 1].deathTime === endTime
                ? playersSortedByDeathTime.filter(player => player.deathTime === endTime).map(player => player.id)
                : [playersSortedByDeathTime[this.players.size - 1].id];                

            for (const id of winners) {
                const player = this.players.get(id)!;
                player.score++;
                this.server.emit("modify_player", {
                    id,
                    name: player.name,
                    color: player.color,
                    score: player.score
                } as PlayerInfo);
            }
        }

        for (const player of this.players.values()) {
            this.sendGameState(player);
        }

        this.prevAlive = alive;
        this.lastTickEndTimestamp = Date.now();
    }
}