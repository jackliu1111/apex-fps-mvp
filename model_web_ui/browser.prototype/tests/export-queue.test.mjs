import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserConverter } from '../browser-export.mjs';
import { createExportQueue } from '../export-queue.mjs';

const batch = (id, clips = [{ start: 10, end: 15 }]) => ({ id, sourceId: 'source', clips,
  audio: { trackIndex: 1 }, output: { videoBitrate: 2000, audioBitrate: 1000 } });
const converted = ({ clip, index }) => ({ name: `${index}.webm`, saved: true, bytes: 5,
  start: clip.start, end: clip.end, measuredDuration: clip.end - clip.start });

test('a queued batch keeps submitted ranges and sound settings while analysis delays execution', async () => {
  let ready = false;
  const queue = createExportQueue({ canRun: () => ready, convert: async (request) => ({ ...converted(request), audioIndex: request.batch.audio.trackIndex }) });
  const submitted = batch('first');
  queue.enqueue(submitted, { file: new Blob(['source']), directoryHandle: {} });
  submitted.clips[0].start = 12; submitted.audio.trackIndex = 0;
  await queue.whenIdle();
  assert.equal(queue.getBatch('first').status, 'queued');
  ready = true; queue.pump(); await queue.whenIdle();
  const finished = queue.getBatch('first');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.outputs[0].start, 10);
  assert.equal(finished.outputs[0].audioIndex, 1);
  assert.equal(finished.outputs[0].saved, true);
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
  queue.enqueue(batch('cancel'), { file: new Blob(['source']), directoryHandle: {} });
  queue.enqueue(batch('next'), { file: new Blob(['source']), directoryHandle: {} });
  await started.promise; queue.cancel('cancel'); await queue.whenIdle();
  assert.equal(queue.getBatch('cancel').status, 'cancelled');
  assert.equal(queue.getBatch('next').status, 'completed');
  await queue.dispose();
});

test('a codec failure is recorded for that batch and later exports remain usable', async () => {
  const queue = createExportQueue({ convert: async (request) => {
    if (request.batch.id === 'bad') throw new Error('unsupported codec');
    return converted(request);
  } });
  queue.enqueue(batch('bad'), { file: new Blob(['source']), directoryHandle: {} });
  queue.enqueue(batch('good'), { file: new Blob(['source']), directoryHandle: {} }); await queue.whenIdle();
  assert.equal(queue.getBatch('bad').status, 'failed');
  assert.equal(queue.getBatch('bad').error, 'unsupported codec');
  assert.equal(queue.getBatch('good').status, 'completed');
  await queue.dispose();
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
  queue.enqueue(batch('partial', [{ start: 10, end: 15 }, { start: 20, end: 25 }, { start: 30, end: 35 }]), { file: new Blob(['source']), directoryHandle: {} });
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
  queue.enqueue(batch('partial', [{ start: 10, end: 15 }, { start: 20, end: 25 }, { start: 30, end: 35 }]), { file: new Blob(['source']), directoryHandle: {} });
  await started.promise; queue.cancel('partial'); await queue.whenIdle();
  assert.deepEqual(queue.getBatch('partial').clipResults.map((clip) => clip.status), ['completed', 'cancelled', 'not-started']);
  assert.equal(queue.getBatch('partial').outputs[0].available, true);
  await queue.dispose();
});


test('even a short batch waits for a directory instead of publishing a download', async () => {
  const queue = createExportQueue({ convert: async request => converted(request) });
  queue.enqueue(batch('waiting'), { file: new Blob(['source']) });
  await queue.whenIdle();
  assert.equal(queue.getBatch('waiting').status, 'awaiting-destination');
  assert.deepEqual(queue.getBatch('waiting').outputs, []);
  queue.cancel('waiting');
  assert.equal(queue.getBatch('waiting').status, 'cancelled');
  await queue.dispose();
});


test('a directory job cannot publish a result that was not saved', async () => {
  const queue = createExportQueue({ convert: async request => ({ name: 'unsaved.webm', saved: false, bytes: 5 }) });
  queue.enqueue(batch('unsaved'), { file: new Blob(['source']), directoryHandle: {} });
  await queue.whenIdle();
  assert.equal(queue.getBatch('unsaved').status, 'failed');
  assert.deepEqual(queue.getBatch('unsaved').outputs, []);
  await queue.dispose();
});


