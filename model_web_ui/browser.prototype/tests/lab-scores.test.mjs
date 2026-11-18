import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameOverlap, ScoreStatistics, displayWeights } from '../../../site/lab-scores.mjs';

test('overlap publishes each original frame once, averages overlap, clips tail', () => {
  const accumulator = new FrameOverlap(2, 7, 4, 2);
  const fill = p => new Float32Array(8).fill(p);
  const blocks = [accumulator.push(fill(.2), false), accumulator.push(fill(.6), false), accumulator.push(fill(.8), true)];
  assert.deepEqual(blocks.map(x => [x.startFrame, x.frameCount]), [[0, 2], [2, 2], [4, 3]]);
  const rows = blocks.flatMap(b => [...b.values]);
  [.2, .2, .4, .4, .7, .7, .8].forEach((p, i) => assert.ok(Math.abs(rows[i * 2] - p) < 1e-6));
  assert.equal(accumulator.cursor, 7);
});
test('visual softmax does not invent a class below threshold or mutate probabilities', () => {
  const raw = new Float32Array([.9, .3, .1]), copy = raw.slice();
  const selected = displayWeights(raw, .2);
  assert.equal(selected.length, 2); assert.ok(Math.abs(selected.reduce((n, x) => n + x.weight, 0) - 1) < 1e-10);
  assert.deepEqual(raw, copy); assert.deepEqual(displayWeights(raw, .95), []);
  assert.equal(displayWeights([.3], .2)[0].weight, 1);
});
test('statistics clips last frame duration, keeps segments across chunks and cooccurrences', () => {
  const stats = new ScoreStatistics(['a', 'b'], .5, .04, .14);
  stats.add({ startFrame: 0, frameCount: 2, values: new Float32Array([.7, .1, .8, .6]) });
  stats.add({ startFrame: 2, frameCount: 2, values: new Float32Array([.9, .7, .1, .8]) });
  const report = stats.report(), a = report.rows.find(x => x.id === 0), b = report.rows.find(x => x.id === 1);
  assert.equal(a.segments, 1); assert.equal(b.segments, 1);
  assert.ok(Math.abs(a.coveredSeconds - .12) < 1e-9); assert.ok(Math.abs(b.coveredSeconds - .10) < 1e-9);
  assert.ok(Math.abs(report.cooccurrence[0].seconds - .08) < 1e-9);
  assert.throws(() => stats.add({ startFrame: 0, frameCount: 0, values: [] }), /Non-contiguous/);
});
