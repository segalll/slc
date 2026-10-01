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
        trail = motion.trailAt(clock.sample(now));
    }
    assert.ok(trail[0][1][0] > 0.27, 'the remote player should have a visible growing trail');
});

test('stopping finishes buffered movement smoothly and then remains stationary', () => {
    const motion = new MotionHistory();
    motion.snapshot(head(0.49), 98);
    motion.snapshot(head(0.5), 100);
    const before = motion.trailAt(99).at(-1)[1];
    motion.snapshot(head(0.505), 101);
    motion.snapshot(head(0.505), 107);
    assert.deepEqual(motion.trailAt(99).at(-1)[1], before);
    for (const tick of [100, 100.5, 101]) {
        assert.ok(Math.abs(motion.trailAt(tick).at(-1)[1][0] - (0.5 + (tick - 100) * 0.005)) < 1e-9);
    }
    for (const tick of [102, 105, 107, 110]) {
        assert.deepEqual(motion.trailAt(tick).at(-1)[1], [0.505, 0]);
    }
});

test('a death snapshot approaches the collision point without jumping', () => {
    const motion = new MotionHistory();
    motion.snapshot(head(0.49), 98);
    motion.snapshot({ ...head(0.5), dead: true }, 100);
    assert.deepEqual(motion.trailAt(99).at(-1)[1], [0.495, 0]);
    motion.snapshot({ ...head(0.5), dead: true }, 106);
    assert.deepEqual(motion.trailAt(103).at(-1)[1], [0.5, 0]);
});

test('interpolation follows the trail across a corner instead of cutting diagonally', () => {
    const motion = new MotionHistory();
    motion.snapshot(head(0.1), 100);
    motion.snapshot({ ...head(0), segmentIndex: 1, direction: 0,
        segments: [[[0, 0], [0.2, 0]], [[0.2, 0], [0.2, 0.1]]] }, 140);
    const [x, y] = motion.trailAt(110).at(-1)[1];
    assert.ok(Math.abs(x - 0.15) < 1e-9);
    assert.equal(y, 0);
});
