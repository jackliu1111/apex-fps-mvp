import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserConverter } from '../browser-export.mjs';
import { createExportQueue } from '../export-queue.mjs';

function mediaFixture({ hang = false, format = 'webm', executeError = null, probeDuration = async () => 5.02, queuedWrites = null, maxBufferedBytes, afterCloseError = null, onExecute = () => {}, maskWriteError = false } = {}) {
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
      async computeDuration() { return probeDuration(); }
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
          writer = options.output.target.writable.getWriter(); begun.resolve(); onExecute();
          if (hang) return new Promise(() => {});
          if (executeError) throw executeError;
          if (queuedWrites) { await Promise.all(queuedWrites.map((data, i) => writer.write({ position: i * data.length, data }))); await writer.close(); return; }
          try { await writer.write({ position: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6]) }); }
          catch (error) { if (maskWriteError) throw new TypeError('Cannot close an ERRORED writable stream'); throw error; }
          await writer.write({ position: 2, data: new Uint8Array([9, 8]) });
          await writer.close();
          if (afterCloseError) throw afterCloseError;
        },
        async cancel() { await writer?.close(); },
      };
    } },
  };
  const convert = createBrowserConverter({ MB, makeId: () => 'unique', maxBufferedBytes });
  const request = { batch: { id: 'batch', audio: { trackIndex: 1 }, output: { format } },
    clip: { start: 10, end: 15 }, source: { file: new File(['source'], 'recording.mkv'), directoryHandle: directoryFixture().directory }, index: 0,
    signal: new AbortController().signal };
  return { convert, request, selected, begun, closed };
}

function directoryFixture({ onClose = async () => {}, readError = null, cleanupError = null, writeError = null, abortFailure = null } = {}) {
  const files = new Map(), removed = [], writes = [];
  const directory = {
    name: 'exports',
    async queryPermission() { return 'granted'; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { if (readError) throw readError; return new File([files.get(name)], name, { type: 'video/webm' }); },
        async createWritable() {
          let pending = new Uint8Array();
          return {
            async write({ type, position, data }) {
              if (writeError) throw writeError;
              assert.equal(type, 'write'); writes.push({ position, size: data.byteLength });
              if (pending.length < position + data.length) { const larger = new Uint8Array(position + data.length); larger.set(pending); pending = larger; }
              pending.set(data, position);
            },
            async close() { files.set(name, pending); await onClose(); }, async abort() { if (abortFailure) throw abortFailure; },
          };
        },
      };
    },
    async removeEntry(name) { if (cleanupError) throw cleanupError; removed.push(name); files.delete(name); },
  };
  return { directory, files, removed, writes };
}

