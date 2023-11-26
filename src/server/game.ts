import { Server, Socket } from "socket.io";
import { Direction, Point, Segment, GameSettings, GameState, PlayerState } from "../shared/model";

interface Player {
    name: string;
    color: [number, number, number];
    score: number;

    direction: Point; // normalized vector
    segments: Segment[];
    fieldPartitions: Set<number>[]; // each partition is a set of indices into segments
    currentPartition: number;
    dead: boolean;

    socket: Socket;
    lastSentSegmentIndices: Map<string, number>; // per player
    pendingDeletion: boolean; // used to determine if player has rejoined after disconnect
}

const directionVectorFromDirection = (direction: Direction): Point => {
    switch (direction) {
        case Direction.Left:
            return [ -1.0, 0.0 ];
        case Direction.Right:
            return [ 1.0, 0.0 ];
        case Direction.Up:
            return [ 0.0, 1.0 ];
        case Direction.Down:
            return [ 0.0, -1.0 ];
    }
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
    tickRate: number = 20;
    minSpawnDistanceFromEdge: number = 0.1;
    playing: boolean = false;
    prevAlive: string[] = []; // list of ids of players that were alive last tick

    constructor(server: Server) {
        this.server = server;
        this.players = new Map<string, Player>();
        this.settings = {
            aspectRatio: 1.5,
            lineWidth: 0.002
        };
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    pointToPartition(point: Point): number {
        const partitionSizeX = 2 * this.settings.aspectRatio / this.numPartitions;
        const partitionSizeY = 2.0 / this.numPartitions;
        const x = Math.floor((point[0] + this.settings.aspectRatio) / partitionSizeX);
        const y = Math.floor((point[1] + 1.0) / partitionSizeY);
        return y * this.numPartitions + x;
    }

    lineCrossesLine(line1: Segment, line2: Segment): [boolean, Point | null] {
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

            player.direction = directionVectorFromDirection(Math.floor(Math.random() * 4));
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

    removePlayer(id: string) {
        if (!this.players.has(id)) {
            return;
        }
        this.players.delete(id);
        this.server.emit("remove", id);
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
                name,
                color,
                score,

                direction: [ 0.0, 0.0 ],
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

    processInput(userID: string, direction: Direction) {
        if (!this.players.has(userID)) {
            return;
        }
        const player = this.players.get(userID)!;

        const lastDirection = player.direction;
        if ((direction === Direction.Right && lastDirection[1] === 0.0) ||
            (direction === Direction.Up && lastDirection[0] === 0.0) ||
            (direction === Direction.Down && lastDirection[0] === 0.0) ||
            (direction === Direction.Left && lastDirection[1] === 0.0)) {
            return;
        }

        const newPoint: Point = structuredClone(player.segments[player.segments.length - 1][1]);
        switch (direction) {
            case Direction.Left:
                player.direction = [ -1.0, 0.0 ];
                newPoint[0] -= this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Right:
                player.direction = [ 1.0, 0.0 ];
                newPoint[0] += this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Up:
                player.direction = [ 0.0, 1.0 ];
                newPoint[1] += this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                break;
            case Direction.Down:
                player.direction = [ 0.0, -1.0 ];
                newPoint[1] -= this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                break;
        }
        player.segments.push([ newPoint, structuredClone(newPoint) ] as Segment);
        this.players.set(userID, player);
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

    moveAndCheckCollisions(id: string, player: Player) {
        let newPoint = structuredClone(player.segments[player.segments.length - 1][1]);
        newPoint[0] += player.direction[0] * this.moveSpeed / this.tickRate;
        newPoint[1] += player.direction[1] * this.moveSpeed / this.tickRate;

        if (newPoint[0] < -this.settings.aspectRatio || newPoint[0] > this.settings.aspectRatio || newPoint[1] < -1.0 || newPoint[1] > 1.0) {
            // technically don't have to adjust point since it's not in the canvas anyways
            // newPoint[0] = Math.max(-this.settings.aspectRatio, Math.min(this.settings.aspectRatio, newPoint[0]));
            // newPoint[1] = Math.max(-1.0, Math.min(1.0, newPoint[1]));
            player.segments[player.segments.length - 1][1] = newPoint;
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
                    if (id === id2 && (player.segments.length - 1) - segmentIndex < 2) {
                        continue;
                    }

                    const checkedSegment = [ player.segments[player.segments.length - 1][1], newPoint ] as Segment;
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

    gameLoop() {
        if (!this.playing) {
            return;
        }

        const alive = [];
        for (const [id, player] of this.players.entries()) {
            if (!player.dead) {
                alive.push(id);
                this.moveAndCheckCollisions(id, player);
            }

            for (const [id2, player2] of this.players.entries()) {
                const lastSentSegmentIndex = player.lastSentSegmentIndices.get(id2)!;
                if (lastSentSegmentIndex < player2.segments.length - 1) {
                    player.lastSentSegmentIndices.set(id2, player2.segments.length - 1);
                }

                player.socket.emit("game_state", {
                    playing: true,
                    players: [
                        {
                            id: id2,
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
    }
}