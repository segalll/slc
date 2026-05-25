import express from "express";
import { Server, type Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { Game } from "./game.js";
import { isDirection, isFieldShape } from "../shared/model.js";
import type { GameSettings } from "../shared/model.js";

interface SessionSocket extends Socket {
    sessionID: string;
}

const randomID = () => randomBytes(8).toString("hex");
const isUsername = (value: unknown): value is string => {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 32;
}
const isHexColor = (value: unknown): value is string => {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
const parseSettingsUpdate = (value: unknown): Partial<GameSettings> | null => {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const payload = value as Record<string, unknown>;
    const settings: Partial<GameSettings> = {};
    if (payload.moveSpeed !== undefined) {
        if (typeof payload.moveSpeed !== "number") return null;
        settings.moveSpeed = payload.moveSpeed;
    }
    if (payload.lineWidth !== undefined) {
        if (typeof payload.lineWidth !== "number") return null;
        settings.lineWidth = payload.lineWidth;
    }
    if (payload.aspectRatio !== undefined) {
        if (typeof payload.aspectRatio !== "number") return null;
        settings.aspectRatio = payload.aspectRatio;
    }
    if (payload.fieldShape !== undefined) {
        if (!isFieldShape(payload.fieldShape)) return null;
        settings.fieldShape = payload.fieldShape;
    }
    if (payload.obstacles !== undefined) {
        if (typeof payload.obstacles !== "boolean") return null;
        settings.obstacles = payload.obstacles;
    }
    if (payload.portals !== undefined) {
        if (typeof payload.portals !== "boolean") return null;
        settings.portals = payload.portals;
    }
    return settings;
}

const app = express();
const port = process.env.PORT || 9001;
app.set("port", port);

const http = new HttpServer(app);
const io = new Server(http);

app.use(express.static("dist"));

interface Session {
    sessionID: string;
    userID: string;
    username: string;
    color: string;
    socket: SessionSocket | null;
    generation: number;
}

const sessionStore = new Map<string, Session>();

io.use((socket, next) => {
    const sessionSocket = socket as SessionSocket;
    const sessionID = socket.handshake.auth.sessionID;
    if (typeof sessionID === "string") {
        const session = sessionStore.get(sessionID);
        if (session) {
            sessionSocket.sessionID = sessionID;
            return next();
        }
    }
    const username = socket.handshake.auth.username;
    const color = socket.handshake.auth.color;
    if (!isUsername(username) || !isHexColor(color)) {
        return next(new Error("invalid session"));
    }
    sessionSocket.sessionID = randomID();
    sessionStore.set(sessionSocket.sessionID, {
        sessionID: sessionSocket.sessionID,
        userID: randomID(),
        username: username.trim(),
        color,
        socket: null,
        generation: 0
    });
    next();
})

const game = new Game(io);

const timeout = 3000; // ms

io.on("connection", (socket) => {
    const sessionSocket = socket as SessionSocket;
    const session = sessionStore.get(sessionSocket.sessionID)!;
    session.socket?.disconnect(true);
    session.socket = sessionSocket;
    session.generation++;
    socket.emit("session", session.sessionID);

    console.log(`Connection | ID: ${session.userID}`);
    socket.on("join", () => {
        console.log(`Join | ID: ${session.userID}`);
        socket.emit("game_settings", game.getSettings());
        game.addPlayer(socket, session.userID, session.username, session.color);
    })

    socket.on("update_settings", (settings) => {
        const parsedSettings = parseSettingsUpdate(settings);
        if (parsedSettings) {
            game.updateSettings(parsedSettings);
        }
    })

    socket.on("input", (direction) => {
        if (isDirection(direction)) {
            game.processInput(session.userID, direction);
        }
    })

    socket.on("disconnect", () => {
        console.log(`Disconnect | ID: ${session.userID}`);
        if (session.socket !== sessionSocket) {
            return;
        }
        session.socket = null;
        const generation = ++session.generation;
        setTimeout(() => {
            if (session.socket === null && session.generation === generation) {
                sessionStore.delete(session.sessionID);
                game.removePlayer(session.userID);
            }
        }, timeout)
    })

    socket.on("start", () => {
        game.startRound();
    })

})

http.listen(port, () => {
    console.log(`listening on *:${port}`);
})
