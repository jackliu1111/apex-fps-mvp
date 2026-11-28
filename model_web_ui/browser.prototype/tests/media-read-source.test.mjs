import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMediaReadSource,
  acquirePreviewUrgent,
} from '../../../site/media-read-source.mjs';
import { identifyFile } from '../../../site/media-identity.mjs';
import { createSelectionEvidence } from '../../../site/selection-evidence.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

function makeTrackedFile(name, size, tracker, gateFn = null) {
  return {
    name,
    size,
    lastModified: 1700000000000,
    slice(start, end) {
      return {
        async arrayBuffer() {
          const id = ++tracker.seq;
          tracker.inFlight++;
          if (tracker.inFlight > tracker.maxConcurrent) tracker.maxConcurrent = tracker.inFlight;
          const entry = { id, file: name, start, end, bytes: end - start };
          tracker.started.push(entry);
          try {
            if (gateFn) await gateFn(entry);
            return new Uint8Array(end - start).buffer;
          } finally {
            tracker.inFlight--;
            tracker.finished.push(entry);
          }
        },
      };
    },
  };
}

const mockMB = {
  StreamSource: class { constructor(options) { Object.assign(this, options); } },
  BlobSource: class { constructor(file) { this.file = file; } },
};

test('global read scheduler serializes reads across different files and prioritizes preview over analysis', async () => {
  const tracker = { seq: 0, inFlight: 0, maxConcurrent: 0, started: [], finished: [] };
  const firstReadGate = deferred();
  const fileA = makeTrackedFile('A-13G.mkv', 32 * 1024 * 1024, tracker, (e) => (e.id === 1 ? firstReadGate.promise : null));
  const fileB = makeTrackedFile('B-6G.mkv', 32 * 1024 * 1024, tracker);

  const analysisA = createMediaReadSource({ MB: mockMB, file: fileA, priority: 'analysis' });
  const previewB = createMediaReadSource({ MB: mockMB, file: fileB, priority: 'preview' });

  // Kick off an analysis read on File A (blocked at disk boundary)
  const rA1 = analysisA.read(0, 1024 * 1024);
  await Promise.resolve();
  assert.equal(tracker.started.length, 1);

  // While File A read is in flight, queue another analysis read on File A AND a preview read on File B
  const rA2 = analysisA.read(1024 * 1024, 2 * 1024 * 1024);
  const rB1 = previewB.read(0, 1024 * 1024);
  await Promise.resolve();

  // Cross-file concurrency must never exceed 1
  assert.equal(tracker.maxConcurrent, 1);

  firstReadGate.resolve();
  await Promise.all([rA1, rA2, rB1]);

  assert.equal(tracker.maxConcurrent, 1, 'cross-file reads must be serialized globally');
  assert.deepEqual(
    tracker.started.map((e) => e.file),
    ['A-13G.mkv', 'B-6G.mkv', 'A-13G.mkv'],
    'preview read on File B must preempt queued analysis read on File A',
  );
});

