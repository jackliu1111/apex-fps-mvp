import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectoryWatcher } from '../../../site/directory-watcher.mjs';
import { probeRecordingFile } from '../../../site/recording-probe.mjs';

// Rebuild the early EBML elements of the observed OBS/Lavf file, omitting its recording UID.
// The placeholder has the same total width as a finalized 8-byte Duration element.
const hex = value => Buffer.from(value.replaceAll(' ', ''), 'hex');
const voidSeekHead = Buffer.concat([hex('ec 0100000000000098'), Buffer.alloc(152)]);
const unknownSize = hex('01ffffffffffffff');
function recording({ closed = false, streaming = false, otherWriter = false, durationSlot = true, presetDuration = false } = {}) {
  const app = Buffer.from(otherWriter ? 'Other tool' : 'Lavf61.7.100');
  const infoBody = Buffer.concat([
    presetDuration ? hex('ec8400000000') : Buffer.alloc(0),
    hex('2ad7b1 83 0f4240'), hex('4d80'), Buffer.of(0x80 + app.length), app,
    // A Duration byte pattern embedded in the UID is not the Duration element.
    hex('73a49044898800000000000000000000000000'),
    durationSlot ? hex(closed || presetDuration ? '44898840d99e4000000000' : 'ec01000000000000020000') : Buffer.alloc(0),
  ]);
  const body = Buffer.concat([
    closed || streaming ? hex('114d9b7480') : voidSeekHead,
    hex('1549a966'), Buffer.of(0x80 + infoBody.length), infoBody,
    hex('1f43b67581'), Buffer.alloc(closed ? 200 : 1),
  ]);
  const size = closed ? Buffer.of(0x40 + (body.length >> 8), body.length & 0xff) : unknownSize;
  return new File([hex('1a45dfa38018538067'), size, body], 'OBS.mkv', { lastModified: closed ? 3000 : 2000 });
}

// Isolate container readiness from media decodability. Both the observed intermediate
// and final OBS snapshots have a video track; a duration-only probe accepts both.
function mediaReader(duration) {
  return {
    BlobSource: class {}, ALL_FORMATS: [],
    Input: class {
      async getPrimaryVideoTrack() {
        return { getFirstTimestamp: async () => 0, computeDuration: async () => duration };
      }
      dispose() {}
    },
  };
}

for (const order of ['watch first', 'record first']) {
  test(`OBS MKV becomes ready once at its full duration (${order})`, async t => {
    let file = order === 'record first' ? new File([], 'OBS.mkv', { lastModified: 1000 }) : null;
    const ready = [];
    let duration = 4.966;
    const watcher = createDirectoryWatcher({
      pollIntervalMs: 60_000,
      probeFile: file => probeRecordingFile(file, mediaReader(duration)),
      onReady: ({ file, meta }) => { ready.push([file.size, meta.duration]); },
    });
    t.after(() => watcher.stop());
    await watcher.start({ async *entries() {
      if (file) yield [file.name, { kind: 'file', getFile: async () => file }];
    } });
    file = recording();
    for (let i = 0; i < 40; i++) await watcher.pollNow();
    assert.deepEqual(ready, [], 'a decodable, temporarily stable prefix must not reach review');
    assert.notEqual(watcher.state.tracked[0].state, 'ignored');
    duration = 19.666;
    file = recording({ closed: true });
    for (let i = 0; i < 8; i++) await watcher.pollNow();
    assert.deepEqual(ready, [[file.size, 19.666]]);
  });
}

test('valid unknown-size streaming MKVs retain normal metadata probing', async () => {
  for (const options of [{ streaming: true }, { otherWriter: true }, { durationSlot: false }]) {
    const meta = await probeRecordingFile(recording(options), mediaReader(7));
    assert.equal(meta.duration, 7);
  }
});

test('a seekable Lavf recording with a prefilled duration still has an unpatched Info CRC reservation', async () => {
  const meta = await probeRecordingFile(recording({ presetDuration: true }), mediaReader(8));
  assert.equal(meta.pendingFinalization, true);
});
