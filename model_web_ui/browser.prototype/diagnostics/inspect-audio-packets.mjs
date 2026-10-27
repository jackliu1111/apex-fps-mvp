// Compact packet parity report; reads only the specified audio file and keeps no trace.
// Usage: node inspect-audio-packets.mjs audio.mka [report.json] [audio-index=0] [timeline.bin]
import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as MB from '/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny.mjs';
import { packetTimeline } from './packet-timeline.mjs';
const [path, reportPath, indexArg = '0', timelinePath] = process.argv.slice(2);
if (!path) throw Error('Usage: node inspect-audio-packets.mjs audio.mka [report.json] [audio-index=0]');
const file = await open(path, 'r'), fileStat = await file.stat();
const pendingReads = new Set();
const input = new MB.Input({ source: new MB.StreamSource({ getSize: () => fileStat.size, prefetchProfile: 'fileSystem', read: (start, end) => {
  const task = (async () => {
    const b = Buffer.allocUnsafe(end - start); let offset = 0;
    while (offset < b.length) { const { bytesRead } = await file.read(b, offset, b.length - offset, start + offset); if (!bytesRead) throw Error('Unexpected EOF'); offset += bytesRead; }
    return b;
  })();
  pendingReads.add(task);
  task.then(() => pendingReads.delete(task), () => pendingReads.delete(task));
  return task;
} }), formats: MB.ALL_FORMATS });
const hash = createHash('sha256'), packetHash = createHash('sha256');
const ptsHash = createHash('sha256'), durationHistogram = {};
const timestamps = createHash('sha256');
const timeline = await packetTimeline(timelinePath);
const started = performance.now();
try {
  const tracks = await input.getAudioTracks(), track = tracks[Number(indexArg)];
  if (!track) throw Error('Selected audio track does not exist');
  let count = 0, audioBytes = 0, firstTimestamp, lastTimestamp, lastEnd, backwards = 0, maxAbsoluteCadenceDeviationSeconds = 0;
  const firstPackets = [], lastPackets = [];
  for await (const p of new MB.EncodedPacketSink(track).packets()) {
    if (!count) firstTimestamp = p.timestamp;
    if (lastTimestamp !== undefined) {
      if (p.timestamp < lastTimestamp) backwards++;
      maxAbsoluteCadenceDeviationSeconds = Math.max(maxAbsoluteCadenceDeviationSeconds, Math.abs(p.timestamp - lastTimestamp - 1024 / track.sampleRate));
    }
    count++; audioBytes += p.data.length; lastTimestamp = p.timestamp; lastEnd = p.timestamp + p.duration;
    hash.update(p.data);
    packetHash.update(JSON.stringify([p.timestamp, p.duration, p.type, p.data.length]) + '\n'); packetHash.update(p.data);
    ptsHash.update(JSON.stringify([p.timestamp, p.type, p.data.length]) + '\n'); ptsHash.update(p.data);
    durationHistogram[p.duration] = (durationHistogram[p.duration] || 0) + 1;
    if (timeline) await timeline.add(p);
    timestamps.update(JSON.stringify([p.timestamp, p.duration]) + '\n');
    const summary = [p.timestamp, p.duration, p.type, p.data.length];
    if (firstPackets.length < 3) firstPackets.push(summary);
    lastPackets.push(summary); if (lastPackets.length > 3) lastPackets.shift();
  }
  const report = { path, bytes: fileStat.size, audioTrackCount: tracks.length, videoTrackCount: (await input.getVideoTracks()).length,
    audioIndex: Number(indexArg), codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.numberOfChannels,
    reportedEndTimestamp: await track.computeDuration(), count, audioBytes, firstTimestamp, lastTimestamp, lastEnd, backwards,
    maxAbsoluteCadenceDeviationSeconds, hash: hash.digest('hex'), packetHash: packetHash.digest('hex'),
    ptsHash: ptsHash.digest('hex'), durationHistogram,
    timestampHash: timestamps.digest('hex'), firstPackets, lastPackets, totalMs: performance.now() - started };
  if (timeline) report.timeline = await timeline.close();
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  input.dispose(); await Promise.allSettled([...pendingReads]);
  try { await timeline?.close(); } finally { await file.close(); }
}
