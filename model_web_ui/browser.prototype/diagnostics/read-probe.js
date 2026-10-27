import * as MB from '/assets/vendor/mediabunny.mjs';
const $ = (id) => document.getElementById(id);
const results = [];
let downloadUrl;
async function probe(file, mode, seconds, cacheMiB = 8) {
  const r = { mode, seconds, cacheMiB, requests: [], reads: [], blobReadMs: 0, blobChunks: 0 };
  // Wrap only this test's Blob; leave the vendor and application untouched.
  class TracedBlob extends Blob {
    get size() { return file.size; }
    slice(start, end) {
      const blob = file.slice(start, end), nativeStream = blob.stream.bind(blob);
      blob.stream = () => {
        const reader = nativeStream().getReader();
        return new ReadableStream({
          async pull(controller) {
            const before = performance.now(), value = await reader.read();
            r.blobReadMs += performance.now() - before; r.blobChunks++;
            if (value.done) controller.close(); else controller.enqueue(value.value);
          },
          cancel(reason) { return reader.cancel(reason); },
        }, { highWaterMark: 0 });
      };
      return blob;
    }
  }
  const source = mode.startsWith('range') ? new MB.StreamSource({
    getSize: () => file.size, maxCacheSize: cacheMiB * 2 ** 20,
    prefetchProfile: mode === 'range-none' ? 'none' : 'fileSystem',
    async read(start, end) {
      const before = performance.now();
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      r.blobReadMs += performance.now() - before; r.blobChunks++;
      return bytes;
    },
  }) : new MB.BlobSource(new TracedBlob(), { maxCacheSize: cacheMiB * 2 ** 20 });
  source.onread = (start, end) => r.reads.push({ start, end });
  const read = source._read.bind(source);
  source._read = (start, end) => { r.requests.push({ start, end }); return read(start, end); };
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  const start = performance.now();
  let count = 0, audioBytes = 0, hash = 2166136261;
  try {
    const track = (await input.getAudioTracks())[0];
    r.importMs = performance.now() - start;
    if (mode.startsWith('blob-decode')) {
      const bound = mode === 'blob-decode-fullbound' ? 2639.45 : mode === 'blob-decode-open' ? Infinity : seconds;
      for await (const item of new MB.AudioBufferSink(track).buffers(0, bound)) {
        if (count === 0) {
          r.firstItemMs = performance.now() - start;
          r.firstItemReadBytes = r.reads.reduce((n, x) => n + x.end - x.start, 0);
        }
        if (item.timestamp >= seconds) break;
        count++; audioBytes += item.buffer.length * item.buffer.numberOfChannels * 4;
      }
    } else {
      const sink = new MB.EncodedPacketSink(track);
      for await (const packet of sink.packets()) {
        if (packet.timestamp >= seconds) break;
        count++; audioBytes += packet.data.length;
        for (const byte of packet.data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        if (count % 10000 === 0) $('status').textContent = `${mode}: ${packet.timestamp.toFixed(1)} 秒 / ${seconds}`;
      }
    }
    r.totalMs = performance.now() - start;
    Object.assign(r, { count, audioBytes, packetHashFNV32: mode.startsWith('blob-decode') ? null : hash,
      readBytes: r.reads.reduce((n, x) => n + x.end - x.start, 0) });
    let end = -1, unique = 0;
    for (const x of [...r.reads].sort((a, b) => a.start - b.start)) {
      unique += Math.max(0, x.end - Math.max(x.start, end)); end = Math.max(end, x.end);
    }
    r.uniqueReadBytes = unique; r.repeatedReadBytes = r.readBytes - unique;
    return r;
  } finally { input.dispose(); }
}
async function run(full) {
  const file = $('file').files[0]; if (!file) return;
  $('short').disabled = $('full').disabled = $('startup').disabled = $('file').disabled = true;
  try {
    const cases = full === 'startup' ? [
      ['blob-decode-fullbound', 20, 8], ['blob-decode-open', 20, 8],
      ['blob-decode-fullbound', 20, 8], ['blob-decode-open', 20, 8],
    ] : full ? [['blob-packets', 2640, 8]] : [
      ['blob-packets', 20, 8], ['blob-decode', 20, 8], ['range-filesystem', 20, 8],
      ['range-none', 20, 8], ['blob-packets', 20, 64], ['blob-packets', 20, 8],
    ];
    for (const [mode, seconds, cache] of cases) {
      $('status').textContent = `正在运行 ${mode} / ${seconds} 秒 / ${cache} MiB 缓存`;
      results.push(await probe(file, mode, seconds, cache));
    }
    const report = { file: { name: file.name, size: file.size }, userAgent: navigator.userAgent, results };
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    $('download').href = downloadUrl; $('download').download = 'apex-read-diagnostic.json';
    $('status').textContent = JSON.stringify(results.map(({ requests, reads, ...r }) => ({ ...r, requests: requests.length, reads: reads.length })), null, 2);
  } catch (error) { $('status').textContent = error.stack; }
  finally { $('short').disabled = $('full').disabled = $('startup').disabled = $('file').disabled = false; }
}
$('short').onclick = () => run(false);
$('full').onclick = () => run(true);
$('startup').onclick = () => run('startup');
