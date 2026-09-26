import { readFileSync, watch } from "fs";
import { randomBytes } from "crypto";
import { Http3Server } from "@fails-components/webtransport";
import type { WebTransportSession } from "@fails-components/webtransport";

import { StreamPeer } from "../shared/channel.js";
import { MessageDecoder, readMessages } from "../shared/protocol.js";
import type { Peer, Message } from "../shared/protocol.js";

interface WebTransportHandlers {
    resolveToken: (token: string) => string | null;
    connect: (userID: string, peer: Peer) => (message: Message) => void;
    disconnect: (userID: string, peer: Peer) => void;
}

const sessionPath = "/tail";

// A direct HTTP/3 listener, using the deployment's existing certificate.
// Startup failure leaves Socket.IO available as the compatibility transport.
export async function startWebTransport(handlers: WebTransportHandlers): Promise<number | null> {
    const port = Number(process.env.WT_PORT) || 9002;
    const certPath = process.env.WT_CERT;
    const keyPath = process.env.WT_KEY;
    if (!certPath || !keyPath) {
        console.log("WebTransport disabled (set WT_CERT and WT_KEY to enable)");
        return null;
    }

    try {
        const server = new Http3Server({
            host: "0.0.0.0",
            port,
            secret: randomBytes(16).toString("hex"),
            cert: readFileSync(certPath, "utf8"),
            privKey: readFileSync(keyPath, "utf8"),
            defaultDatagramsReadableMode: "bytes"
        });

        server.startServer();
        const ready = await Promise.race([
            server.ready.then(() => true, () => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
        ]);
        if (!ready) {
            console.error("WebTransport disabled: server did not become ready");
            server.stopServer();
            return null;
        }

        server.setRequestCallback(async (request: any) => {
            const [path, query] = String(request.header?.[":path"] ?? "").split("?");
            if (path !== sessionPath) {
                return { ...request, status: 404 };
            }
            const userID = handlers.resolveToken(new URLSearchParams(query).get("t") ?? "");
            if (!userID) {
                return { ...request, status: 404 };
            }
            return { ...request, path, header: { ...request.header, ":path": path }, userData: { userID }, status: 200 };
        });

        watchCertificate(certPath, keyPath, server);
        acceptSessions(server, handlers).catch((err) => console.error("WebTransport stopped accepting sessions", err));

        console.log(`WebTransport listening on udp/*:${port}`);
        return port;
    } catch (err) {
        console.error("WebTransport disabled: failed to start", err);
        return null;
    }
}

// Hot-swap the certificate when Caddy renews it on disk.
function watchCertificate(certPath: string, keyPath: string, server: Http3Server) {
    let pending = false;
    try {
        watch(certPath, () => {
            if (pending) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                try {
                    server.updateCert(readFileSync(certPath, "utf8"), readFileSync(keyPath, "utf8"), false);
                    console.log("WebTransport certificate reloaded");
                } catch (err) {
                    console.error("WebTransport certificate reload failed", err);
                }
            }, 1000);
        });
    } catch (err) {
        console.error("WebTransport certificate watch unavailable (renewals need a restart)", err);
    }
}

async function acceptSessions(server: Http3Server, handlers: WebTransportHandlers) {
    const reader = server.sessionStream(sessionPath).getReader();
    for (;;) {
        const { value: session, done } = await reader.read();
        if (done) break;
        bindSession(session, handlers).catch(() => session.close());
    }
}

async function bindSession(session: WebTransportSession, handlers: WebTransportHandlers) {
    const userID = (session.userData as { userID?: string } | null)?.userID;
    if (!userID) { session.close(); return; }
    // Bound sessions whose client never opens the gameplay stream.
    const timeout = setTimeout(() => session.close(), 5000);
    await session.ready;
    const reader = session.incomingBidirectionalStreams.getReader();
    const { value: stream, done } = await reader.read();
    reader.releaseLock();
    clearTimeout(timeout);
    if (done || !stream) { session.close(); return; }
    const peer = new StreamPeer(stream.writable, session.datagrams, () => {
        session.close();
        handlers.disconnect(userID, peer);
    });
    const receive = handlers.connect(userID, peer);
    session.closed.catch(() => {}).finally(() => peer.close());
    readMessages(stream.readable, receive).catch(() => {}).finally(() => peer.close());
    const datagrams = session.datagrams.readable.getReader();
    try {
        for (;;) {
            const { value, done } = await datagrams.read();
            if (done) break;
            const decoder = new MessageDecoder();
            for (const message of decoder.push(value)) {
                if (message.event === 'input' || message.event === 'time_sync') receive(message);
            }
            decoder.finish();
        }
    } finally { datagrams.releaseLock(); peer.close(); }
}