// Browser codec and filesystem adapters; the queue and converter are real.
function directory(name, afterClose = () => {}, { writeError, cleanupError } = {}) {
  const files = new Map();
  return { name, permission: 'granted', files,
    async queryPermission() { return this.permission; },
    async getFileHandle(filename, { create = false } = {}) {
      if (this.permission !== 'granted') throw new DOMException('Directory access lost', 'NotAllowedError');
      if (!files.has(filename)) {
        if (!create) throw new DOMException('Missing', 'NotFoundError');
        files.set(filename, new File([], filename));
      }
      return { async getFile() { return files.get(filename); }, async createWritable() {
        let data;
        return { async write(chunk) { if (writeError) throw writeError; data = chunk.data; }, async abort() {},
          async close() { files.set(filename, new File([data], filename, { lastModified: 100 })); afterClose(); } };
      } };
    },
    async removeEntry(filename) { if (cleanupError) throw cleanupError; files.delete(filename); },
  };
}
function browserConverter() {
  const video = { displayWidth: 640, displayHeight: 360 }, audio = { id: 1 };
  const MB = {
    ALL_FORMATS: [], BlobSource: class {}, Input: class {
      async getPrimaryVideoTrack() { return video; }
      async getAudioTracks() { return [audio, audio]; }
      async getPrimaryAudioTrack() { return audio; }
      async computeDuration() { return 5; }
      dispose() {}
    },
    Mp4OutputFormat: class {}, StreamTarget: class { constructor(writable) { this.writable = writable; } },
    Output: class { constructor(options) { Object.assign(this, options); } },
    Conversion: { async init({ output }) { return { isValid: true, discardedTracks: [],
      async execute() { const writer = output.target.writable.getWriter(); await writer.write({ position: 0, data: new Uint8Array([1, 2, 3]) }); await writer.close(); },
      async cancel() {},
    }; } },
  };
  let sequence = 0;
  return createBrowserConverter({ MB, makeId: () => String(++sequence) });
}

test('a waiting batch resumes into the chosen directory with its submitted ranges', async () => {
  const queue = createExportQueue({ convert: browserConverter() }), target = directory('Chosen');
  const submitted = batch('resume');
  queue.enqueue(submitted, { file: new File(['source'], 'source.mp4') });
  submitted.clips[0].start = 12;
  queue.resume('resume', target); await queue.whenIdle();
  const result = queue.getBatch('resume');
  assert.equal(result.status, 'completed');
  assert.equal(result.outputs[0].start, 10);
  assert.deepEqual(result.outputs[0].destination, { mode: 'directory', name: 'Chosen' });
  assert.equal(target.files.size, 1);
  await queue.dispose();
});

test('revoked directory permission pauses remaining clips and reselection preserves saved destinations', async () => {
  const original = directory('Original', () => { original.permission = 'denied'; });
  const replacement = directory('Replacement');
  const queue = createExportQueue({ convert: browserConverter() });
  queue.enqueue(batch('partial permission', [{ start: 10, end: 15 }, { start: 20, end: 25 }]), {
    file: new File(['source'], 'source.mp4'), directoryHandle: original,
  });
  await queue.whenIdle();
  const waiting = queue.getBatch('partial permission');
  assert.equal(waiting.status, 'awaiting-destination');
  assert.deepEqual(waiting.clipResults.map(clip => clip.status), ['completed', 'not-started']);
  queue.resume('partial permission', replacement); await queue.whenIdle();
  const completed = queue.getBatch('partial permission');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.outputs.map(output => [output.start, output.destination.name]), [[10, 'Original'], [20, 'Replacement']]);
  assert.equal(original.files.size, 1);
  assert.equal(replacement.files.size, 1);
  await queue.dispose();
});

test('bounded reuse records can be released without deleting saved files or their history', async () => {
  const target = directory('Archive'), file = new File(['source'], 'source.mp4');
  const queue = createExportQueue({ convert: browserConverter() });
  for (let index = 0; index < 129; index++) {
    queue.enqueue(batch(`saved-${index}`, [{ start: index * 5, end: index * 5 + 5 }]), { file, directoryHandle: target });
    await queue.whenIdle();
  }
  const first = queue.getBatch('saved-0');
  assert.equal(first.status, 'completed');
  assert.equal(first.outputs[0].saved, true);
  assert.equal(first.outputs[0].available, false, 'The evicted index no longer verifies file availability');
  assert.equal(target.files.size, 129);
  assert.ok(target.files.has(first.outputs[0].name));
  assert.equal('url' in first.outputs[0], false);
  await queue.dispose();
  assert.equal(target.files.size, 129);
});

