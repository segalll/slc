import { coordToUint16, uint16ToCoord, isDirection, Direction } from './model.js';
import type { GameSettings, PlayerInfo, Point, PortalPair, Segment } from './model.js';

export interface Turn { s: number; d: Direction; t: number }
export const inputWindow = 64;
export const snapshotHistory = 3;
export const maxFrameBytes = 4 * 1024 * 1024;
export const events = ['sync', 'ready', 'input', 'time_sync', 'game_state', 'game_tail',
    'world_state', 'modify_player', 'remove', 'starting', 'death', 'round_over',
    'game_settings', 'update_settings', 'start', 'join', 'resync'] as const;
export type Event = typeof events[number];
export interface Message { event: Event; data: any }
export interface Peer {
    send(event: Event, data?: unknown, volatile?: boolean): void;
    close(): void;
}
export interface HeadState {
    index: number; segmentIndex: number; direction: Direction; dead: boolean; segments: Segment[];
}
export interface Snapshot { round: number; tick: number; ack: number; playing: boolean; players: HeadState[] }
export interface GameSync {
    round: number; tick: number; ack: number; playing: boolean; startsAt: number | null;
    settings: GameSettings; self: number;
    players: (PlayerInfo & { segments: Segment[]; direction: Direction; dead: boolean })[];
    world: Segment[]; portals: PortalPair[];
}

export class InputSequence {
    ack = 0;
    private pending = new Map<number, Turn>();
    receive(value: unknown): Turn[] {
        if (!Array.isArray(value) || value.length > inputWindow) return [];
        for (const turn of value) {
            if (!turn || !Number.isSafeInteger(turn.s) || turn.s <= this.ack ||
                turn.s > this.ack + inputWindow || !isDirection(turn.d) ||
                !Number.isFinite(turn.t) || turn.t < 0) continue;
            if (!this.pending.has(turn.s)) this.pending.set(turn.s, { s: turn.s, d: turn.d, t: turn.t });
        }
        const result: Turn[] = [];
        while (this.pending.has(this.ack + 1)) {
            result.push(this.pending.get(++this.ack)!);
            this.pending.delete(this.ack);
        }
        return result;
    }
}
const binaryEvents = new Set<Event>(['game_state', 'game_tail', 'world_state']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function encodeMessage(event: Event, data?: unknown): Uint8Array {
    const body = binaryEvents.has(event)
        ? data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
        : encoder.encode(JSON.stringify(data ?? null));
    if (body.length + 1 > maxFrameBytes) throw new Error('Message too large');
    const result = new Uint8Array(body.length + 5);
    new DataView(result.buffer).setUint32(0, body.length + 1);
    result[4] = events.indexOf(event);
    result.set(body, 5);
    return result;
}
export class MessageDecoder {
    private pending = new Uint8Array(0);
    push(chunk: Uint8Array): Message[] {
        const bytes = new Uint8Array(this.pending.length + chunk.length);
        bytes.set(this.pending); bytes.set(chunk, this.pending.length);
        const messages: Message[] = [];
        let offset = 0;
        while (bytes.length - offset >= 4) {
            const length = new DataView(bytes.buffer).getUint32(offset);
            if (length < 1 || length > maxFrameBytes) throw new Error('Invalid message length');
            if (bytes.length - offset < length + 4) break;
            const event = events[bytes[offset + 4]];
            if (!event) throw new Error('Unknown message');
            const body = bytes.slice(offset + 5, offset + 4 + length);
            messages.push({ event, data: binaryEvents.has(event) ? body.buffer : JSON.parse(decoder.decode(body)) });
            offset += length + 4;
        }
        this.pending = bytes.slice(offset);
        return messages;
    }
    finish() { if (this.pending.length) throw new Error('Truncated message'); }
}
export async function readMessages(stream: ReadableStream<Uint8Array>, receive: (message: Message) => void) {
    const reader = stream.getReader();
    const decoder = new MessageDecoder();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) { decoder.finish(); return; }
            for (const message of decoder.push(value)) receive(message);
        }
    } finally { reader.releaseLock(); }
}

// Each head includes recent segments, so turns do not depend on reliable patches.
export function encodeSnapshot(state: Snapshot, aspect: number): Uint8Array {
    const bytes = new Uint8Array(18 + state.players.reduce((n, p) => n + 7 + p.segments.length * 8, 0));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, state.round, true); view.setUint32(4, state.tick, true);
    view.setUint32(8, state.ack, true); view.setUint8(12, Number(state.playing));
    view.setUint8(13, state.players.length);
    view.setFloat32(14, aspect, true);
    let at = 18;
    for (const p of state.players) {
        view.setUint16(at, p.index, true); view.setUint16(at + 2, p.segmentIndex, true);
        view.setUint8(at + 4, p.direction); view.setUint8(at + 5, Number(p.dead));
        view.setUint8(at + 6, p.segments.length); at += 7;
        for (const segment of p.segments) for (const point of segment) {
            view.setUint16(at, coordToUint16(point[0], -aspect, aspect), true);
            view.setUint16(at + 2, coordToUint16(point[1], -1, 1), true); at += 4;
        }
    }
    return bytes;
}
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot | null {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 18) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const aspect = view.getFloat32(14, true);
    if (!Number.isFinite(aspect) || aspect <= 0) return null;
    const state: Snapshot = { round: view.getUint32(0, true), tick: view.getUint32(4, true),
        ack: view.getUint32(8, true), playing: Boolean(view.getUint8(12)), players: [] };
    let at = 18;
    for (let i = 0; i < view.getUint8(13); i++) {
        if (at + 7 > bytes.length) return null;
        const index = view.getUint16(at, true), segmentIndex = view.getUint16(at + 2, true);
        const direction = view.getUint8(at + 4), dead = Boolean(view.getUint8(at + 5)), count = view.getUint8(at + 6);
        if (!isDirection(direction) || count < 1 || count > snapshotHistory || count > segmentIndex + 1 || at + 7 + count * 8 > bytes.length) return null;
        at += 7;
        const segments: Segment[] = [];
        for (let j = 0; j < count; j++) {
            const points: Point[] = [];
            for (let k = 0; k < 2; k++) {
                points.push([uint16ToCoord(view.getUint16(at, true), -aspect, aspect), uint16ToCoord(view.getUint16(at + 2, true), -1, 1)]);
                at += 4;
            }
            segments.push([points[0], points[1]]);
        }
        state.players.push({ index, segmentIndex, direction, dead, segments });
    }
    return at === bytes.length ? state : null;
}