test('browser conversion uses frozen sound choice and reads back measured duration separately', async () => {
  const { convert, request, selected } = mediaFixture();
  const output = await convert(request);
  assert.deepEqual(selected, [20]);
  assert.deepEqual([...new Uint8Array(await (await output.artifact.fileHandle.getFile()).arrayBuffer())], [1, 2, 9, 8, 5, 6]);
  assert.equal(output.requestedDuration, 5);
  assert.equal(output.measuredDuration, 5.02);
  assert.equal(output.saved, true);
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

test('every conversion requires a directory, including tiny clips', async () => {
  const { convert, request } = mediaFixture();
  delete request.source.directoryHandle;
  await assert.rejects(convert(request), /选择输出目录/);
});

test('MP4 uses its own file extension and avoids overwriting an existing MP4 file', async () => {
  const { convert, request } = mediaFixture({ format: 'mp4' });
  const first = await convert(request);
  assert.equal(first.name, 'recording-01-unique.mp4');
  const { directory, files } = directoryFixture();
  files.set(first.name, new Uint8Array([77]));
  request.source.directoryHandle = directory;
  const disk = await convert(request);
  assert.equal(disk.name, 'recording-01-unique-1.mp4');
  assert.deepEqual([...files.get(first.name)], [77]);
  assert.equal(disk.saved, true);
});


test('cancellation when the file closes preserves the saved output', async () => {
  const { convert, request } = mediaFixture();
  const controller = new AbortController(); request.signal = controller.signal;
  const { directory, files, removed } = directoryFixture({ onClose: async () => controller.abort() });
  request.source.directoryHandle = directory;
  const output = await convert(request);
  assert.equal(output.saved, true);
  assert.deepEqual([...files.get(output.name)], [1, 2, 9, 8, 5, 6]);
  assert.deepEqual(removed, []);
});


test('queue waits for an in-flight close before publishing the final saved result', async () => {
  const { convert, request } = mediaFixture();
  const closing = Promise.withResolvers(), finishClose = Promise.withResolvers();
  const { directory, files, removed } = directoryFixture({ onClose: async () => { closing.resolve(); await finishClose.promise; } });
  const states = [];
  const queue = createExportQueue({ convert, onChange: state => states.push(state) });
  queue.enqueue({ ...request.batch, clips: [request.clip] }, { ...request.source, directoryHandle: directory });
  await closing.promise;
  queue.cancel('batch');
  assert.equal(queue.getBatch('batch').status, 'running');
  assert.equal(queue.getBatch('batch').clipResults[0].status, 'running');
  finishClose.resolve(); await queue.whenIdle();
  const result = queue.getBatch('batch');
  assert.equal(result.status, 'completed');
  assert.equal(result.outputs[0].saved, true);
  assert.ok(files.has(result.outputs[0].name));
  assert.deepEqual(removed, []);
  assert.ok(states.every(state => state.status !== 'cancelled'));
  await queue.dispose();
});


test('a readback failure reports a saved file with a separate verification error', async () => {
  const { convert, request } = mediaFixture();
  const { directory, files, removed } = directoryFixture({ readError: new Error('READBACK_FAILED') });
  request.source.directoryHandle = directory;
  const output = await convert(request);
  assert.equal(output.saved, true);
  assert.equal(output.verificationError, 'READBACK_FAILED');
  assert.equal(output.measuredDuration, null);
  assert.equal(output.bytes, 6);
  assert.ok(files.has(output.name));
  assert.deepEqual(removed, []);
});


test('cleanup failure preserves the original encoder error and identifies the leftover file', async () => {
  const original = new Error('ENCODER_FAILED'), cleanup = new Error('REMOVE_FAILED');
  const { convert, request } = mediaFixture({ executeError: original });
  const { directory, files } = directoryFixture({ cleanupError: cleanup });
  request.source.directoryHandle = directory;
  await assert.rejects(convert(request), error => {
    assert.equal(error.cause, original);
    assert.equal(error.cleanupError, cleanup);
    assert.equal(error.partialFile, 'exports/recording-01-unique.webm');
    assert.match(error.message, /ENCODER_FAILED/);
    assert.match(error.message, /REMOVE_FAILED/);
    assert.match(error.message, /exports\/recording-01-unique.webm/);
    return true;
  });
  assert.ok(files.has('recording-01-unique.webm'));
});


test('revoked write permission requests a new destination even if cleanup also fails', async () => {
  const original = new DOMException('WRITE_DENIED', 'NotAllowedError');
  const { convert, request } = mediaFixture();
  const { directory } = directoryFixture({ writeError: original, cleanupError: new Error('REMOVE_DENIED') });
  request.source.directoryHandle = directory;
  await assert.rejects(convert(request), error => {
    assert.equal(error.needsDestination, true);
    assert.equal(error.cause, original);
    assert.match(error.message, /WRITE_DENIED/);
    assert.match(error.message, /REMOVE_DENIED/);
    assert.equal(error.partialFile, 'exports/recording-01-unique.webm');
    return true;
  });
});


test('cancelling a pending saved-file check promptly returns the saved result', { timeout: 1000 }, async () => {
  const checking = Promise.withResolvers();
  const { convert, request } = mediaFixture({ probeDuration: async () => { checking.resolve(); return new Promise(() => {}); } });
  const controller = new AbortController(); request.signal = controller.signal;
  const result = convert(request);
  await checking.promise; controller.abort(new DOMException('检查已取消', 'AbortError'));
  const output = await result;
  assert.equal(output.saved, true);
  assert.equal(output.measuredDuration, null);
  assert.match(output.verificationError, /检查已取消/);
  assert.equal((await output.artifact.fileHandle.getFile()).size, 6);
});


test('the in-flight write budget stops a producer that ignores disk backpressure', async () => {
  const { convert, request } = mediaFixture({ maxBufferedBytes: 8,
    queuedWrites: [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), new Uint8Array([9, 10, 11, 12])] });
  const { directory, files } = directoryFixture(); request.source.directoryHandle = directory;
  await assert.rejects(convert(request), /写入缓冲/);
  assert.equal(files.size, 0);
});


test('cancellation retains its original reason when aborting the writer fails but deletion succeeds', async () => {
  const { convert, request, begun } = mediaFixture({ hang: true });
  const { directory, files } = directoryFixture({ abortFailure: new Error('ABORT_FAILED') });
  request.source.directoryHandle = directory;
  const controller = new AbortController(); request.signal = controller.signal;
  const pending = convert(request);
  await begun.promise; controller.abort(new DOMException('用户取消', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError', message: '用户取消' });
  assert.equal(files.size, 0);
});


test('a codec finalization error after successful file close still publishes the saved result', async () => {
  const { convert, request } = mediaFixture({ afterCloseError: new Error('FINALIZE_FAILED_AFTER_SAVE') });
  const { directory, files, removed } = directoryFixture(); request.source.directoryHandle = directory;
  const output = await convert(request);
  assert.equal(output.saved, true);
  assert.equal(output.verificationError, 'FINALIZE_FAILED_AFTER_SAVE');
  assert.ok(files.has(output.name));
  assert.deepEqual(removed, []);
});


test('the original cancel reason survives a racing encoder rejection and failed cleanup', async () => {
  const controller = new AbortController(), reason = new DOMException('USER_CANCELLED', 'AbortError');
  const { convert, request } = mediaFixture({ onExecute: () => controller.abort(reason), executeError: new Error('Output has been canceled.') });
  const { directory } = directoryFixture({ cleanupError: new Error('CLEANUP_FAILED') });
  request.signal = controller.signal; request.source.directoryHandle = directory;
  await assert.rejects(convert(request), error => {
    assert.equal(error.cause, reason);
    assert.match(error.message, /USER_CANCELLED/);
    assert.match(error.message, /CLEANUP_FAILED/);
    assert.equal(error.partialFile, 'exports/recording-01-unique.webm');
    return true;
  });
});


test('buffer failure survives a later encoder close error and cleanup failure', async () => {
  const { convert, request } = mediaFixture({ maxBufferedBytes: 1, maskWriteError: true });
  request.source.directoryHandle = directoryFixture({ cleanupError: new Error('REMOVE_FAILED') }).directory;
  await assert.rejects(convert(request), error => {
    assert.match(error.cause.message, /写入缓冲/);
    assert.match(error.message, /写入缓冲/);
    assert.match(error.message, /REMOVE_FAILED/);
    assert.doesNotMatch(error.message, /ERRORED/);
    return true;
  });
});
