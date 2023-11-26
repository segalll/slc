import { Server, Socket } from "socket.io";
import { directionToVector, Direction, DirectionInput, Point, Segment, GameSettings, GameState, PlayerState, oppositeDirection } from "../shared/model";

interface Player {
    id: string;
    name: string;
    color: [number, number, number];
    score: number;

    direction: Direction;
    pendingDirectionInputs: DirectionInput[];
    segments: Segment[];
    fieldPartitions: Set<number>[]; // each partition is a set of indices into segments
    currentPartition: number;
    dead: boolean;

    socket: Socket;
    lastSentSegmentIndices: Map<string, number>; // per player
    pendingDeletion: boolean; // used to determine if player has rejoined after disconnect
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
    settings: GameSettings;
    numPartitions: number = 10; // number of partitions per axis
    moveSpeed: number = 0.3;
    tickRate: number = 3;
    minSpawnDistanceFromEdge: number = 0.1;
    playing: boolean = false;
    prevAlive: string[] = []; // list of ids of players that were alive last tick
    lastTickEndTimestamp: number;

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        this.settings = {
            aspectRatio: 1.5,
            lineWidth: 0.002
        };
        this.lastTickEndTimestamp = Date.now();
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    private pointToPartition(point: Point): number {
        const partitionSizeX = 2 * this.settings.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x = Math.floor((point[0] + this.settings.aspectRatio) / partitionSizeX);
        const y = Math.floor((point[1] + 1.0) / partitionSizeY);
        return y * this.numPartitions + x;
    }

