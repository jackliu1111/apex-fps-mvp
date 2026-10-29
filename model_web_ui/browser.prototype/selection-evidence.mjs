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
    if (!record) { onResult({ frames: [], status: '关联原录像后显示参考画面' }); return; }
    onResult({ frames: [], status: '正在读取原片参考画面…' });
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
        onResult({ frames, status: '原片参考画面' });
      } catch (error) {
        if (own === revision) onResult({ frames, status: `原片信息读取失败：${error.message}` });
      } finally { input.dispose(); if (active === input) active = null; }
    }, 300);
  }
  return { request, cancel };
}
