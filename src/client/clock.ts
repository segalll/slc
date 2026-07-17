import type { Socket } from "socket.io-client";
import { tickRate } from "../shared/model";

const msPerTick = 1000 / tickRate;
const pingIntervalMs = 2000;
const bestSampleMaxAgeMs = 10000;

// Estimates the current server tick from the client clock via ping/pong RTT, keeping the offset from
// the lowest-RTT recent sample (the most accurate). Used to time-stamp local inputs and to place
// predicted turns relative to authoritative head samples.
export class Clock {
    private offset = 0;          // serverTick - performance.now()/msPerTick, from the best sample
    private bestRtt = Infinity;
    private bestRttTime = 0;
    private started = false;

    start(socket: Socket) {
        if (this.started) return;
        this.started = true;
        socket.on("time_sync", (msg: { c: number; s: number }) => this.onPong(msg.c, msg.s));
        const ping = () => socket.volatile.emit("time_sync", performance.now()); // drop stale pings buffered during a disconnect
        ping();
        setInterval(ping, pingIntervalMs);
    }

    private onPong(clientTime: number, serverTick: number) {
        const now = performance.now();
        const rtt = now - clientTime;
        if (rtt < this.bestRtt || now - this.bestRttTime > bestSampleMaxAgeMs) {
            this.bestRtt = rtt;
            this.bestRttTime = now;
            this.offset = serverTick + rtt / 2 / msPerTick - now / msPerTick;
        }
    }

    get synced() {
        return this.bestRtt < Infinity;
    }

    serverTickNow() {
        return performance.now() / msPerTick + this.offset;
    }
}
