import * as express from "express";
import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { Game } from "./game";
import { Direction } from "../shared/model";

const randomID = () => randomBytes(8).toString("hex");

const app = express();
const port = process.env.PORT || 9001;
app.set("port", port);

const http = new HttpServer(app);
const io = new Server(http);

app.use(express.static("dist/client"));

app.get("/", (req, res) => {
    res.sendFile("dist/client/index.html");
})

interface Session {
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
            (socket as any).userID = session.userID;
            (socket as any).username = session.username;
            (socket as any).color = session.color;
            return next();
        }
    }
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("invalid session"));
    }
    (socket as any).sessionID = randomID();
    (socket as any).userID = randomID();
    (socket as any).username = username;
    (socket as any).color = socket.handshake.auth.color;
    next();
})

const game = new Game(io);

const timeout = 3000; // ms

io.on("connection", (socket: Socket) => {
    if (!sessionStore.has((socket as any).sessionID)) {
        sessionStore.set((socket as any).sessionID, {
            userID: (socket as any).userID,
            username: (socket as any).username,
            color: (socket as any).color,
            pendingDeletion: false
        });
    }
    socket.emit("session", {
        sessionID: (socket as any).sessionID,
        userID: (socket as any).userID
    })
    console.log(`Connection | IP: ${socket.handshake.address} | ID: ${(socket as any).userID}`);
    socket.on("join", () => {
        console.log(`Join | IP: ${socket.handshake.address} | ID: ${(socket as any).userID}`);
        socket.emit("game_settings", game.settings);
        game.addPlayer(socket);
    })

    socket.on("input", (direction: Direction) => {
        game.processInput((socket as any).userID, direction);
    })

    socket.on("redraw", () => {
        game.redraw((socket as any).userID);
    })

    socket.on("disconnect", () => {
        console.log(`Disconnect | IP: ${socket.handshake.address} | ID: ${(socket as any).userID}`);
        sessionStore.get((socket as any).sessionID)!.pendingDeletion = true;
        setTimeout(() => {
            if (sessionStore.get((socket as any).sessionID)?.pendingDeletion) {
                sessionStore.delete((socket as any).sessionID);
            }
            game.removePlayer((socket as any).userID);
        }, timeout)
    })

    socket.on("start", () => {
        game.startRound();
    })

    socket.on("heartbeat", () => {
        if (!sessionStore.has((socket as any).sessionID)) {
            return;
        }
        sessionStore.get((socket as any).sessionID)!.pendingDeletion = false;
    })
})

http.listen(port, () => {
    console.log(`listening on *:${port}`);
})