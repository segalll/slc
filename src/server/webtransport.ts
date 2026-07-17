import { readFileSync, watch } from "fs";
import { randomBytes } from "crypto";
import { Http3Server } from "@fails-components/webtransport";
import type { WebTransportSession } from "@fails-components/webtransport";

interface WebTransportHandlers {
    resolveToken: (token: string) => string | null; // session token -> userID, or null to reject
    onWriter: (userID: string, writer: WritableStreamDefaultWriter<Uint8Array> | null) => void;
}

const sessionPath = "/tail";

// Carries the volatile game_tail over QUIC datagrams. Reached directly on its own UDP port
// (Caddy can't proxy WebTransport), reusing the certificate Caddy issues for the domain.
// Strictly optional: any failure returns null and the game keeps sending the tail over the
// websocket exactly as before. Returns the port clients should connect to, or null if disabled.
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
    // Tracks the live writer per user so a closing session never clears a newer one.
    const current = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();
    const reader = server.sessionStream(sessionPath).getReader();
    for (;;) {
        const { value: session, done } = await reader.read();
        if (done) break;
        bindSession(session, handlers, current).catch(() => {});
    }
}

async function bindSession(
    session: WebTransportSession,
    handlers: WebTransportHandlers,
    current: Map<string, WritableStreamDefaultWriter<Uint8Array>>
) {
    const userID = (session.userData as { userID?: string } | null)?.userID;
    if (!userID) {
        session.close();
        return;
    }
    try {
        await session.ready;
    } catch {
        return;
    }

    const writer = session.datagrams.createWritable().getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    current.set(userID, writer);
    handlers.onWriter(userID, writer);

    session.closed.catch(() => {}).finally(() => {
        if (current.get(userID) === writer) {
            current.delete(userID);
            handlers.onWriter(userID, null);
        }
    });
}
