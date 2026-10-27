// Diagnostic only: same pinned demuxer, Node range reader (not browser timing).
import { open, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { alignedReader } from '../sparse-audio.prototype.js';

const [path, secondsArg = '20', profile = 'fileSystem', cacheArg = '8', output] = process.argv.slice(2);
const seconds = Number(secondsArg), cacheMiB = Number(cacheArg);
const MB = await import(`/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny${profile === 'sparse' ? '-sparse' : ''}.mjs`);
const file = await open(path), size = (await stat(path)).size;
const reads = [], requests = [], hash = createHash('sha256');
const started = performance.now();
const readRange = async (start, end) => {
    const before = performance.now();
    const buffer = Buffer.allocUnsafe(end - start);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, start + count);
      if (!bytesRead) throw new Error('Unexpected EOF');
      count += bytesRead;
    }
    reads.push({ start, end, ms: performance.now() - before });
    return buffer;
  };
const source = new MB.StreamSource({
  getSize: () => size, prefetchProfile: profile === 'sparse' ? 'none' : profile, maxCacheSize: cacheMiB * 2 ** 20,
  read: profile === 'sparse' ? alignedReader(size, readRange) : readRange,
});
const originalRead = source._read.bind(source);
source._read = (start, end) => {
  requests.push({ start, end });
  return originalRead(start, end);
};
const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
let count = 0, audioBytes = 0, lastTimestamp = 0;
try {
  const track = (await input.getAudioTracks())[0];
  if (profile === 'sparse') source._apexAudioTrackId = track.id;
  const importMs = performance.now() - started;
  const sink = new MB.EncodedPacketSink(track);
  for await (const packet of sink.packets()) {
    if (packet.timestamp >= seconds) break;
    count++; audioBytes += packet.data.length; lastTimestamp = packet.timestamp;
    hash.update(packet.data);
  }
  const totalMs = performance.now() - started;
  const readBytes = reads.reduce((n, r) => n + r.end - r.start, 0);
  const result = { path, size, seconds, profile, cacheMiB, runtime: process.version,
    importMs, totalMs, count, lastTimestamp, audioBytes, hash: hash.digest('hex'),
    readBytes, readAmplification: readBytes / audioBytes,
    readMs: reads.reduce((n, r) => n + r.ms, 0), readCount: reads.length,
    requestCount: requests.length, reads, requests };
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, reads: undefined, requests: undefined }, null, 2));
  if (readBytes > audioBytes * 100) { console.log('RED: audio extraction reads >100x encoded audio bytes'); process.exitCode = 2; }
} finally {
  input.dispose();
  // Let any in-flight prefetch settle before closing the file handle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await file.close();
}
