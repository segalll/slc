import express from "express";
import { Server, type Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { Game } from "./game.js";
import { GameSession } from "./session.js";
import { startWebTransport } from "./webtransport.js";
import { events } from "../shared/protocol.js";
import type { Event, Peer } from "../shared/protocol.js";

const randomID = () => randomBytes(16).toString("hex");
const app = express();
const http = new HttpServer(app);
const io = new Server(http);
app.use(express.static("dist"));

interface Session {
    game: GameSession;
    socket: Socket | null;
}
const sessions = new Map<string, Session>();
const tokens = new Map<string, { sessionID: string; expires: number }>();
const game = new Game((event, data) => {
    for (const session of sessions.values()) session.game.send(event, data);
});
setInterval(() => game.advance(performance.now()), 4);

io.use((socket, next) => {
    let sessionID = socket.handshake.auth.sessionID;
    if (typeof sessionID !== 'string' || !sessions.has(sessionID)) {
        const { username, color } = socket.handshake.auth;
        if (typeof username !== 'string' || !username.trim() || username.trim().length > 32 ||
            typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
            return next(new Error('invalid session'));
        }
        sessionID = randomID();
        sessions.set(sessionID, { game: new GameSession(game, randomID(), username.trim(), color), socket: null });
    }
    socket.data.sessionID = sessionID;
    next();
});

const wtPort = await startWebTransport({
    resolveToken(token) {
        const entry = tokens.get(token);
        return entry && entry.expires > performance.now() && sessions.has(entry.sessionID) ? entry.sessionID : null;
    },
    connect(sessionID, peer) {
        const session = sessions.get(sessionID);
        if (!session) { peer.close(); return () => {}; }
        session.game.attach(peer, 'webtransport');
        return message => session.game.receive(peer, message);
    },
    disconnect(sessionID, peer) { sessions.get(sessionID)?.game.detach(peer); }
});

io.on('connection', socket => {
    const sessionID = socket.data.sessionID as string;
    const session = sessions.get(sessionID)!;
    session.socket?.disconnect(true);
    session.socket = socket;
    const peer: Peer = {
        send(event, data, volatile) {
            if (!socket.connected) return;
            if (volatile) socket.volatile.emit(event, data);
            else socket.emit(event, data);
        },
        close() { socket.disconnect(true); }
    };
    socket.emit('session', sessionID);
    if (wtPort !== null) {
        const token = randomID();
        tokens.set(token, { sessionID, expires: performance.now() + 5 * 60_000 });
        socket.emit('webtransport', { port: wtPort, token });
    }
    socket.on('join', () => session.game.attach(peer, 'websocket'));
    socket.on('fallback', () => session.game.fallback(peer));
    socket.onAny((event: string, data: unknown) => {
        if (event !== 'join' && events.includes(event as Event)) session.game.receive(peer, { event: event as Event, data });
    });
    socket.on('disconnect', () => {
        if (session.socket === socket) session.socket = null;
        session.game.detach(peer);
    });
});

setInterval(() => {
    const now = performance.now();
    for (const [id, session] of sessions) {
        if (session.game.checkHealth(now)) {
            session.game.close();
            game.removePlayer(session.game.id);
            sessions.delete(id);
        }
    }
    for (const [token, entry] of tokens) if (entry.expires < now) tokens.delete(token);
}, 1000);

const port = Number(process.env.PORT) || 9001;
http.listen(port, () => console.log(`listening on *:${port}`));
