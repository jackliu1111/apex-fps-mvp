// Diagnostic only: original pinned demuxer + packet streamcopy; no audio decoder.
// Usage: node extract-audio.mjs source.mkv output.mka report.json [audio-index=0] [timeline.bin]
// Use an already verified, writable external mount for large outputs.
import { open, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { packetTimeline } from './packet-timeline.mjs';

const runtimePath = '/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny.mjs';
const runtimeSha256 = '160db974a539ca6303bb614545f2017953be2f5a92bc04464243b0b4cbc0be27';
const runtimeBytes = await readFile(runtimePath);
if (createHash('sha256').update(runtimeBytes).digest('hex') !== runtimeSha256) throw Error('Pinned Mediabunny hash mismatch');
const MB = await import(pathToFileURL(runtimePath));

const [sourcePath, outputPath, reportPath, indexArg = '0', timelinePath] = process.argv.slice(2);
const audioIndex = Number(indexArg);
if (!sourcePath || !outputPath || !reportPath || !Number.isInteger(audioIndex) || audioIndex < 0) {
  throw Error('Usage: node extract-audio.mjs source.mkv output.mka report.json [audio-index=0]');
}
if (new Set([sourcePath, outputPath, reportPath]).size !== 3) throw Error('Source, output and report paths must differ');

// Reserve the report first. Neither report nor media is ever overwritten.
const reportFile = await open(reportPath, 'wx');
const result = {
  mode: 'mediabunny-original-node-streamcopy-mka', status: 'running',
  sourcePath, outputPath, audioIndex, runtime: process.version,
  mediabunny: { version: '1.25.0', path: runtimePath, sha256: runtimeSha256 },
  cacheCleared: false, timestampShiftSeconds: 0,
  scope: 'Node fs range reads + pinned demuxer + Matroska mux + writes + close; excludes module load and report write; no fsync',
  readBytes: 0, readCalls: 0, readMs: 0, maxActiveReads: 0,
  writeBytes: 0, writeCalls: 0, writeMs: 0, maxWriteChunkBytes: 0,
};
let sourceFile, outputFile, input, output, timeline, completed = false, outputCreated = false;
const pendingReads = new Set();
const hash = createHash('sha256'), packetHash = createHash('sha256');
const ptsHash = createHash('sha256'), durationHistogram = {};
let count = 0, audioBytes = 0, firstTimestamp = null, lastTimestamp = null, lastEnd = null;
let backwards = 0, maxAbsoluteCadenceDeviationSeconds = 0;
let previousTimestamp;
const started = performance.now();
try {
  timeline = await packetTimeline(timelinePath);
  sourceFile = await open(sourcePath, 'r');
  const sourceStat = await sourceFile.stat();
  result.source = { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
  outputFile = await open(outputPath, 'wx');
  outputCreated = true;
  const read = (start, end) => {
    const task = (async () => {
      const before = performance.now();
      const data = Buffer.allocUnsafe(end - start);
      let position = 0;
      while (position < data.length) {
        const { bytesRead } = await sourceFile.read(data, position, data.length - position, start + position);
        if (!bytesRead) throw Error('Unexpected source EOF');
        position += bytesRead;
      }
      result.readBytes += data.length; result.readCalls++;
      result.readMs += performance.now() - before;
      return data;
    })();
    pendingReads.add(task);
    result.maxActiveReads = Math.max(result.maxActiveReads, pendingReads.size);
    task.then(() => pendingReads.delete(task), () => pendingReads.delete(task));
    return task;
  };
  const source = new MB.StreamSource({ getSize: () => sourceStat.size, read, prefetchProfile: 'fileSystem', maxCacheSize: 8 * 2 ** 20 });
  input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  const tracks = await input.getAudioTracks();
  const track = tracks[audioIndex];
  if (!track || track.codec !== 'aac') throw Error('Selected track must exist and contain AAC for this experiment');
  const decoderConfig = await track.getDecoderConfig();
  const video = await input.getPrimaryVideoTrack();
  result.source.track = { id: track.id, codec: track.codec, name: track.name, sampleRate: track.sampleRate,
    numberOfChannels: track.numberOfChannels, firstTimestamp: await track.getFirstTimestamp(), endTimestamp: await track.computeDuration() };
  result.source.video = video ? { firstTimestamp: await video.getFirstTimestamp(), endTimestamp: await video.computeDuration() } : null;
  result.metadataMs = performance.now() - started;

  const writable = new WritableStream({
    async write({ data, position }) {
      const before = performance.now();
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesWritten } = await outputFile.write(data, offset, data.byteLength - offset, position + offset);
        if (!bytesWritten) throw Error('Zero-byte output write');
        offset += bytesWritten;
      }
      result.writeBytes += data.byteLength; result.writeCalls++;
      result.maxWriteChunkBytes = Math.max(result.maxWriteChunkBytes, data.byteLength);
      result.writeMs += performance.now() - before;
    },
    async close() { await outputFile.close(); outputFile = null; },
  });
  const packetSource = new MB.EncodedAudioPacketSource(track.codec);
  output = new MB.Output({ format: new MB.MkvOutputFormat(), target: new MB.StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
  output.addAudioTrack(packetSource, { name: track.name ?? undefined });
  await output.start();
  for await (const packet of new MB.EncodedPacketSink(track).packets()) {
    if (count === 0) firstTimestamp = packet.timestamp;
    if (previousTimestamp !== undefined) {
      if (packet.timestamp < previousTimestamp) backwards++;
      maxAbsoluteCadenceDeviationSeconds = Math.max(maxAbsoluteCadenceDeviationSeconds,
        Math.abs(packet.timestamp - previousTimestamp - 1024 / track.sampleRate));
    }
    previousTimestamp = packet.timestamp;
    count++; audioBytes += packet.data.byteLength;
    lastTimestamp = packet.timestamp; lastEnd = packet.timestamp + packet.duration;
    hash.update(packet.data);
    packetHash.update(JSON.stringify([packet.timestamp, packet.duration, packet.type, packet.data.length]) + '\n');
    packetHash.update(packet.data);
    ptsHash.update(JSON.stringify([packet.timestamp, packet.type, packet.data.length]) + '\n'); ptsHash.update(packet.data);
    durationHistogram[packet.duration] = (durationHistogram[packet.duration] || 0) + 1;
    if (timeline) await timeline.add(packet);
    await packetSource.add(packet, count === 1 ? { decoderConfig } : undefined);
    if (count % 20000 === 0) console.error(`packets=${count} timestamp=${packet.timestamp.toFixed(1)} elapsed=${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  result.packetLoopEndedMs = performance.now() - started;
  packetSource.close();
  const finalizeStarted = performance.now();
  await output.finalize();
  result.finalizeAndOutputCloseMs = performance.now() - finalizeStarted;
  completed = true;
} catch (error) {
  result.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (!completed && output) {
    try { await output.cancel(); } catch (error) { result.cancelError = String(error); }
  }
  input?.dispose();
  await Promise.allSettled([...pendingReads]);
  if (sourceFile) await sourceFile.close();
  if (outputFile) await outputFile.close();
  if (timeline) result.timeline = await timeline.close();
  result.totalMs = performance.now() - started;
  result.status = completed ? 'complete' : 'failed';
  Object.assign(result, { count, audioBytes, firstTimestamp, lastTimestamp, lastEnd,
    hash: hash.digest('hex'), packetHash: packetHash.digest('hex'), ptsHash: ptsHash.digest('hex'), durationHistogram,
    backwards, maxAbsoluteCadenceDeviationSeconds });
  try { result.outputBytes = outputCreated ? (await stat(outputPath)).size : null; } catch { result.outputBytes = null; }
  if (!completed) result.partialOutputRetained = outputCreated;
  await reportFile.writeFile(JSON.stringify(result, null, 2) + '\n');
  await reportFile.close();
}
console.log(JSON.stringify(result, null, 2));