    private lineCrossesLine(line1: Segment, line2: Segment): [boolean, Point | null] {
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
            const fixedPoint: Point = [
                line1Vertical ? line1[1][0] : (line1[0][0] < line1[1][0] ? line2BoundingBox[0][0] : line2BoundingBox[1][0]),
                line1Vertical ? (line1[0][1] < line1[1][1] ? line2BoundingBox[0][1] : line2BoundingBox[1][1]) : line1[1][1]
            ];
            return [true, fixedPoint];
        } else {
            return [false, null];
        }
    }

    startRound() {
        if (this.players.size < 2) {
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
            player.currentPartition = startPointPartition;
            player.dead = false;

            for (const id of this.players.keys()) {
                player.lastSentSegmentIndices.set(id, 0);
            }
        }
        this.server.emit("starting");

        this.prevAlive = Array.from(this.players.keys());
        this.playing = true;
    }

    addPlayer(socket: Socket) {
        if (!this.players.has((socket as any).userID)) {
            const name = (socket as any).username;
            const color = colorFromHex((socket as any).color);
            const score = 0;

            // introduce new player to existing players
            socket.broadcast.emit("game_state", {
                playing: this.playing,
                players: [
                    {
                        id: (socket as any).userID,
                        name,
                        color,
                        score,
                        missingSegments: []
                    } as PlayerState
                ]
            } as GameState);

            const fieldPartitions = new Array<Set<number>>(this.numPartitions * this.numPartitions);
            for (let i = 0; i < fieldPartitions.length; i++) {
                fieldPartitions[i] = new Set<number>();
            }

            this.players.set((socket as any).userID, {
                id: (socket as any).userID,
                name,
                color,
                score,

                direction: Direction.Up, // doesn't matter, will be overwritten
                pendingDirectionInputs: [],
                segments: [],
                fieldPartitions,
                currentPartition: -1,
                dead: true,

                socket,
                lastSentSegmentIndices: new Map<string, number>(),
                pendingDeletion: false
            });
        } else {
            this.players.get((socket as any).userID)!.socket = socket;
            this.players.get((socket as any).userID)!.pendingDeletion = false;
            this.redraw((socket as any).userID);
        }

        // introduce existing players (including self) to player
        for (const [id, player] of this.players.entries()) {
            socket.emit("game_state", {
                playing: this.playing,
                players: [
                    {
                        id,
                        name: player.name,
                        color: player.color,
                        score: player.score,
                        missingSegments: player.segments
                    } as PlayerState
                ]
            } as GameState);
            this.players.get((socket as any).userID)!.lastSentSegmentIndices.set(id, player.segments.length - 1);
        }
    }

    removePlayer(id: string) {
        if (!this.players.has(id)) {
            return;
        }
        this.players.delete(id);
        this.server.emit("remove", id);
    }

    processInput(id: string, input: DirectionInput) {
        if (!this.players.has(id) || !this.playing) {
            return;
        }

        const player = this.players.get(id)!;
        if (player.dead) {
            return;
        }

        if (player.pendingDirectionInputs.length > 0) {
            const lastInput = player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1];
            if (input.direction === lastInput.direction || input.direction === oppositeDirection(lastInput.direction)) {
                return;
            }
        } else {
            if (input.direction === player.direction || input.direction === oppositeDirection(player.direction)) {
                return;
            }
        }
        player.pendingDirectionInputs.push({
            direction: input.direction,
            sentTimestamp: input.sentTimestamp,
            receivedTimestamp: Date.now()
        });
    }

    private checkNewSegmentCollision(player: Player, oldSegmentEnd: Point) {
        let newPoint = player.segments[player.segments.length - 1][1];

        if (newPoint[0] < -this.settings.aspectRatio || newPoint[0] > this.settings.aspectRatio || newPoint[1] < -1.0 || newPoint[1] > 1.0) {
            // technically don't have to adjust point since it's not in the canvas anyways
            player.dead = true;
            return;
        }

        const newPartition = this.pointToPartition(newPoint);
        const toCheck = [ newPartition ];
        if (newPartition !== player.currentPartition) {
            toCheck.push(player.currentPartition);
            player.currentPartition = newPartition;
        }
        for (const partition of toCheck) {
            for (const [id2, player2] of this.players.entries()) {
                for (const segmentIndex of player2.fieldPartitions[partition]) {
                    if (player.id === id2 && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                    const checkedSegment = [ oldSegmentEnd, newPoint ] as Segment;
                    const [crosses, fixedPoint] = this.lineCrossesLine(checkedSegment, player2.segments[segmentIndex]);
                    if (crosses) {
                        player.dead = true;
                        newPoint = fixedPoint!;
                        break;
                    }
                }
            }
        }
        for (const partition of toCheck) {
            player.fieldPartitions[partition].add(player.segments.length - 1);
        }

        player.segments[player.segments.length - 1][1] = newPoint;
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

    private extendLastSegment(player: Player, length: number) {
        if (player.dead) {
            return;
        }

        const lastSegment = player.segments[player.segments.length - 1];
        const direction = directionToVector(player.direction);
        lastSegment[1][0] += direction[0] * length;
        lastSegment[1][1] += direction[1] * length;
        this.checkNewSegmentCollision(player, lastSegment[0]);
    }

    private addSegmentWithLength(player: Player, direction: Direction, length: number) {
        this.addSegment(player, direction);
        this.extendLastSegment(player, length);
    }

    private processPendingInputs(player: Player) {
        if (player.pendingDirectionInputs.length === 0) {
            return;
        }

        const deltaFromTickStartMs = player.pendingDirectionInputs[0].receivedTimestamp - this.lastTickEndTimestamp;
        const deltaFromTickStart = (this.moveSpeed * deltaFromTickStartMs) / 1000;
        this.extendLastSegment(player, deltaFromTickStart);

        for (let i = 0; i < player.pendingDirectionInputs.length - 1; i++) {
            const deltams = player.pendingDirectionInputs[i + 1].sentTimestamp - player.pendingDirectionInputs[i].sentTimestamp;
            const delta = (this.moveSpeed * deltams) / 1000;
            this.addSegmentWithLength(player, player.pendingDirectionInputs[i].direction, delta);
        }
        const tickTime = (1000 / this.tickRate);
        const remainingTime = tickTime - (player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1].receivedTimestamp - this.lastTickEndTimestamp);
        const delta = (this.moveSpeed * remainingTime) / 1000;
        this.addSegmentWithLength(player, player.pendingDirectionInputs[player.pendingDirectionInputs.length - 1].direction, delta);

        player.pendingDirectionInputs = [];
    }

    redraw(userID: string) {
        if (!this.players.has(userID)) {
            return;
        }
        const lastSentSegmentIndices = this.players.get(userID)!.lastSentSegmentIndices;
        for (const id of this.players.keys()) {
            lastSentSegmentIndices.set(id, 0);
        }
    }

    gameLoop() {
        if (!this.playing) {
            return;
        }

        const alive = [];
        for (const player of this.players.values()) {
            if (!player.dead) {
                alive.push(player.id);
                if (player.pendingDirectionInputs.length > 0) {
                    this.processPendingInputs(player);
                } else {
                    this.extendLastSegment(player, this.moveSpeed / this.tickRate);
                }
            }

            for (const player2 of this.players.values()) {
                const lastSentSegmentIndex = player.lastSentSegmentIndices.get(player2.id)!;
                if (lastSentSegmentIndex < player2.segments.length - 1) {
                    player.lastSentSegmentIndices.set(player2.id, player2.segments.length - 1);
                }

                player.socket.emit("game_state", {
                    playing: true,
                    players: [
                        {
                            id: player2.id,
                            name: player2.name,
                            color: player2.color,
                            score: player2.score,
                            missingSegments: player2.segments.slice(lastSentSegmentIndex),
                        } as PlayerState
                    ]
                } as GameState);
            }
        }

        if (alive.length <= 1) {
            this.playing = false;
            if (alive.length === 1) {
                this.players.get(alive[0])!.score++;
            } else {
                for (const id of this.prevAlive) {
                    this.players.get(id)!.score++;
                }
            }

            for (const [id, player] of this.players.entries()) {
                this.server.emit("game_state", {
                    playing: false,
                    players: [
                        {
                            id,
                            name: player.name,
                            color: player.color,
                            score: player.score,
                            missingSegments: []
                        } as PlayerState
                    ]
                } as GameState);
            }
        }

        this.prevAlive = alive;
        this.lastTickEndTimestamp = Date.now();
    }
}