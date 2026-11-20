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
