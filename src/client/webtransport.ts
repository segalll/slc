import type { WebTransportInfo } from "../shared/model";

// Opens the datagram channel and forwards each datagram to onDatagram. WebTransport is a pure
// enhancement: if it's unsupported or fails, we return null and the volatile game_tail keeps
// arriving over the websocket exactly as before. Returns the transport so the caller can close it.
export const connectWebTransport = (info: WebTransportInfo, onDatagram: (data: Uint8Array) => void): WebTransport | null => {
    if (typeof WebTransport === "undefined") {
        return null;
    }

    const url = `https://${location.hostname}:${info.port}/tail?t=${encodeURIComponent(info.token)}`;
    let transport: WebTransport;
    try {
        transport = new WebTransport(url);
    } catch {
        return null;
    }

    (async () => {
        await transport.ready;
        const reader = transport.datagrams.readable.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) onDatagram(value);
        }
    })().catch(() => {});

    return transport;
};
