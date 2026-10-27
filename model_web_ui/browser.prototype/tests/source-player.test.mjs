import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourcePlayer } from '../source-player.mjs';

// Media decoding, the display surface and time are external system boundaries.
function fixture({ duration = 120, origin = 2, waitForFrame, waitForOpen } = {}) {
  const drawn = [], closed = [], scheduled = [];
  let now = 0;
  const frames = new Map();
  const track = { canDecode: async () => true, getFirstTimestamp: async () => origin,
    computeDuration: async () => origin + duration, displayWidth: 1920, displayHeight: 1080 };
  const audio = { ...track, sampleRate: 48000, id: 'primary' };
  const MB = {
    ALL_FORMATS: [], BlobSource: class { constructor(file) { this.file = file; } },
    Input: class {
      constructor({ source }) { this.file = source.file; }
      async getPrimaryVideoTrack() { if (waitForOpen) await waitForOpen(this.file); return track; }
      async getPrimaryAudioTrack() { return audio; }
      dispose() { closed.push('input'); }
    },
    CanvasSink: class {
      constructor(_track, options) { assert.equal(options.poolSize, 2); }
      async *canvases(start, end) {
        try {
          if (waitForFrame) await waitForFrame(start);
          for (let t = Math.floor(start * 10) / 10; t < end; t += 0.1) {
            yield { canvas: { time: t }, timestamp: t, duration: 0.1 };
          }
        } finally { closed.push(start); }
      }
    },
    AudioBufferSink: class {
      async *buffers(start, end) {
        for (let t = start; t < end; t += 0.1) yield { buffer: { duration: 0.1 }, timestamp: t, duration: 0.1 };
      }
    },
  };
  const context = { currentTime: 0, state: 'suspended', destination: {},
    async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; },
    createBufferSource() { return { connect() {}, disconnect() {}, start(...args) { scheduled.push(args); }, stop() {} }; } };
  const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage: (image) => drawn.push(image.time) }) };
  const clock = {
    now: () => now * 1000,
    request: (fn) => { const id = Symbol(); frames.set(id, fn); return id; },
    cancel: (id) => frames.delete(id),
  };
  const player = createSourcePlayer({ MB, canvas, createAudioContext: () => context, clock });
  return { player, drawn, closed, scheduled, context,
    async advance(seconds) { now += seconds; if (context.state === 'running') context.currentTime += seconds;
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn(now * 1000));
      for (let i = 0; i < 12; i++) await Promise.resolve();
    } };
}

test('opening a recording establishes the whole timeline and a paused source frame', async () => {
  const { player, drawn } = fixture();
  await player.load({ file: new Blob(['source']), position: 35 });
  assert.equal(player.state.duration, 120);
  assert.equal(player.state.position, 35);
  assert.equal(player.state.actual, 35);
  assert.equal(player.state.playing, false);
  assert.deepEqual(drawn, [37]);
  await player.dispose();
});

test('rapid seeking coalesces pending targets and an old frame cannot replace the final target', async () => {
  const gate = Promise.withResolvers();
  const { player, drawn } = fixture({ waitForFrame: (timestamp) => timestamp === 7 ? gate.promise : undefined });
  await player.load({ file: new Blob(['source']) });
  const old = player.seek(5);
  await Promise.resolve(); await Promise.resolve();
  const middle = player.seek(35);
  const latest = player.seek(70);
  assert.equal(player.state.target, 70);
  gate.resolve();
  await Promise.all([old, middle, latest]);
  assert.deepEqual(drawn, [2, 72]);
  assert.equal(player.state.actual, 70);
  assert.equal(player.state.status, 'paused');
  await player.dispose();
});

test('continuous playback advances on the source timeline and pause retains its position', async () => {
  const { player, advance, drawn, scheduled } = fixture();
  await player.load({ file: new Blob(['source']), position: 10 });
  await player.play();
  await advance(0.2); await advance(0.2);
  assert.equal(player.state.playing, true);
  assert.equal(player.state.position, 10.4);
  assert.ok(drawn.at(-1) >= 12.1);
  assert.ok(scheduled.length > 0);
  player.pause();
  await advance(3);
  assert.equal(player.state.position, 10.4);
  assert.equal(player.state.playing, false);
  await player.play();
  await advance(0.2);
  assert.ok(player.state.position > 10.5);
  await player.dispose();
});

test('a later recording load supersedes an earlier pending load', async () => {
  const gate = Promise.withResolvers();
  const oldFile = new Blob(['old']);
  const { player, drawn } = fixture({ waitForOpen: (file) => file === oldFile ? gate.promise : undefined });
  const old = player.load({ file: oldFile, position: 5 });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await player.load({ file: new Blob(['new']), position: 70 });
  gate.resolve(); await old;
  assert.equal(player.state.position, 70);
  assert.deepEqual(drawn, [72]);
  await player.dispose();
});

test('pausing while a seek is decoding prevents its late frame and sound from appearing', async () => {
  const gate = Promise.withResolvers();
  const { player, drawn, scheduled } = fixture({ waitForFrame: (timestamp) => timestamp === 37 ? gate.promise : undefined });
  await player.load({ file: new Blob(['source']) });
  const seeking = player.seek(35);
  await Promise.resolve(); await Promise.resolve();
  player.pause();
  gate.resolve(); await seeking;
  assert.deepEqual(drawn, [2]);
  assert.deepEqual(scheduled, []);
  assert.equal(player.state.status, 'paused');
  assert.equal(player.state.position, 35);
  await player.dispose();
});

test('seeking during playback resumes at the new source time and reaches the full-source end', async () => {
  const { player, advance } = fixture({ duration: 60 });
  await player.load({ file: new Blob(['source']) });
  await player.play();
  await player.seek(59.5);
  assert.equal(player.state.playing, true);
  await advance(0.7);
  assert.equal(player.state.status, 'ended');
  assert.equal(player.state.position, 60);
  assert.equal(player.state.playing, false);
  await player.dispose();
});

test('invalid positioning reports an error without moving the established frame', async () => {
  const { player } = fixture();
  await player.load({ file: new Blob(['source']), position: 20 });
  await assert.rejects(player.seek(NaN), /定位时间无效/);
  assert.equal(player.state.position, 20);
  await player.dispose();
});
