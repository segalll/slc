import { encodeMessage, maxFrameBytes } from './protocol.js';
import type { Event, Peer } from './protocol.js';

interface Datagrams {
    maxDatagramSize: number;
    writable?: WritableStream<Uint8Array>;
    createWritable?: () => WritableStream<Uint8Array>;
}

export class StreamPeer implements Peer {
    private writer: WritableStreamDefaultWriter<Uint8Array>;
    private datagramWriter: WritableStreamDefaultWriter<Uint8Array>;
    private queuedBytes = 0;
    private datagramBusy = false;
    private closed = false;
    constructor(stream: WritableStream<Uint8Array>, private datagrams: Datagrams, private onClose: () => void) {
        this.writer = stream.getWriter();
        this.datagramWriter = (datagrams.createWritable?.() ?? datagrams.writable!).getWriter();
    }
    send(event: Event, data?: unknown, volatile = false) {
        if (this.closed) return;
        let bytes: Uint8Array;
        try { bytes = encodeMessage(event, data); } catch { this.close(); return; }
        if (volatile) {
            if (this.datagramBusy || bytes.length > this.datagrams.maxDatagramSize) {
                return;
            }
            this.datagramBusy = true;
            this.datagramWriter.write(bytes).catch(() => this.close()).finally(() => { this.datagramBusy = false; });
        } else {
            this.queuedBytes += bytes.length;
            if (this.queuedBytes > maxFrameBytes) { this.close(); return; }
            this.writer.write(bytes).catch(() => this.close()).finally(() => { this.queuedBytes -= bytes.length; });
        }
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.writer.abort().catch(() => {});
        this.datagramWriter.abort().catch(() => {});
        this.onClose();
    }
}
