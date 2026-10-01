import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
    entryPoints: ['src/shared/movement.ts'], bundle: true, format: 'esm', write: false
});
const { predictTrail } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
);
const head = { tick: 100, direction: 1, segments: [[[0, 0], [0.45, 0]]] };
const line = x => [[x, -0.5], [x, 0.5]];

test('prediction stops at the nearest known trail, accounting for line width', () => {
    const predicted = predictTrail(head, [], 115, 0.3, 0.002, [[line(0.52), line(0.5)]]);
    assert.ok(Math.abs(predicted.at(-1)[1][0] - 0.498) < 1e-9);
    assert.equal(head.segments[0][1][0], 0.45, 'prediction must not change the authoritative trail');
});

test('prediction cannot turn after reaching a known collision', () => {
    const predicted = predictTrail(head, [{ s: 1, d: 0, t: 114 }], 115, 0.3, 0.002, [[line(0.5)]]);
    assert.equal(predicted.length, 1);
    assert.ok(Math.abs(predicted[0][1][0] - 0.498) < 1e-9);
});

test('a turn before the collision can still avoid the trail', () => {
    const predicted = predictTrail(head, [{ s: 1, d: 0, t: 104 }], 110, 0.3, 0.002, [[line(0.5)]]);
    assert.equal(predicted.length, 2);
    assert.ok(Math.abs(predicted[1][1][0] - 0.468) < 1e-9);
    assert.ok(Math.abs(predicted[1][1][1] - 0.032) < 1e-9);
});

test('nearby trails off the movement path do not stop prediction', () => {
    const predicted = predictTrail(head, [], 110, 0.3, 0.002, [[[[0.5, 0.1], [0.5, 0.5]]]]);
    assert.equal(predicted.at(-1)[1][0], 0.5);
});

test('parallel trails can collide through their combined width', () => {
    const predicted = predictTrail(head, [], 115, 0.3, 0.002, [[[[0.5, 0.003], [0.6, 0.003]]]]);
    assert.ok(Math.abs(predicted.at(-1)[1][0] - 0.5) < 1e-9);
});
