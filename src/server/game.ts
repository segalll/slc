import { Socket } from "socket.io";
import { GameState } from "../shared/model";

interface Player {
    name: string;
    direction: number[]; // normalized vector
    points: number[][]; // list of 2d points
    socket: Socket;
}

export class Game {
    players: Map<string, Player>;

    constructor() {
        this.players = new Map<string, Player>();
        setInterval(() => this.gameLoop(), 50);
    }

    addPlayer(socket: Socket) {
        if (!this.players.has((socket as any).userID)) {
            this.players.set((socket as any).userID, {
                name: (socket as any).username,
                direction: [ 1.0, 0.0 ],
                points: [[ 0, 0 ], [ 0, 0 ]],
                socket
            });
        } else {
            this.players.get((socket as any).userID)!.socket = socket;
        }
    }

    gameLoop(this: Game) {
        for (let [id, player] of this.players.entries()) {
            player.points[player.points.length - 1][0] += player.direction[0] * 0.005;
            player.points[player.points.length - 1][1] += player.direction[1] * 0.005;
            this.players.set(id, player);
            player.socket.emit("game_state", {
                userID: id,
                lastSegment: player.points.slice(-2),
                pointCount: player.points.length
            } as GameState);
        }
    }
}