import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisQueue } from '../analysis-queue.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a slow file preparation does not block another ready recording', async () => {
  const slow = deferred();
  const queue = createAnalysisQueue({
    prepare: async (record) => record.file.name === 'slow' ? slow.promise : { duration: 30 },
    analyze: async (record, { publish }) => publish([{ key: 'candidate', start: 1, end: 8, provisional: false }], { frontier: Infinity, processedUntil: 30 }),
  });
  const imported = queue.importFiles([{ name: 'slow' }, { name: 'ready' }]);
  await tick();
  assert.equal(queue.records[0].status, 'preparing');
  assert.equal(queue.records[1].status, 'complete');
  assert.equal(queue.records[1].candidates[0].end, 8);
  slow.resolve({ duration: 30 });
  await imported;
  await queue.whenIdle();
  assert.equal(queue.records[0].status, 'complete');
});

test('stopping one analysis preserves stable suggestions and advances the queue without changing review', async () => {
  const firstRun = deferred();
  const queue = createAnalysisQueue({
    prepare: async () => ({ duration: 60 }),
    analyze: async (record, { signal, publish }) => {
      if (record.file.name === 'first') {
        publish([{ key: 'stable', start: 10, end: 20, provisional: false }], { processedUntil: 30, frontier: 30 });
        firstRun.resolve();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    },
  });
  await queue.importFiles([{ name: 'first' }, { name: 'second' }]);
  await firstRun.promise;
  queue.stop(queue.records[0].id);
  await queue.whenIdle();
  assert.equal(queue.records[0].status, 'stopped');
  assert.deepEqual(queue.records[0].candidates.map(({ start, end }) => [start, end]), [[10, 20]]);
  assert.equal(queue.records[1].status, 'complete');
});

test('stopping preparation rejects its late result and retry starts a fresh analysis', async () => {
  const pending = deferred();
  let attempted = false, released = false;
  const queue = createAnalysisQueue({
    prepare: async () => {
      if (!attempted) { attempted = true; return pending.promise; }
      return { duration: 45 };
    },
    analyze: async () => {},
  });
  const imported = queue.importFiles([{ name: 'pending' }]);
  const record = queue.records[0];
  queue.stop(record.id);
  await queue.retry(record.id);
  pending.resolve({ duration: 999, input: { dispose() { released = true; } } });
  await imported;
  await queue.whenIdle();
  assert.equal(record.duration, 45);
  assert.equal(record.status, 'complete');
  assert.equal(released, true);
});

test('retry waits for stopped decoder cleanup before using the shared analysis worker', async () => {
  const started = deferred(), cleanup = deferred();
  let attempt = 0;
  const queue = createAnalysisQueue({
    prepare: async () => ({ duration: 30 }),
    analyze: async (record, { signal }) => {
      attempt++;
      if (attempt === 1) {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        await cleanup.promise;
        signal.throwIfAborted();
      }
    },
  });
  await queue.importFiles([{ name: 'recording' }]);
  await started.promise;
  const record = queue.records[0];
  queue.stop(record.id);
  await queue.retry(record.id);
  await tick();
  assert.equal(record.status, 'queued');
  cleanup.resolve();
  await queue.whenIdle();
  assert.equal(record.status, 'complete');
});

test('removing a queued recording cannot remove the active recording', async () => {
  const active = deferred();
  const queue = createAnalysisQueue({ prepare: async () => ({ duration: 30 }), analyze: async () => active.promise });
  await queue.importFiles([{ name: 'active' }, { name: 'queued' }]);
  assert.equal(queue.remove(queue.records[0].id), false);
  assert.equal(queue.remove(queue.records[1].id), true);
  active.resolve();
  await queue.whenIdle();
  assert.deepEqual(queue.records.map((record) => record.file.name), ['active']);
});

test('retry re-associates prepared media after persistence preparation failed', async () => {
  let attempts = 0, associated = false;
  const queue = createAnalysisQueue({
    prepare: async () => ({ duration: 30 }),
    onPrepared: async () => { if (++attempts === 1) throw new Error('save failed'); associated = true; },
    analyze: async () => { assert.equal(associated, true); },
  });
  await queue.importFiles([{ name: 'recording' }]);
  const record = queue.records[0];
  assert.equal(record.status, 'failed');
  await queue.retry(record.id);
  await queue.whenIdle();
  assert.equal(record.status, 'complete');
});
