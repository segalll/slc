import { tickRate } from '../shared/model.js';
import type { Segment } from '../shared/model.js';
import type { HeadState } from '../shared/protocol.js';
export type TimedHead = HeadState & { tick: number };
export class MotionHistory {
    segments: Segment[] = [];
    head: TimedHead | null = null;
    private versions: number[] = [];
    private samples: TimedHead[] = [];
    snapshot(head: HeadState, tick: number) {
        if (this.head && tick <= this.head.tick) return false;
        this.patch(head.segmentIndex + 1 - head.segments.length, head.segments, tick);
        this.head = { ...head, tick };
        this.samples.push(this.head);
        if (this.samples.length > 32) this.samples.shift();
        return true;
    }
    patch(start: number, segments: Segment[], tick: number) {
        while (this.segments.length < start + segments.length) {
            this.segments.push([[0, 0], [0, 0]]);
            this.versions.push(-1);
        }
        segments.forEach((segment, i) => {
            const index = start + i;
            if (tick >= this.versions[index]) {
                this.segments[index] = segment;
                this.versions[index] = tick;
            }
        });
    }
    trailAt(tick: number): Segment[] {
        if (!this.head) return this.segments;
        const next = this.samples.find(sample => sample.tick >= tick) ?? this.head;
        const previous = this.samples[Math.max(0, this.samples.indexOf(next) - 1)];
        const trail = this.segments.slice(0, next.segmentIndex + 1);
        const start = next.segmentIndex + 1 - next.segments.length;
        next.segments.forEach((segment, i) => { trail[start + i] = [[...segment[0]], [...segment[1]]]; });
        // Interpolate observed travel: identical idle/dead snapshots have zero movement.
        let distance = 0;
        for (let i = Math.max(start, previous.segmentIndex); i < trail.length; i++) {
            const from = i === previous.segmentIndex ? previous.segments.at(-1)![1] : trail[i][0];
            distance += Math.hypot(trail[i][1][0] - from[0], trail[i][1][1] - from[1]);
        }
        distance *= next.tick === previous.tick ? 0 : Math.max(0, Math.min(1, (next.tick - tick) / (next.tick - previous.tick)));
        // Walk backwards over actual corners/portals instead of interpolating a diagonal.
        while (trail.length > start && distance > 0) {
            const segment = trail[trail.length - 1];
            const dx = segment[1][0] - segment[0][0], dy = segment[1][1] - segment[0][1];
            const length = Math.hypot(dx, dy);
            if (distance <= length && length > 0) {
                segment[1] = [segment[1][0] - dx * distance / length, segment[1][1] - dy * distance / length];
                break;
            }
            distance -= length;
            if (trail.length === start + 1) { segment[1] = [...segment[0]]; break; }
            trail.pop();
        }
        return trail;
    }
}
export class PlayoutClock {
    private latest = 0;
    private received = 0;
    private lastFrame = 0;
    private tick: number | null = null;
    private jitter = 0;
    observe(tick: number, now: number) {
        if (tick <= this.latest) return;
        if (this.latest) {
            const variation = Math.abs((now - this.received) * tickRate / 1000 - (tick - this.latest));
            this.jitter += (variation - this.jitter) * 0.1;
        }
        this.latest = tick;
        this.received = now;
    }
    sample(now: number) {
        // Rendering can start before the first snapshot establishes the server timeline.
        if (this.latest === 0) return 0;
        const delay = Math.min(6, 2 + this.jitter * 2);
        const target = this.latest + (now - this.received) * tickRate / 1000 - delay;
        const step = Math.max(0, now - this.lastFrame) * tickRate / 1000;
        this.tick = this.tick === null ? target : Math.max(this.tick, Math.min(target, this.tick + step * 1.1));
        this.tick = Math.min(this.latest, this.tick);
        this.lastFrame = now;
        return this.tick;
    }
}
