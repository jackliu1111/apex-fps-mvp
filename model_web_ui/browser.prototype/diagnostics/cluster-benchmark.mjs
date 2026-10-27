import { open, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { alignedReader } from '../sparse-audio.prototype.js';
import { clusterPrefetch } from './cluster-prefetch.js';
const [path, secondsArg = '20', modesArg = 'original,1,2,4,8,original', output] = process.argv.slice(2);
const results = [];
for (const mode of modesArg.split(',')) {
  const MB = await import(`/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny${mode === 'original' ? '' : mode === 'sparse' ? '-sparse' : '-concurrent'}.mjs`);
  const file = await open(path), size = (await stat(path)).size;
  const metrics = { readBytes: 0, readCalls: 0, maxActiveReads: 0 };
  let active = 0;
  const readRange = async (start, end) => {
    active++; metrics.maxActiveReads = Math.max(metrics.maxActiveReads, active);
    try {
      const b = Buffer.allocUnsafe(end - start); let n = 0;
      while (n < b.length) { const r = await file.read(b, n, b.length - n, start + n); if (!r.bytesRead) throw Error('EOF'); n += r.bytesRead; }
      metrics.readBytes += b.length; metrics.readCalls++; return b;
    } finally { active--; }
  };
  const source = new MB.StreamSource({ getSize: () => size, read: mode === 'original' ? readRange : alignedReader(size, readRange), prefetchProfile: mode === 'original' ? 'fileSystem' : 'none', maxCacheSize: 8 * 2 ** 20 });
  const prefetch = /^\d+$/.test(mode) ? clusterPrefetch(size, readRange, Number(mode), metrics) : null;
  if (prefetch) source._apexClusterPrefetch = prefetch;
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  const hash = createHash('sha256'), packetHash = createHash('sha256');
  let count = 0, audioBytes = 0, lastTimestamp;
  const started = performance.now();
  try {
    const track = (await input.getAudioTracks())[0];
    if (mode !== 'original') source._apexAudioTrackId = track.id;
    for await (const p of new MB.EncodedPacketSink(track).packets()) {
      if (p.timestamp >= Number(secondsArg)) break;
      count++; audioBytes += p.data.length; lastTimestamp = p.timestamp;
      if (count % 20000 === 0) console.error(`mode=${mode} timestamp=${p.timestamp.toFixed(1)} elapsed=${((performance.now() - started) / 1000).toFixed(1)}s`);
      hash.update(p.data);
      packetHash.update(JSON.stringify([p.timestamp, p.duration, p.type, p.data.length]) + '\n'); packetHash.update(p.data);
    }
    const totalMs = performance.now() - started;
    if (prefetch) await prefetch.close();
    const result = { mode, totalMs, count, audioBytes, lastTimestamp, hash: hash.digest('hex'), packetHash: packetHash.digest('hex'), ...metrics };
    results.push(result); console.log(JSON.stringify(result));
    if (output) await writeFile(output, JSON.stringify({ path, seconds: Number(secondsArg), runtime: process.version, cacheCleared: false, results }, null, 2) + '\n');
    if (results.some(r => r.packetHash !== result.packetHash)) throw Error('Packet parity failure');
  } finally {
    if (prefetch) await prefetch.close();
    input.dispose(); await new Promise(r => setTimeout(r, 100)); await file.close();
  }
}
