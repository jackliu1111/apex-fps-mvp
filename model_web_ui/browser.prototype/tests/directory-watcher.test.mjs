import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryWatcher, isCandidateVideoName } from '../../../site/directory-watcher.mjs';

function fakeDirectory(name, filesMap) {
  return {
    name,
    async *entries() {
      for (const [fileName, entry] of filesMap.entries()) {
        yield [fileName, {
          kind: 'file',
          async getFile() {
            if (entry.locked) throw new DOMException('locked', 'NotReadableError');
            return { name: fileName, size: entry.size, lastModified: entry.lastModified };
          },
        }];
      }
    },
  };
}

test('ignores baseline old files, temp files, and self-exported filenames while probing new recordings safely', async () => {
  const files = new Map([
    ['old-match.mp4', { size: 50_000_000, lastModified: 1000 }],
  ]);
  const dir = fakeDirectory('Apex Videos', files);
  const ready = [];
  let probeCalls = 0;

  const watcher = createDirectoryWatcher({
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    async probeFile(file) {
      probeCalls++;
      // Simulate first probe failing because moov atom is not written yet.
      if (probeCalls === 1) throw new Error('moov missing');
      return { duration: 120, name: file.name };
    },
    onReady(item) { ready.push(item); },
  });

  await watcher.start(dir);
  watcher.registerExportedFilename('self-exported-clip.mp4');

  // Add a temp file, a self-exported clip, and a brand-new recording.
  files.set('recording.mp4.part', { size: 1000, lastModified: 2000 });
  files.set('self-exported-clip.mp4', { size: 4_000_000, lastModified: 2000 });
  files.set('replay-01.mp4', { size: 1_000_000, lastModified: 2000 });

  assert.equal(isCandidateVideoName('recording.mp4.part'), false);
  assert.equal(isCandidateVideoName('replay-01.mp4'), true);

  // Poll 1: discovered
  await watcher.pollNow();
  assert.equal(watcher.state.tracked.length, 1);
  assert.equal(watcher.state.tracked[0].state, 'discovered');

  // File still growing
  files.set('replay-01.mp4', { size: 3_000_000, lastModified: 3000 });
  await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'growing');

  // Stabilizing poll 1
  await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'stabilizing');

  // Stabilizing poll 2 -> triggers probe #1 (fails moov) -> drops back to growing safely
  await watcher.pollNow();
  assert.equal(probeCalls, 1);
  assert.equal(watcher.state.tracked[0].state, 'growing');
  assert.equal(ready.length, 0);

  // Two more stable polls -> probe #2 succeeds -> ready!
  await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'stabilizing');
  await watcher.pollNow();
  assert.equal(probeCalls, 2);
  assert.equal(watcher.state.tracked[0].state, 'ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].name, 'replay-01.mp4');

  watcher.stop();
});

test('only recordings changed since the directory was selected become ready, once each', async (t) => {
  const files = new Map([
    ['empty-at-start.mkv', { size: 0, lastModified: 1000 }],
    ['in-progress.mkv', { size: 120, lastModified: 1000 }],
    ['same-size.mkv', { size: 500, lastModified: 1000 }],
    ['historical.mkv', { size: 500, lastModified: 1000 }],
    ['clip.mp4', { size: 0, lastModified: 1000 }],
    ['temp.mkv.part', { size: 0, lastModified: 1000 }],
  ]);
  const ready = [];
  const watcher = createDirectoryWatcher({
    pollIntervalMs: 60_000,
    onReady: ({ name }) => { ready.push(name); },
  });
  t.after(() => watcher.stop());
  watcher.registerExportedFilename('clip.mp4');
  await watcher.start(fakeDirectory('OBS', files));
  await watcher.pollNow();
  assert.deepEqual(watcher.state.tracked, []);

  for (const name of ['empty-at-start.mkv', 'in-progress.mkv', 'same-size.mkv', 'clip.mp4', 'temp.mkv.part']) {
    files.set(name, { size: 500, lastModified: 2000 });
  }
  await watcher.pollNow();
  assert.deepEqual(ready, []);
  for (let i = 0; i < 4; i++) await watcher.pollNow();
  assert.deepEqual(ready, ['empty-at-start.mkv', 'in-progress.mkv', 'same-size.mkv']);
  assert.deepEqual(watcher.state.tracked.map(entry => entry.name), ready);
});

test('refresh during the initial snapshot cannot discover unchanged historical files', async (t) => {
  const reading = Promise.withResolvers();
  const release = Promise.withResolvers();
  let first = true;
  const dir = {
    name: 'OBS',
    async *entries() {
      yield ['historical.mkv', {
        kind: 'file',
        async getFile() {
          if (first) {
            first = false;
            reading.resolve();
            await release.promise;
          }
          return { name: 'historical.mkv', size: 500, lastModified: 1000 };
        },
      }];
    },
  };
  const watcher = createDirectoryWatcher({ pollIntervalMs: 60_000 });
  t.after(() => watcher.stop());
  const started = watcher.start(dir);
  await reading.promise;
  const refreshing = watcher.pollNow();
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await Promise.all([started, refreshing]);
  assert.deepEqual(watcher.state.tracked, []);
});

