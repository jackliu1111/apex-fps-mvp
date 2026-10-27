import { alignedReader } from '../sparse-audio.prototype.js';
import { clusterPrefetch } from './cluster-prefetch.js';
const $ = id => document.getElementById(id);
let url;
$('run').onclick = async () => {
  const file = $('file').files[0]; if (!file) return;
  const results = [], modes = $('modes').value.split(',');
  const seconds = Number($('seconds').value);
  $('run').disabled = true;
  try {
    for (const mode of modes) {
      $('status').textContent = `正在运行 ${mode}`;
      const MB = await import(`/assets/vendor/mediabunny${mode === 'original' ? '' : '-concurrent'}.mjs`);
      const metrics = { readBytes: 0, readCalls: 0, maxActiveReads: 0 }; let active = 0;
      const read = async (a, b) => {
        active++; metrics.maxActiveReads = Math.max(metrics.maxActiveReads, active);
        try { const bytes = new Uint8Array(await file.slice(a, b).arrayBuffer()); metrics.readBytes += bytes.length; metrics.readCalls++; return bytes; }
        finally { active--; }
      };
      const source = mode === 'original' ? new MB.BlobSource(file) : new MB.StreamSource({ getSize: () => file.size, read: alignedReader(file.size, read), prefetchProfile: 'none', maxCacheSize: 8 * 2 ** 20 });
      if (mode === 'original') source.onread = (a, b) => { metrics.readBytes += b - a; metrics.readCalls++; };
      const prefetch = mode === 'original' ? null : clusterPrefetch(file.size, read, Number(mode), metrics);
      if (prefetch) source._apexClusterPrefetch = prefetch;
      const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
      let count = 0, audioBytes = 0, hash = 2166136261, metadataHash = 2166136261;
      const encoder = new TextEncoder();
      const started = performance.now();
      try {
        const track = (await input.getAudioTracks())[0];
        if (prefetch) source._apexAudioTrackId = track.id;
        for await (const p of new MB.EncodedPacketSink(track).packets()) {
          if (p.timestamp >= seconds) break;
          count++; audioBytes += p.data.length;
          for (const b of p.data) hash = Math.imul(hash ^ b, 16777619) >>> 0;
          for (const b of encoder.encode(JSON.stringify([p.timestamp, p.duration, p.type, p.data.length]) + '\n')) metadataHash = Math.imul(metadataHash ^ b, 16777619) >>> 0;
          if (count % 10000 === 0) $('status').textContent = `模式 ${mode}: ${p.timestamp.toFixed(0)} / ${seconds} 秒\n已完成：${JSON.stringify(results)}`;
        }
        const totalMs = performance.now() - started;
        if (prefetch) await prefetch.close();
        results.push({ mode, totalMs, count, audioBytes, hash, metadataHash, ...metrics });
      } finally { if (prefetch) await prefetch.close(); input.dispose(); }
      if (results.some(r => r.hash !== hash || r.metadataHash !== metadataHash || r.count !== count)) throw Error('Packet parity failure');
      const report = { file: { name: file.name, size: file.size }, seconds, userAgent: navigator.userAgent, results };
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      $('download').href = url; $('download').download = 'apex-cluster-browser.json';
    }
    $('status').textContent = JSON.stringify(results, null, 2);
  } catch (e) { $('status').textContent = e.stack; }
  finally { $('run').disabled = false; }
};
