import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
    entryPoints: ['src/client/motion.ts'], bundle: true, format: 'esm', write: false
});
const { MotionHistory, PlayoutClock } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
);
const head = x => ({ index: 1, segmentIndex: 0, direction: 1, dead: false,
    segments: [[[0, 0], [x, 0]]] });

test('frames before the first snapshot do not anchor playout to tick zero', () => {
    const clock = new PlayoutClock();
    for (let now = 0; now < 1000; now += 16) clock.sample(now);
    clock.observe(6000, 1000);
    const tick = clock.sample(1000);
    assert.ok(tick >= 5994 && tick <= 6000, `render tick ${tick} should be near the server`);
});

test('remote trails remain visible when rendering starts before snapshots arrive', () => {
    const clock = new PlayoutClock(), motion = new MotionHistory();
    clock.sample(1000);
    let trail;
    for (let tick = 6000; tick <= 6060; tick++) {
        const now = 1017 + (tick - 6000) * 1000 / 60;
        clock.observe(tick, now);
        motion.snapshot(head((tick - 6000) * 0.3 / 60), tick);
        trail = motion.trailAt(clock.sample(now), 0.3);
    }
    assert.ok(trail[0][1][0] > 0.27, 'the remote player should have a visible growing trail');
});

test('paused trails use the final position without replaying buffered movement', () => {
    const motion = new MotionHistory();
    motion.snapshot(head(0.1), 100);
    motion.snapshot(head(0.2), 120);
    motion.snapshot(head(0.3), 140);
    for (const tick of [100, 115, 130, 140, 150]) {
        assert.deepEqual(motion.trailAt(tick, 0)[0][1], [0.3, 0]);
    }
});
