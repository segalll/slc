import type { Game } from './game.js';
import type { Event, Message, Peer } from '../shared/protocol.js';

export class GameSession implements Peer {
    ready = false;
    lastSeen = performance.now();
    private websocket: Peer | null = null;
    private webtransport: Peer | null = null;
    private active: Peer | null = null;
    private connection = 0;
    private joined = false;
    constructor(private game: Game, readonly id: string, private name: string, private color: string) {}
    attach(peer: Peer, kind: 'websocket' | 'webtransport') {
        const previous = this[kind];
        this[kind] = peer;
        if (kind === 'webtransport' || !this.webtransport) {
            this.active = peer;
            if (!this.joined) {
                this.joined = true;
                this.game.addPlayer(this, this.id, this.name, this.color);
            }
            this.synchronize();
        }
        if (previous && previous !== peer) previous.close();
    }
    private synchronize() {
        this.ready = false;
        this.lastSeen = performance.now();
        this.connection++;
        this.game.resetInputs(this.id);
        this.active?.send('sync', { ...this.game.getSync(this.id), connection: this.connection });
    }
    detach(peer: Peer) {
        if (this.websocket === peer) this.websocket = null;
        if (this.webtransport === peer) this.webtransport = null;
        if (this.active !== peer) return;
        this.active = this.webtransport ?? this.websocket;
        this.ready = false;
        this.lastSeen = performance.now();
        if (this.active) this.synchronize();
    }
    fallback(peer: Peer) {
        if (peer !== this.websocket || !this.webtransport) return;
        const previous = this.webtransport;
        this.detach(previous);
        previous.close();
    }
    receive(peer: Peer, { event, data }: Message) {
        if (this.active !== peer) return;
        if (event === 'ready' && data?.connection === this.connection) {
            this.ready = true;
            this.lastSeen = performance.now();
            return;
        }
        if (!this.ready) return;
        this.lastSeen = performance.now();
        switch (event) {
            case 'input': if (data?.connection === this.connection) this.game.processInputs(this.id, data); break;
            case 'time_sync':
                if (Number.isFinite(data?.c)) this.send('time_sync', { c: data.c, s: this.game.getTick() }, true);
                break;
            case 'start': this.game.startRound(); break;
            case 'update_settings':
                if (data && typeof data === 'object') this.game.updateSettings(data);
                break;
            case 'resync': this.synchronize(); break;
        }
    }
    send(event: Event, data?: unknown, volatile = false) {
        if (!volatile || this.ready) this.active?.send(event, data, volatile);
    }
    checkHealth(now: number) {
        if (this.webtransport && now - this.lastSeen > 3000) this.webtransport.close();
        return !this.active && now - this.lastSeen > 3000;
    }
    close() { this.websocket?.close(); this.webtransport?.close(); }
}
