import { Direction, directionToVector, tickRate } from './model.js';
import type { Point, Segment } from './model.js';
import type { Turn } from './protocol.js';

export const maxPredictionTicks = tickRate / 4;
export const canTurn = (from: Direction, to: Direction) => from % 2 !== to % 2;
export function turnStart(head: Point, from: Direction, to: Direction, width: number): Point {
    const old = directionToVector(from), next = directionToVector(to);
    return [head[0] + (next[0] - old[0]) * width, head[1] + (next[1] - old[1]) * width];
}
export function predictTrail(head: { tick: number; direction: Direction; segments: Segment[] }, turns: Turn[], now: number, speed: number, width: number): Segment[] {
    if (!head.segments.length) return [];
    const result: Segment[] = head.segments.map(s => [[...s[0]], [...s[1]]]);
    let tick = head.tick, direction = head.direction;
    const endTick = Math.max(head.tick, Math.min(now, head.tick + maxPredictionTicks));
    const advance = (target: number) => {
        const vector = directionToVector(direction), end = result[result.length - 1][1];
        end[0] += vector[0] * speed * (target - tick) / tickRate;
        end[1] += vector[1] * speed * (target - tick) / tickRate;
        tick = target;
    };
    for (const turn of turns) {
        if (turn.t > endTick || !canTurn(direction, turn.d)) continue;
        // Unacknowledged turns can precede the anchor: match the server's segment-bounded rewind.
        const last = result[result.length - 1];
        const length = Math.hypot(last[1][0] - last[0][0], last[1][1] - last[0][1]);
        advance(Math.max(turn.t, tick - Math.min(maxPredictionTicks, length / speed * tickRate)));
        const start = turnStart(last[1], direction, turn.d, width);
        result.push([start, [...start]]);
        direction = turn.d;
    }
    advance(endTick);
    return result;
}
