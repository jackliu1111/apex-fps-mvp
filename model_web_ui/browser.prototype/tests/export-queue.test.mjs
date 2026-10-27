import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportQueue } from '../export-queue.mjs';

const batch = (id, clips = [{ start: 10, end: 15 }]) => ({ id, sourceId: 'source', clips,
  audio: { trackIndex: 1 }, output: { videoBitrate: 2000, audioBitrate: 1000 } });
const converted = ({ clip, index }) => ({ name: `${index}.webm`, blob: new Blob(['video']),
  start: clip.start, end: clip.end, measuredDuration: clip.end - clip.start });

test('a queued batch keeps submitted ranges and sound settings while analysis delays execution', async () => {
  let ready = false;
  const queue = createExportQueue({ canRun: () => ready, convert: async (request) => ({ ...converted(request), audioIndex: request.batch.audio.trackIndex }) });
  const submitted = batch('first');
  queue.enqueue(submitted, { file: new Blob(['source']) });
  submitted.clips[0].start = 12; submitted.audio.trackIndex = 0;
  await queue.whenIdle();
  assert.equal(queue.getBatch('first').status, 'queued');
  ready = true; queue.pump(); await queue.whenIdle();
  const finished = queue.getBatch('first');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.outputs[0].start, 10);
  assert.equal(finished.outputs[0].audioIndex, 1);
  assert.equal(finished.outputs[0].saved, false);
  await queue.dispose();
});

test('cancelling one running batch leaves the following batch able to complete', async () => {
  const started = Promise.withResolvers();
  const queue = createExportQueue({ convert: async (request) => {
    if (request.batch.id === 'cancel') {
      started.resolve();
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    }
    return converted(request);
  } });
  queue.enqueue(batch('cancel'), { file: new Blob(['source']) });
  queue.enqueue(batch('next'), { file: new Blob(['source']) });
  await started.promise; queue.cancel('cancel'); await queue.whenIdle();
  assert.equal(queue.getBatch('cancel').status, 'cancelled');
  assert.equal(queue.getBatch('next').status, 'completed');
  await queue.dispose();
});

test('downloadable outputs stay within budget and evicted links are marked unavailable', async () => {
  const queue = createExportQueue({ maxMemoryBytes: 100000,
    convert: async (request) => ({ ...converted(request), blob: new Blob([new Uint8Array(60000)]) }) });
  queue.enqueue(batch('first'), { file: new Blob(['source']) }); await queue.whenIdle();
  assert.equal(queue.getBatch('first').outputs[0].available, true);
  queue.enqueue(batch('second'), { file: new Blob(['source']) }); await queue.whenIdle();
  assert.equal(queue.getBatch('first').outputs[0].available, false);
  assert.equal(queue.getBatch('first').outputs[0].url, null);
  assert.equal(queue.getBatch('second').outputs[0].available, true);
  await queue.dispose();
});

test('an oversized batch requires a directory before any conversion starts', async () => {
  const queue = createExportQueue({ convert: async () => { throw new Error('must not execute'); } });
  const large = { ...batch('large', [{ start: 0, end: 3600 }]), output: {} };
  assert.throws(() => queue.enqueue(large, { file: new Blob(['source']) }), /先选择输出目录/);
  assert.equal(queue.getBatch('large'), null);
  await queue.dispose();
});

test('a codec failure is recorded for that batch and later exports remain usable', async () => {
  const queue = createExportQueue({ convert: async (request) => {
    if (request.batch.id === 'bad') throw new Error('unsupported codec');
    return converted(request);
  } });
  queue.enqueue(batch('bad'), { file: new Blob(['source']) });
  queue.enqueue(batch('good'), { file: new Blob(['source']) }); await queue.whenIdle();
  assert.equal(queue.getBatch('bad').status, 'failed');
  assert.equal(queue.getBatch('bad').error, 'unsupported codec');
  assert.equal(queue.getBatch('good').status, 'completed');
  await queue.dispose();
});
