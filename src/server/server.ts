import * as express from "express";
import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { Game } from "./game";
import { Direction, GameSettings } from "../shared/model";

const randomID = () => randomBytes(8).toString("hex");

const app = express();
const port = process.env.PORT || 9001;
app.set("port", port);

const http = new HttpServer(app);
const io = new Server(http);

app.use(express.static("dist"));

app.get("/", (req, res) => {
    res.sendFile("dist/index.html");
})

interface Session {
    sessionID: string;
    userID: string;
    username: string;
    color: string;
    pendingDeletion: boolean;
};

const sessionStore = new Map<string, Session>();

io.use((socket: Socket, next) => {
    const sessionID = socket.handshake.auth.sessionID;
    if (sessionID) {
        const session = sessionStore.get(sessionID);
        if (session) {
            (socket as any).sessionID = sessionID;
            return next();
        }
    }
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("invalid session"));
    }
    (socket as any).sessionID = randomID();
    sessionStore.set((socket as any).sessionID, {
        sessionID: (socket as any).sessionID,
        userID: randomID(),
        username,
        color: socket.handshake.auth.color,
        pendingDeletion: false
    });
    next();
})

const game = new Game(io);

const timeout = 3000; // ms

io.on("connection", (socket: Socket) => {
    const session = sessionStore.get((socket as any).sessionID)!;
    socket.emit("session", session.sessionID);

    console.log(`Connection | ID: ${session.userID}`);
    socket.on("join", () => {
        console.log(`Join | ID: ${session.userID}`);
        socket.emit("game_settings", {
            aspectRatio: game.aspectRatio,
            lineWidth: game.lineWidth
        } as GameSettings);
        game.addPlayer(socket, session.userID, session.username, session.color);
    })

    socket.on("input", (direction: Direction) => {
        game.processInput(session.userID, direction);
    })

    socket.on("redraw", () => {
        game.redraw(session.userID);
    })

    socket.on("disconnect", () => {
        console.log(`Disconnect | ID: ${session.userID}`);
        session.pendingDeletion = true;
        setTimeout(() => {
            if (session.pendingDeletion) {
                sessionStore.delete(session.sessionID);
                game.removePlayer(session.userID);
            }
        }, timeout)
    })

    socket.on("start", () => {
        game.startRound();
    })

    socket.on("heartbeat", () => {
        session.pendingDeletion = false;
    })
})

http.listen(port, () => {
    console.log(`listening on *:${port}`);
})