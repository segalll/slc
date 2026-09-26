import type { WebTransportInfo } from "../shared/model.js";
import { StreamPeer } from "../shared/channel.js";
import { MessageDecoder, readMessages } from "../shared/protocol.js";
import type { Message, Peer } from "../shared/protocol.js";

export function connectWebTransport(info: WebTransportInfo, receive: (message: Message, peer: Peer) => void, disconnected: (peer: Peer) => void): Peer | null {
    if (typeof WebTransport === 'undefined') return null;
    let transport: WebTransport;
    try { transport = new WebTransport(`https://${location.hostname}:${info.port}/tail?t=${encodeURIComponent(info.token)}`); }
    catch { return null; }
    let channel: StreamPeer | null = null;
    let closed = false;
    const peer: Peer = {
        send: (event, data, volatile) => channel?.send(event, data, volatile),
        close() {
            if (closed) return;
            closed = true;
            clearTimeout(timeout);
            channel?.close();
            transport.close();
            disconnected(peer);
        }
    };
    const timeout = setTimeout(() => peer.close(), 5000);
    transport.closed.catch(() => {}).finally(() => peer.close());
    (async () => {
        await transport.ready;
        if (closed) return;
        // Expire buffered positions in browsers implementing these queue controls.
        transport.datagrams.incomingMaxAge = 250;
        transport.datagrams.outgoingMaxAge = 100;
        const stream = await transport.createBidirectionalStream();
        if (closed) return;
        channel = new StreamPeer(stream.writable, transport.datagrams, () => peer.close());
        let synced = false;
        readMessages(stream.readable, message => {
            if (message.event === 'sync') {
                synced = true;
                clearTimeout(timeout);
            }
            receive(message, peer);
        }).catch(() => {}).finally(() => peer.close());
        (async () => {
            const reader = transport.datagrams.readable.getReader();
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!synced) continue;
                const decoder = new MessageDecoder();
                for (const message of decoder.push(value)) receive(message, peer);
                decoder.finish();
            }
        })().catch(() => peer.close());
        // Writing opens the QUIC stream; merely creating it need not notify the server.
        channel.send('join');
    })().catch(() => peer.close());
    return peer;
}