test('preview urgent mode defers background analysis and prepare reads until load/seek finishes', async () => {
  const tracker = { seq: 0, inFlight: 0, maxConcurrent: 0, started: [], finished: [] };
  const fileA = makeTrackedFile('A.mkv', 16 * 1024 * 1024, tracker);
  const fileB = makeTrackedFile('B.mkv', 16 * 1024 * 1024, tracker);

  const analysisA = createMediaReadSource({ MB: mockMB, file: fileA, priority: 'analysis' });
  const previewB = createMediaReadSource({ MB: mockMB, file: fileB, priority: 'preview' });

  const releaseUrgent = acquirePreviewUrgent();
  let analysisResolved = false;
  const rA = analysisA.read(0, 512 * 1024).then(() => { analysisResolved = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(analysisResolved, false, 'background analysis read must wait while preview is urgent');
  assert.equal(tracker.started.length, 0);

  // Preview read on File B still executes immediately during urgent mode
  await previewB.read(0, 512 * 1024);
  assert.deepEqual(tracker.started.map((e) => e.file), ['B.mkv']);
  assert.equal(analysisResolved, false);

  // Releasing urgent resumes queued analysis reads
  releaseUrgent();
  await rA;
  assert.equal(analysisResolved, true);
  assert.deepEqual(tracker.started.map((e) => e.file), ['B.mkv', 'A.mkv']);
});

test('background analysis uses smaller 1 MiB chunks when preview is active to bound head-of-line latency', async () => {
  const tracker = { seq: 0, inFlight: 0, maxConcurrent: 0, started: [], finished: [] };
  const fileA = makeTrackedFile('A.mkv', 16 * 1024 * 1024, tracker);
  const fileB = makeTrackedFile('B.mkv', 16 * 1024 * 1024, tracker);

  const analysisA = createMediaReadSource({ MB: mockMB, file: fileA, priority: 'analysis' });
  const previewB = createMediaReadSource({ MB: mockMB, file: fileB, priority: 'preview' });

  // Trigger recent preview activity
  await previewB.read(0, 64 * 1024);
  tracker.started.length = 0;

  // Now issue a 4 MiB analysis read; it should be sliced into 1 MiB chunks so preview can preempt quickly
  await analysisA.read(0, 4 * 1024 * 1024);
  assert.equal(tracker.started.length, 4);
  assert.ok(tracker.started.every((e) => e.bytes === 1024 * 1024));
});

test('disposing a read source removes its pending queued reads without touching disk', async () => {
  const tracker = { seq: 0, inFlight: 0, maxConcurrent: 0, started: [], finished: [] };
  const gate = deferred();
  const fileA = makeTrackedFile('A.mkv', 16 * 1024 * 1024, tracker, (e) => (e.id === 1 ? gate.promise : null));
  const fileB = makeTrackedFile('B.mkv', 16 * 1024 * 1024, tracker);

  const srcA = createMediaReadSource({ MB: mockMB, file: fileA, priority: 'analysis' });
  const srcB = createMediaReadSource({ MB: mockMB, file: fileB, priority: 'preview' });

  const rA = srcA.read(0, 512 * 1024);
  await Promise.resolve();
  const rB = srcB.read(0, 512 * 1024);
  await Promise.resolve();

  // Dispose B while its read is still queued behind A's in-flight read
  srcB.dispose();
  await assert.rejects(rB, { name: 'AbortError' });

  gate.resolve();
  await rA;
  assert.deepEqual(tracker.started.map((e) => e.file), ['A.mkv'], 'disposed queued read must never hit disk');
});

test('batch identifyFile serializes file header/tail reads globally instead of spiking HDD concurrency', async () => {
  const tracker = { seq: 0, inFlight: 0, maxConcurrent: 0, started: [], finished: [] };
  const files = Array.from({ length: 5 }, (_, i) =>
    makeTrackedFile(`rec-${i}.mkv`, 1024 * 1024, tracker, async () => {
      await new Promise((r) => setTimeout(r, 2));
    }),
  );

  const results = await Promise.all(files.map((f) => identifyFile(f)));
  assert.equal(results.length, 5);
  assert.equal(tracker.started.length, 15);
  assert.equal(tracker.maxConcurrent, 1, 'batch identifyFile must stay single-flight on disk');
});

test('selection evidence uses thumbnail priority and defers decoding throughout active playback', async () => {
  let busy = true;
  let openedPriority = null;
  let decodedCount = 0;
  const results = [];

  const MB = {
    ALL_FORMATS: [],
    StreamSource: class { constructor(options) { Object.assign(this, options); } },
    Input: class {
      constructor({ source }) { openedPriority = source.priority; }
      async getPrimaryVideoTrack() { return { getFirstTimestamp: async () => 0 }; }
      dispose() {}
    },
    CanvasSink: class {
      async getCanvas(timestamp) {
        decodedCount++;
        return { timestamp, canvas: { toDataURL: () => `data:image/jpeg;base64,${timestamp}` } };
      }
    },
    EncodedPacketSink: class {
      async getKeyPacket(target) { return { type: 'key', timestamp: target }; }
      async getFirstPacket() { return { type: 'key', timestamp: 0 }; }
    },
  };

  const evidence = createSelectionEvidence({
    MB,
    isBusy: () => busy,
    onResult: (r) => results.push(r),
  });

  evidence.request({ file: new Blob(['4k-video']), origin: 0 }, 0, 60);
  // Wait 450ms (past 240ms debounce + old 120ms busy timeout) while player is still playing
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(openedPriority, null, 'selection evidence must not even open MB.Input while player is busy/playing');
  assert.equal(decodedCount, 0, 'selection evidence must not decode keyframes while player is busy/playing');

  // Once playback pauses, evidence resumes and completes at thumbnail priority
  busy = false;
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('evidence did not finish after idle')), 3000);
    const timer = setInterval(() => {
      if (results.at(-1)?.status === '原片参考画面') {
        clearTimeout(deadline);
        clearInterval(timer);
        resolve();
      }
    }, 15);
  });

  assert.equal(openedPriority, 'thumbnail');
  assert.equal(decodedCount, 10);
  evidence.cancel();
});
