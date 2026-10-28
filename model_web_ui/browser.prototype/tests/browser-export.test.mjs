import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserConverter } from '../browser-export.mjs';

function mediaFixture({ hang = false, format = 'webm' } = {}) {
  const selected = [], closed = [];
  const begun = Promise.withResolvers();
  const video = { id: 0, displayWidth: 1920, displayHeight: 1080 };
  const tracks = [{ id: 10 }, { id: 20 }];
  const MB = {
    ALL_FORMATS: [], BlobSource: class { constructor(file) { this.file = file; } },
    Input: class {
      async getPrimaryVideoTrack() { return video; }
      async getPrimaryAudioTrack() { return tracks[0]; }
      async getAudioTracks() { return tracks; }
      async computeDuration() { return 5.02; }
      dispose() { closed.push('input'); }
    },
    WebMOutputFormat: class {}, Mp4OutputFormat: class { constructor(options) { assert.equal(options.fastStart, false); } },
    StreamTarget: class { constructor(writable) { this.writable = writable; } },
    Output: class { constructor(options) { Object.assign(this, options); } },
    Conversion: { async init(options) {
      for (const track of tracks) if (!options.audio(track).discard) selected.push(track.id);
      let writer;
      return { isValid: true, discardedTracks: [],
        async execute() {
          writer = options.output.target.writable.getWriter(); begun.resolve();
          if (hang) return new Promise(() => {});
          await writer.write({ position: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
          await writer.write({ position: 2, data: new Uint8Array([9, 8]) });
          await writer.close();
        },
        async cancel() { await writer?.close(); },
      };
    } },
  };
  const convert = createBrowserConverter({ MB, makeId: () => 'unique' });
  const request = { batch: { id: 'batch', audio: { trackIndex: 1 }, output: { format } },
    clip: { start: 10, end: 15 }, source: { file: new File(['source'], 'recording.mkv') }, index: 0,
    signal: new AbortController().signal, memoryBudgetBytes: 10000 };
  return { convert, request, selected, begun, closed };
}

function directoryFixture() {
  const files = new Map(), removed = [], writes = [];
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return new File([files.get(name)], name, { type: 'video/webm' }); },
        async createWritable() {
          let pending = new Uint8Array();
          return {
            async write({ type, position, data }) {
              assert.equal(type, 'write'); writes.push({ position, size: data.byteLength });
              if (pending.length < position + data.length) { const larger = new Uint8Array(position + data.length); larger.set(pending); pending = larger; }
              pending.set(data, position);
            },
            async close() { files.set(name, pending); }, async abort() {},
          };
        },
      };
    },
    async removeEntry(name) { removed.push(name); files.delete(name); },
  };
  return { directory, files, removed, writes };
}

test('browser conversion uses frozen sound choice and reads back measured duration separately', async () => {
  const { convert, request, selected } = mediaFixture();
  const output = await convert(request);
  assert.deepEqual(selected, [20]);
  assert.deepEqual([...new Uint8Array(await output.blob.arrayBuffer())], [1, 2, 9, 8, 5, 6]);
  assert.equal(output.requestedDuration, 5);
  assert.equal(output.measuredDuration, 5.02);
  assert.equal(output.saved, false);
  assert.equal(output.actualRange, null);
});

test('cancellation settles even when the codec execute promise never settles', { timeout: 1000 }, async () => {
  const { convert, request, begun } = mediaFixture({ hang: true });
  const controller = new AbortController(); request.signal = controller.signal;
  const running = convert(request);
  await begun.promise; controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
});

test('directory export streams positioned writes and reports saved only after closing the new file', async () => {
  const { convert, request } = mediaFixture();
  const { directory, files, writes } = directoryFixture(); request.source.directoryHandle = directory;
  request.memoryBudgetBytes = 1;
  const output = await convert(request);
  assert.equal(output.saved, true);
  assert.equal(output.blob, undefined);
  assert.deepEqual([...files.get(output.name)], [1, 2, 9, 8, 5, 6]);
  assert.deepEqual(writes, [{ position: 0, size: 6 }, { position: 2, size: 2 }]);
});

test('directory export chooses a fresh name and cancellation cleans only its own partial file', async () => {
  const { convert, request, begun } = mediaFixture({ hang: true });
  const { directory, files, removed } = directoryFixture(); request.source.directoryHandle = directory;
  files.set('recording-01-unique.webm', new Uint8Array([77]));
  const controller = new AbortController(); request.signal = controller.signal;
  const pending = convert(request); await begun.promise; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual([...files.get('recording-01-unique.webm')], [77]);
  assert.deepEqual(removed, ['recording-01-unique-1.webm']);
  assert.equal(files.size, 1);
});

test('actual encoded bytes cannot exceed the memory budget even when the estimate was smaller', async () => {
  const { convert, request } = mediaFixture(); request.memoryBudgetBytes = 5;
  await assert.rejects(convert(request), /超出下载缓存预算/);
});


test('MP4 uses its own MIME type and avoids overwriting an existing MP4 file', async () => {
  const { convert, request } = mediaFixture({ format: 'mp4' });
  const memory = await convert(request);
  assert.equal(memory.blob.type, 'video/mp4');
  assert.equal(memory.name, 'recording-01-unique.mp4');
  const { directory, files } = directoryFixture();
  files.set(memory.name, new Uint8Array([77]));
  request.source.directoryHandle = directory;
  const disk = await convert(request);
  assert.equal(disk.name, 'recording-01-unique-1.mp4');
  assert.deepEqual([...files.get(memory.name)], [77]);
  assert.equal(disk.saved, true);
});
