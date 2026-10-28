import { createMediaReadSource } from './media-read-source.mjs';

// One replaceable visible-window request. No whole-source cache or media writes.
export function createSelectionEvidence({ MB, onResult }) {
  let revision = 0, active, timer;
  function cancel() {
    revision++;
    clearTimeout(timer);
    active?.dispose(); active = null;
  }
  function request(record, start, end) {
    cancel();
    const own = revision;
    if (!record) { onResult({ frames: [], peaks: null, status: '关联原录像后显示画面与波形' }); return; }
    onResult({ frames: [], peaks: null, status: '正在读取原片画面与波形…' });
    timer = setTimeout(async () => {
      const input = new MB.Input({ source: createMediaReadSource({ MB, file: record.file, priority: 'preview' }), formats: MB.ALL_FORMATS });
      active = input;
      const frames = [];
      try {
        const video = await input.getPrimaryVideoTrack();
        if (own !== revision) return;
        const origin = record.origin ?? Math.max(0, await video.getFirstTimestamp());
        const sink = new MB.CanvasSink(video, { width: 160, fit: 'contain', poolSize: 1 });
        const packets = new MB.EncodedPacketSink(video);
        const images = new Map();
        for (let index = 0; index < 10; index++) {
          if (own !== revision) return;
          const target = start + (end - start) * index / 10;
          // Reference pictures need no inter-frame decoding up to the target.
          // Use the preceding verified keyframe and reuse it within this window.
          const packet = await packets.getKeyPacket(origin + target, { verifyKeyPackets: true })
            ?? await packets.getFirstPacket({ verifyKeyPackets: true });
          if (own !== revision) return;
          if (!packet || packet.type !== 'key') throw new Error('没有可用的关键帧参考画面');
          if (!images.has(packet.timestamp)) {
            const frame = await sink.getCanvas(packet.timestamp);
            if (own !== revision) return;
            images.set(packet.timestamp, frame ? { time: Math.max(0, frame.timestamp - origin), image: frame.canvas.toDataURL('image/jpeg', 0.65) } : null);
          }
          const image = images.get(packet.timestamp);
          if (image) frames.push(image);
        }
        if (own !== revision) return;
        onResult({ frames, peaks: null, status: end - start > 60 ? '原片参考画面 · 放大至 60 秒内显示波形' : '原片参考画面 · 正在读取波形…' });
        // Limit waveform decoding to a local minute, streamed into fixed buckets.
        if (end - start > 60) return;
        const audio = await input.getPrimaryAudioTrack();
        if (own !== revision) return;
        if (!audio || !await audio.canDecode()) {
          if (own === revision) onResult({ frames, peaks: null, status: '原片参考画面 · 原片声音不可用' });
          return;
        }
        const peaks = new Array(480).fill(0);
        let samples = 0;
        for await (const { buffer, timestamp } of new MB.AudioBufferSink(audio).buffers(origin + start, origin + end)) {
          if (own !== revision) return;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i++) {
              const bucket = Math.floor((timestamp - origin + i / buffer.sampleRate - start) / (end - start) * peaks.length);
              if (bucket >= 0 && bucket < peaks.length) { peaks[bucket] = Math.max(peaks[bucket], Math.abs(data[i])); samples++; }
            }
          }
        }
        if (own === revision) onResult({ frames, peaks: samples ? peaks : null, status: samples ? '原片参考画面 · 波形为原片音频峰值' : '原片参考画面 · 当前范围没有可读音频' });
      } catch (error) {
        if (own === revision) onResult({ frames, peaks: null, status: `原片信息读取失败：${error.message}` });
      } finally { input.dispose(); if (active === input) active = null; }
    }, 300);
  }
  return { request, cancel };
}