test('cancelling while awaiting a replacement directory retains completed files and stops remaining work', async () => {
  const target = directory('Original', () => { target.permission = 'denied'; });
  const queue = createExportQueue({ convert: browserConverter() });
  queue.enqueue(batch('pause then cancel', [{ start: 10, end: 15 }, { start: 20, end: 25 }]), {
    file: new File(['source'], 'source.mp4'), directoryHandle: target,
  });
  await queue.whenIdle();
  assert.equal(queue.getBatch('pause then cancel').status, 'awaiting-destination');
  queue.cancel('pause then cancel');
  queue.resume('pause then cancel', directory('Unused')); await queue.whenIdle();
  const result = queue.getBatch('pause then cancel');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].saved, true);
  assert.equal(target.files.size, 1);
  assert.deepEqual(result.clipResults.map(clip => clip.status), ['completed', 'not-started']);
  await queue.dispose();
});


test('cleanup warnings survive successful reselection and preserve every leftover file location', async () => {
  const queue = createExportQueue({ convert: browserConverter() });
  const blocked = name => directory(name, undefined, {
    writeError: new DOMException('WRITE_DENIED', 'NotAllowedError'), cleanupError: new Error('REMOVE_DENIED'),
  });
  const first = blocked('First'), second = blocked('Second'), destination = directory('Saved');
  queue.enqueue(batch('cleanup'), { file: new File(['source'], 'source.mp4'), directoryHandle: first });
  await queue.whenIdle();
  assert.equal(queue.getBatch('cleanup').status, 'awaiting-destination');
  queue.resume('cleanup', second); await queue.whenIdle();
  queue.resume('cleanup', destination); await queue.whenIdle();
  const result = queue.getBatch('cleanup');
  assert.equal(result.status, 'completed');
  assert.equal(result.outputs[0].saved, true);
  const warnings = result.clipResults[0].cleanupWarnings;
  assert.equal(warnings?.length, 2);
  assert.match(warnings[0], /WRITE_DENIED.*REMOVE_DENIED.*First\/source-01-1.mp4/);
  assert.match(warnings[1], /WRITE_DENIED.*REMOVE_DENIED.*Second\/source-01-2.mp4/);
  assert.equal(first.files.size, 1);
  assert.equal(second.files.size, 1);
  await queue.dispose();
});

test('an unavailable permission query waits for reselection and preserves its error', async () => {
  const target = directory('Offline');
  target.queryPermission = async () => { throw new Error('VOLUME_UNAVAILABLE'); };
  const queue = createExportQueue({ convert: browserConverter() });
  queue.enqueue(batch('offline'), { file: new File(['source'], 'source.mp4'), directoryHandle: target });
  await queue.whenIdle();
  const waiting = queue.getBatch('offline');
  assert.equal(waiting.status, 'awaiting-destination');
  assert.match(waiting.error, /VOLUME_UNAVAILABLE/);
  assert.deepEqual(waiting.outputs, []);
  queue.resume('offline', directory('Available')); await queue.whenIdle();
  assert.equal(queue.getBatch('offline').status, 'completed');
  await queue.dispose();
});

test('cancelling a resumed batch settles while its permission query is pending and cannot revive later', { timeout: 1000 }, async () => {
  const pending = Promise.withResolvers(), queried = Promise.withResolvers();
  const target = directory('Pending');
  target.queryPermission = () => { queried.resolve(); return pending.promise; };
  const queue = createExportQueue({ convert: browserConverter() });
  queue.enqueue(batch('cancel query'), { file: new File(['source'], 'source.mp4') });
  queue.resume('cancel query', target);
  await queried.promise;
  queue.cancel('cancel query'); await queue.whenIdle();
  assert.equal(queue.getBatch('cancel query').status, 'cancelled');
  pending.resolve('granted');
  queue.resume('cancel query', directory('Unused')); await queue.whenIdle();
  assert.equal(queue.getBatch('cancel query').status, 'cancelled');
  assert.deepEqual(queue.getBatch('cancel query').outputs, []);
  assert.equal(target.files.size, 0);
  await queue.dispose();
});
