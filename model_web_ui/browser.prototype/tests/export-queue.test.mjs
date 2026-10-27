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

test('matching available outputs are reused without requiring the encoder again', async () => {
  const file = new Blob(['same recording']); let encoderAvailable = true;
  const queue = createExportQueue({ convert: async (request) => {
    if (!encoderAvailable) throw new Error('encoder offline');
    return converted(request);
  } });
  queue.enqueue(batch('original'), { file }); await queue.whenIdle();
  encoderAvailable = false;
  queue.enqueue(batch('again'), { file }); await queue.whenIdle();
  assert.equal(queue.getBatch('again').status, 'completed');
  assert.equal(queue.getBatch('again').outputs[0].url, queue.getBatch('original').outputs[0].url);
  assert.equal(queue.getBatch('again').outputs[0].reused, true);
  for (const [id, changes, changedFile] of [
    ['range', { clips: [{ start: 11, end: 15 }] }],
    ['sound', { audio: { trackIndex: 0 } }],
    ['settings', { output: { width: 640, videoBitrate: 2000, audioBitrate: 1000 } }],
    ['source', {}, new Blob(['different recording'])],
  ]) {
    queue.enqueue({ ...batch(id), ...changes }, { file: changedFile || file }); await queue.whenIdle();
    assert.equal(queue.getBatch(id).status, 'failed', `${id} must not use an unrelated artifact`);
  }
  queue.enqueue(batch('disk destination'), { file, directoryHandle: {} }); await queue.whenIdle();
  assert.equal(queue.getBatch('disk destination').status, 'failed', 'A download artifact cannot claim to have been saved to a directory');
  await queue.dispose();
});

test('evicting a reused artifact invalidates every referring batch and revokes its URL once', async () => {
  const file = new Blob(['same recording']), notices = [], revoked = [];
  let sequence = 0;
  const queue = createExportQueue({ maxMemoryBytes: 100000,
    urls: { createObjectURL: () => `blob:${++sequence}`, revokeObjectURL: (url) => revoked.push(url) },
    onChange: (state) => notices.push(state),
    convert: async (request) => ({ ...converted(request), blob: new Blob([new Uint8Array(60000)]) }),
  });
  queue.enqueue(batch('original'), { file }); await queue.whenIdle();
  queue.enqueue(batch('shared'), { file }); await queue.whenIdle();
  const originalURL = queue.getBatch('original').outputs[0].url;
  queue.enqueue(batch('different', [{ start: 20, end: 25 }]), { file }); await queue.whenIdle();
  for (const id of ['original', 'shared']) {
    assert.equal(queue.getBatch(id).outputs[0].available, false);
    assert.equal(queue.getBatch(id).outputs[0].url, null);
    assert.ok(notices.some((state) => state.id === id && state.outputs[0]?.available === false));
  }
  assert.deepEqual(revoked, [originalURL]);
  await queue.dispose();
  assert.deepEqual(revoked, [originalURL, 'blob:2']);
});

test('saved outputs are reused only while the same destination file still matches its completed identity', async () => {
  const file = new Blob(['recording']), directoryHandle = {}, original = new File(['video'], 'completed.webm', { lastModified: 10 });
  let onDisk = original, encoderAvailable = true;
  const fileHandle = { getFile: async () => onDisk };
  const queue = createExportQueue({ convert: async (request) => {
    if (!encoderAvailable) throw new Error('encoder offline');
    const { blob, ...output } = converted(request);
    return { ...output, bytes: original.size, saved: true, artifact: { fileHandle, size: original.size, lastModified: original.lastModified } };
  } });
  queue.enqueue(batch('original'), { file, directoryHandle }); await queue.whenIdle(); encoderAvailable = false;
  queue.enqueue(batch('shared'), { file, directoryHandle }); await queue.whenIdle();
  assert.equal(queue.getBatch('shared').status, 'completed');
  assert.equal(queue.getBatch('shared').outputs[0].reused, true);
  assert.equal('artifact' in queue.getBatch('shared').outputs[0], false, 'Runtime file handles never enter persistable output metadata');
  queue.enqueue(batch('different destination'), { file, directoryHandle: {} }); await queue.whenIdle();
  assert.equal(queue.getBatch('different destination').status, 'failed');
  onDisk = new File(['changed'], 'completed.webm', { lastModified: 11 });
  queue.enqueue(batch('changed'), { file, directoryHandle }); await queue.whenIdle();
  assert.equal(queue.getBatch('changed').status, 'failed');
  assert.equal(queue.getBatch('original').outputs[0].available, false);
  assert.equal(queue.getBatch('shared').outputs[0].available, false);
  await queue.dispose();
});

test('partial failure identifies the failed clip and preserves completed and not-started outcomes', async () => {
  const queue = createExportQueue({ convert: async (request) => {
    if (request.clip.start === 20) throw new Error('unsupported frame');
    return converted(request);
  } });
  queue.enqueue(batch('partial', [{ start: 10, end: 15 }, { start: 20, end: 25 }, { start: 30, end: 35 }]), { file: new Blob(['source']) });
  await queue.whenIdle();
  const result = queue.getBatch('partial');
  assert.deepEqual(result.clipResults?.map((clip) => clip.status), ['completed', 'failed', 'not-started']);
  assert.equal(result.clipResults[1].error, 'unsupported frame');
  assert.equal(result.outputs[0].available, true);
  await queue.dispose();
});

test('cancelling a partial export marks the active clip cancelled and leaves its remainder not started', async () => {
  const started = Promise.withResolvers();
  const queue = createExportQueue({ convert: async (request) => {
    if (request.clip.start === 20) {
      started.resolve();
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    }
    return converted(request);
  } });
  queue.enqueue(batch('partial', [{ start: 10, end: 15 }, { start: 20, end: 25 }, { start: 30, end: 35 }]), { file: new Blob(['source']) });
  await started.promise; queue.cancel('partial'); await queue.whenIdle();
  assert.deepEqual(queue.getBatch('partial').clipResults.map((clip) => clip.status), ['completed', 'cancelled', 'not-started']);
  assert.equal(queue.getBatch('partial').outputs[0].available, true);
  await queue.dispose();
});