test('a manual refresh shares the automatic probe and returns its final status', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const probing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ready = [];
  const watcher = createDirectoryWatcher({
    pollIntervalMs: 20,
    stablePollsRequired: 1,
    async probeFile() { probing.resolve(); await release.promise; return { duration: 1 }; },
    onReady: ({ name }) => { ready.push(name); },
  });
  t.after(() => watcher.stop());
  const files = new Map();
  await watcher.start(fakeDirectory('OBS', files));
  files.set('new.mkv', { size: 500, lastModified: 2000 });
  await watcher.pollNow();
  t.mock.timers.tick(20);
  await probing.promise;
  const refreshing = watcher.pollNow();
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  const result = await refreshing;
  assert.equal(result.tracked[0].state, 'ready');
  assert.deepEqual(ready, ['new.mkv']);
});

test('an initial OBS lock admits a later write while an unchanged locked historical file stays hidden', async (t) => {
  const files = new Map([
    ['ongoing.mkv', { size: 100, lastModified: 1000, locked: true }],
    ['old.mkv', { size: 500, lastModified: 1000, locked: true }],
  ]);
  let clock = 2000;
  const ready = [];
  const watcher = createDirectoryWatcher({
    now: () => clock,
    pollIntervalMs: 60_000,
    onReady: ({ name }) => { ready.push(name); },
  });
  t.after(() => watcher.stop());
  await watcher.start(fakeDirectory('OBS', files));
  clock = 3200;
  files.set('ongoing.mkv', { size: 800, lastModified: 3000 });
  files.get('old.mkv').locked = false;
  for (let i = 0; i < 4; i++) await watcher.pollNow();
  assert.deepEqual(ready, ['ongoing.mkv']);
  assert.deepEqual(watcher.state.tracked.map(entry => entry.name), ready);
});

test('late self-export registration suppresses an in-flight metadata read or probe', async (t) => {
  for (const stage of ['metadata', 'probe']) {
    await t.test(stage, async (t) => {
      const waiting = Promise.withResolvers(), release = Promise.withResolvers();
      let exists = false;
      const ready = [];
      const watcher = createDirectoryWatcher({
        pollIntervalMs: 60_000, stablePollsRequired: 1,
        async probeFile() {
          if (stage === 'probe') { waiting.resolve(); await release.promise; }
          return { duration: 1 };
        },
        onReady: ({ name }) => { ready.push(name); },
      });
      t.after(() => watcher.stop());
      await watcher.start({ async *entries() {
        if (exists) yield ['export.mp4', { kind: 'file', async getFile() {
          if (stage === 'metadata') { waiting.resolve(); await release.promise; }
          return { size: 500, lastModified: 1000 };
        } }];
      } });
      exists = true;
      if (stage === 'probe') await watcher.pollNow();
      const scan = watcher.pollNow();
      await waiting.promise;
      watcher.registerExportedFilename('export.mp4');
      release.resolve();
      await scan;
      assert.deepEqual((await watcher.pollNow()).tracked, []);
      assert.deepEqual(ready, []);
    });
  }
});

test('a file finalized during baseline enumeration is eligible, while unchanged old and future-dated files stay hidden', async (t) => {
  let clock = 1000;
  const files = new Map([
    ['old.mkv', { size: 50, lastModified: 800 }],
    ['future.mkv', { size: 50, lastModified: 5000 }],
    ['active.mkv', { size: 100, lastModified: 900 }],
  ]);
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  const directory = fakeDirectory('OBS', files);
  const ready = [];
  const watcher = createDirectoryWatcher({
    now: () => clock, pollIntervalMs: 60_000, stablePollsRequired: 1,
    onReady: ({ name }) => { ready.push(name); },
  });
  t.after(() => watcher.stop());
  const starting = watcher.start({ async *entries() {
    reading.resolve(); await release.promise;
    yield* directory.entries();
  } });
  await reading.promise;
  files.set('active.mkv', { size: 800, lastModified: 1100 });
  clock = 1200;
  release.resolve();
  await starting;
  for (let i = 0; i < 3; i++) await watcher.pollNow();
  assert.deepEqual(ready, ['active.mkv']);
  assert.deepEqual(watcher.state.tracked.map(entry => entry.name), ready);
});

test('an incomplete recording that exhausted its probes gets a fresh retry budget only after a change', async (t) => {
  const files = new Map(), ready = [];
  let probes = 0;
  const watcher = createDirectoryWatcher({
    pollIntervalMs: 60_000, stablePollsRequired: 1,
    async probeFile(file) {
      probes++;
      if (file.size < 200) throw new Error('incomplete container');
      return { duration: 2 };
    },
    onReady: ({ name }) => { ready.push(name); },
  });
  t.after(() => watcher.stop());
  await watcher.start(fakeDirectory('OBS', files));
  files.set('long.mkv', { size: 100, lastModified: 1000 });
  for (let i = 0; i < 20; i++) await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'ignored');
  assert.equal(probes, 15);
  files.set('long.mkv', { size: 140, lastModified: 1200 });
  await watcher.pollNow();
  await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'growing');
  assert.equal(watcher.state.tracked[0].attempts, 1);
  files.set('long.mkv', { size: 220, lastModified: 1500 });
  for (let i = 0; i < 3; i++) await watcher.pollNow();
  assert.deepEqual(ready, ['long.mkv']);
});
