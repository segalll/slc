import type { Socket } from 'socket.io-client';
import { events, inputWindow, decodeSnapshot } from '../shared/protocol.js';
import type { Event, Message, Peer, Turn } from '../shared/protocol.js';
import { connectWebTransport } from './webtransport.js';
export class Connection {
    private handlers = new Map<string, ((data: any) => void)[]>();
    private websocket: Peer;
    private webtransport: Peer | null = null;
    private active: Peer | null = null;
    private connection = 0;
    private round = 0;
    private session = '';
    private pending: Turn[] = [];
    private lastReceive = 0;
    private lastSnapshot = 0;

    constructor(private socket: Socket) {
        this.websocket = {
            send: (event, data, volatile) => {
                if (socket.connected) (volatile ? socket.volatile : socket).emit(event, data);
            }, close: () => socket.disconnect()
        };
        socket.on('session', id => {
            if (id !== this.session) {
                this.session = id;
                this.connection = 0;
            }
            this.dispatch('session', id);
        });
        socket.on('connect', () => socket.emit('join'));
        socket.on('connect_error', error => this.dispatch('connect_error', error));
        socket.on('disconnect', () => {
            if (this.active === this.websocket) {
                this.active = null;
            }
        });
        socket.on('webtransport', info => {
            if (this.active === this.webtransport && this.webtransport) return;
            this.webtransport?.close();
            this.webtransport = connectWebTransport(info, (message, peer) => this.receive(message, peer), peer => {
                if (this.webtransport !== peer) return;
                this.webtransport = null;
                if (this.active === peer) {
                    this.active = null;
                }
                // Also covers a failed upgrade after the server switched away from WS.
                if (socket.connected) socket.emit('fallback');
                else socket.connect();
            });
        });
        socket.onAny((event: string, data: unknown) => {
            if (events.includes(event as Event)) this.receive({ event: event as Event, data }, this.websocket);
        });
        setInterval(() => {
            if (this.active === this.webtransport && this.webtransport && performance.now() - this.lastReceive > 3000) {
                this.webtransport.close();
            }
            this.flushInputs();
        }, 1000 / 60);
    }
    get connected() { return this.active !== null; }
    get auth() { return this.socket.auth; }
    set auth(value: Socket['auth']) { this.socket.auth = value; }
    connect() { this.socket.connect(); }
    on(event: string, handler: (data: any) => void) {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
    }
    private dispatch(event: string, data?: unknown) {
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }
    private receive({ event, data }: Message, peer: Peer) {
        if (event === 'sync') {
            if (!Number.isSafeInteger(data?.connection) || data.connection <= this.connection) return;
            this.active = peer;
            this.connection = data.connection;
            this.round = data.round;
            this.pending = [];
            this.lastSnapshot = 0;
            this.dispatch('sync', data);
            peer.send('ready', { connection: this.connection });
            this.dispatch('connect');
        } else {
            if (peer !== this.active) return;
            if (event === 'starting') {
                this.round = data.round;
                this.pending = [];
                this.lastSnapshot = 0;
            } else if (event === 'game_tail') {
                const state = decodeSnapshot(data);
                if (!state || state.round !== this.round || state.tick < this.lastSnapshot) return;
                this.lastSnapshot = state.tick;
                this.pending = this.pending.filter(turn => turn.s > state.ack);
                data = state;
            }
            this.dispatch(event, data);
        }
        this.lastReceive = performance.now();
    }
    emit(event: Event, data?: any, volatile = false) {
        if (!this.active) return;
        if (event === 'input') {
            if (this.pending.length >= inputWindow) { this.emit('resync'); return; }
            this.pending.push(data);
            this.flushInputs();
        } else this.active.send(event, data, volatile);
    }
    private flushInputs() {
        if (!this.active || !this.pending.length) return;
        // Bound each batch to one datagram even when timestamps have fractional ticks.
        this.active.send('input', { connection: this.connection, round: this.round, turns: this.pending.slice(0, 16) }, true);
    }
}
