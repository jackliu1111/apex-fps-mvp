// Exercise the real patched demuxer against upstream with small Matroska fixtures.
import assert from 'node:assert/strict';
import * as original from '/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny.mjs';
import * as sparse from '/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny-concurrent.mjs';
import { clusterPrefetch } from './cluster-prefetch.js';
const bytes = (...xs) => Buffer.concat(xs.map((x) => Buffer.isBuffer(x) ? x : Buffer.from(x)));
const uint = (n) => { let s = n.toString(16); if (s.length % 2) s = '0' + s; return Buffer.from(s, 'hex'); };
const vint = (n) => { for (let w = 1; w <= 7; w++) if (n < 2 ** (7 * w) - 1) { const b = Buffer.alloc(w); let x = n; for (let i = w - 1; i >= 0; i--) { b[i] = x % 256; x = Math.floor(x / 256); } b[0] |= 1 << (8 - w); return b; } throw Error('too large'); };
const el = (id, payload) => bytes(uint(id), vint(payload.length), payload);
const uel = (id, n) => el(id, uint(n));
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b; };
function audio(id) {
  return el(0xae, bytes(uel(0xd7, id), uel(0x73c5, id), uel(0x83, 2), el(0x86, Buffer.from('A_AAC')), el(0x63a2, [0x11, 0x90]), uel(0x23e383, 20000000), el(0xe1, bytes(el(0xb5, f64(48000)), uel(0x9f, 2)))));
}
function block(track, time, flags, data, id = 0xa3) {
  const timestamp = Buffer.alloc(2); timestamp.writeInt16BE(time);
  return el(id, bytes(vint(track), timestamp, [flags], data));
}
function fixture(unknownSize) {
  const header = el(0x1a45dfa3, bytes(uel(0x4286, 1), uel(0x42f7, 1), uel(0x42f2, 4), uel(0x42f3, 8), el(0x4282, Buffer.from('matroska')), uel(0x4287, 4), uel(0x4285, 2)));
  const info = el(0x1549a966, bytes(uel(0x2ad7b1, 1000000), el(0x4489, f64(200))));
  const video = el(0xae, bytes(uel(0xd7, 1), uel(0x73c5, 1), uel(0x83, 1), el(0x86, Buffer.from('V_VP8')), el(0xe0, bytes(uel(0xb0, 16), uel(0xba, 16)))));
  const tracks = el(0x1654ae6b, bytes(video, audio(2), audio(3)));
  const cluster = bytes(uel(0xe7, 0), block(1, 0, 128, Buffer.alloc(10000, 9)),
    block(2, 0, 128, [1, 2, 3]), block(3, 0, 128, [7, 8, 9]),
    block(2, 20, 130, [1, 2, 11, 12, 13, 14, 15]), // Xiph, lengths 2/3
    block(2, 60, 132, [1, 21, 22, 23, 24]), // fixed, 2/2
    block(2, 100, 134, [1, 0x82, 31, 32, 33, 34, 35]), // EBML, 2/3
    el(0xa0, bytes(block(2, 140, 0, [41, 42], 0xa1), uel(0x9b, 20))),
    block(3, 160, 128, [51, 52]), el(0xec, Buffer.alloc(20)));
  const clusterElement = unknownSize ? bytes(uint(0x1f43b675), [0xff], cluster) : el(0x1f43b675, cluster);
  return bytes(header, el(0x18538067, bytes(info, tracks, clusterElement, clusterElement, clusterElement)));
}
async function packets(MB, data, trackId, patch) {
  const source = new MB.BufferSource(data);
  const prefetch = patch ? clusterPrefetch(data.length, async (a, b) => { await new Promise(r => setTimeout(r, a % 3)); return data.subarray(a, b); }, 4) : null;
  if (patch) { source._apexAudioTrackId = trackId; source._apexClusterPrefetch = prefetch; }
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  try {
    const track = (await input.getAudioTracks()).find((t) => t.id === trackId);
    const result = [];
    for await (const p of new MB.EncodedPacketSink(track).packets()) result.push({ timestamp: p.timestamp, duration: p.duration, type: p.type, data: Buffer.from(p.data).toString('hex') });
    return result;
  } finally { if (prefetch) await prefetch.close(); input.dispose(); }
}
for (const unknown of [false, true]) for (const track of [2, 3]) {
  const data = fixture(unknown), baseline = await packets(original, data, track, false);
  assert.ok(baseline.length);
  assert.deepEqual(await packets(sparse, data, track, true), baseline);
  console.log(`PASS unknownClusterSize=${unknown} audioTrack=${track} packets=${baseline.length}`);
}
