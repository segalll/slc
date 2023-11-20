import * as express from "express";
import { join, resolve } from "path";
import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";

const randomID = () => randomBytes(8).toString("hex");

const app = express();
const port = process.env.PORT || 9001;
app.set("port", port);

const http = new HttpServer(app);
const io = new Server(http);

app.use(express.static(join(__dirname, "../client")))

app.get("/", (req, res) => {
    res.sendFile(resolve("./src/client/index.html"));
})

interface Session {
    userID: string;
    username: string;
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
    next();
})

io.on("connection", (socket: Socket) => {
    sessionStore.set((socket as any).sessionID, {
        userID: (socket as any).userID,
        username: (socket as any).username
    });
    socket.emit("session", {
        sessionID: (socket as any).sessionID,
        userID: (socket as any).userID,
    })
    console.log(`Connection | IP: ${socket.handshake.address} | ID: ${(socket as any).userID}`);
    socket.on("join", () => {
        console.log(`Join | IP: ${socket.handshake.address} | ID: ${(socket as any).userID}`);
        //socket.emit("game_state", { msg: "hello" })
    })
})

http.listen(port, () => {
    console.log(`listening on *:${port}`);
})