import * as express from "express";
import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { Game } from "./game";
import { Direction, GameSettings, GAME_CONSTANTS } from "../shared/model";

const randomID = (): string => randomBytes(8).toString("hex");

interface Session {
    sessionID: string;
    userID: string;
    username: string;
    color: string;
    pendingDeletion: boolean;
}

class SessionManager {
    private sessions = new Map<string, Session>();

    createSession(username: string, color: string): Session {
        const sessionID = randomID();
        const userID = randomID();
        
        const session: Session = {
            sessionID,
            userID,
            username,
            color,
            pendingDeletion: false
        };
        
        this.sessions.set(sessionID, session);
        return session;
    }

    getSession(sessionID: string): Session | undefined {
        return this.sessions.get(sessionID);
    }

    markForDeletion(sessionID: string): void {
        const session = this.sessions.get(sessionID);
        if (session) {
            session.pendingDeletion = true;
        }
    }

    deleteSession(sessionID: string): void {
        this.sessions.delete(sessionID);
    }

    scheduleDeletion(sessionID: string): void {
        setTimeout(() => {
            const session = this.sessions.get(sessionID);
            if (session?.pendingDeletion) {
                this.sessions.delete(sessionID);
            }
        }, GAME_CONSTANTS.SESSION_TIMEOUT);
    }
}

const app = express();
const port = process.env.PORT || 9001;
app.set("port", port);

const http = new HttpServer(app);
const io = new Server(http);
const sessionManager = new SessionManager();
const game = new Game(io);

app.use(express.static("dist"));

app.get("/", (req, res) => {
    res.sendFile("dist/index.html");
});

io.use((socket: Socket, next) => {
    const sessionID = socket.handshake.auth.sessionID;
    
    if (sessionID) {
        const session = sessionManager.getSession(sessionID);
        if (session) {
            (socket as any).sessionID = sessionID;
            return next();
        }
    }
    
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("invalid session"));
    }
    
    const session = sessionManager.createSession(username, socket.handshake.auth.color);
    (socket as any).sessionID = session.sessionID;
    next();
});

io.on("connection", (socket: Socket) => {
    const session = sessionManager.getSession((socket as any).sessionID)!;
    socket.emit("session", session.sessionID);

    console.log(`Connection | ID: ${session.userID}`);
    
    socket.on("join", () => {
        console.log(`Join | ID: ${session.userID}`);
        socket.emit("game_settings", {
            aspectRatio: GAME_CONSTANTS.DEFAULT_ASPECT_RATIO,
            lineWidth: GAME_CONSTANTS.DEFAULT_LINE_WIDTH
        } as GameSettings);
        game.addPlayer(socket, session.userID, session.username, session.color);
    });

    socket.on("input", (direction: Direction) => {
        game.processInput(session.userID, direction);
    });

    socket.on("redraw", () => {
        game.redraw(session.userID);
    });

    socket.on("disconnect", () => {
        console.log(`Disconnect | ID: ${session.userID}`);
        sessionManager.markForDeletion(session.sessionID);
        sessionManager.scheduleDeletion(session.sessionID);
        game.removePlayer(session.userID);
    });

    socket.on("start", () => {
        game.startRound();
    });

    socket.on("heartbeat", () => {
        const session = sessionManager.getSession((socket as any).sessionID);
        if (session) {
            session.pendingDeletion = false;
        }
    });
});

http.listen(port, () => {
    console.log(`listening on *:${port}`);
});