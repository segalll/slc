import { Socket } from "socket.io";
import { Direction, Point, GameSettings, GameState } from "../shared/model";

interface Player {
    name: string;
    direction: Point; // normalized vector
    points: Point[];
    socket: Socket;
    lastSentPointIndices: Map<string, number>; // per player
}

export class Game {
    players: Map<string, Player>;
    settings: GameSettings;
    moveSpeed: number = 0.3;
    tickRate: number = 50;

    constructor() {
        this.players = new Map<string, Player>();
        this.settings = {
            aspectRatio: 1.5,
            lineWidth: 0.001
        };
        setInterval(() => this.gameLoop(), 1000 / this.tickRate);
    }

    addPlayer(socket: Socket) {
        if (!this.players.has((socket as any).userID)) {
            const lastSentPointIndices = new Map<string, number>();
            for (const id of this.players.keys()) {
                lastSentPointIndices.set(id, 0);
            }
            lastSentPointIndices.set((socket as any).userID, 0);
            this.players.set((socket as any).userID, {
                name: (socket as any).username,
                direction: [ 1.0, 0.0 ],
                points: [[ 0, 0 ], [ 0, 0 ]],
                socket,
                lastSentPointIndices
            });
        } else {
            this.players.get((socket as any).userID)!.socket = socket;
            const lastSentPointIndices = this.players.get((socket as any).userID)!.lastSentPointIndices;
            for (const id of this.players.keys()) {
                lastSentPointIndices.set(id, 0);
            }
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

        const newPoint = structuredClone(player.points[player.points.length - 1]);
        switch (direction) {
            case Direction.Left:
                player.direction = [ -1.0, 0.0 ];
                newPoint[0] -= this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                player.points[player.points.length - 1][1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Right:
                player.direction = [ 1.0, 0.0 ];
                newPoint[0] += this.settings.lineWidth;
                newPoint[1] -= lastDirection[1] * this.settings.lineWidth;
                player.points[player.points.length - 1][1] -= lastDirection[1] * this.settings.lineWidth;
                break;
            case Direction.Up:
                player.direction = [ 0.0, 1.0 ];
                newPoint[1] += this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                player.points[player.points.length - 1][0] -= lastDirection[0] * this.settings.lineWidth;
                break;
            case Direction.Down:
                player.direction = [ 0.0, -1.0 ];
                newPoint[1] -= this.settings.lineWidth;
                newPoint[0] -= lastDirection[0] * this.settings.lineWidth;
                player.points[player.points.length - 1][0] -= lastDirection[0] * this.settings.lineWidth;
                break;
        }
        player.points.push(newPoint);
        this.players.set(userID, player);
    }

    redraw(userID: string) {
        if (!this.players.has(userID)) {
            return;
        }
        const lastSentPointIndices = this.players.get(userID)!.lastSentPointIndices;
        for (const id of this.players.keys()) {
            lastSentPointIndices.set(id, 0);
        }
    }

    gameLoop(this: Game) {
        for (let [id, player] of this.players.entries()) {
            player.points[player.points.length - 1][0] += player.direction[0] * this.moveSpeed / this.tickRate;
            player.points[player.points.length - 1][1] += player.direction[1] * this.moveSpeed / this.tickRate;

            const lastSentPointIndex = player.lastSentPointIndices.get(id)!;
            if (lastSentPointIndex < player.points.length - 2) {
                player.lastSentPointIndices.set(id, player.points.length - 2);
            }
            this.players.set(id, player);
            player.socket.emit("game_state", {
                userID: id,
                missingSegments: player.points.slice(lastSentPointIndex),
            } as GameState);
        }
    }
}