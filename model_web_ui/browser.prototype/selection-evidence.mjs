import { createMediaReadSource } from './media-read-source.mjs';

const MAX_CACHED_KEYFRAMES = 120;

// One replaceable visible-window request. Reuses Input/CanvasSink per active file
// session with a bounded keyframe dataURL cache; no whole-source media writes.
export function createSelectionEvidence({ MB, onResult }) {
  let revision = 0, session = null, timer;
  function closeSession() {
    if (!session) return;
    const closing = session;
    session = null;
    closing.input?.dispose();
  }
  function abortPending() {
    revision++;
    clearTimeout(timer);
  }
  function cancel() {
    abortPending();
    closeSession();
  }
  function ensureSession(record) {
    if (session && session.file === record.file) return session;
    closeSession();
    const input = new MB.Input({ source: createMediaReadSource({ MB, file: record.file, priority: 'preview' }), formats: MB.ALL_FORMATS });
    const current = {
      file: record.file,
      input,
      images: new Map(),
      chain: Promise.resolve(),
      ready: (async () => {
        const video = await input.getPrimaryVideoTrack();
        const origin = record.origin ?? Math.max(0, await video.getFirstTimestamp());
        const sink = new MB.CanvasSink(video, { width: 160, fit: 'contain', poolSize: 1 });
        const packets = new MB.EncodedPacketSink(video);
        return { origin, sink, packets };
      })(),
    };
    session = current;
    return current;
  }
  function cacheImage(images, timestamp, entry) {
    if (images.has(timestamp)) images.delete(timestamp);
    else if (images.size >= MAX_CACHED_KEYFRAMES) images.delete(images.keys().next().value);
    images.set(timestamp, entry);
  }
  function request(record, start, end) {
    abortPending();
    const own = revision;
    if (!record) {
      closeSession();
      onResult({ frames: [], status: '关联原录像后显示参考画面' });
      return;
    }
    if (session && session.file !== record.file) closeSession();
    onResult({ frames: [], status: '正在读取原片参考画面…' });
    timer = setTimeout(() => {
      if (own !== revision) return;
      const current = ensureSession(record);
      current.chain = current.chain.then(async () => {
        if (own !== revision || session !== current) return;
        const frames = [];
        try {
          const { origin, sink, packets } = await current.ready;
          if (own !== revision || session !== current) return;
          for (let index = 0; index < 10; index++) {
            if (own !== revision || session !== current) return;
            const target = start + (end - start) * index / 10;
            // Reference pictures need no inter-frame decoding up to the target.
            // Use the preceding verified keyframe and reuse it within this file session.
            const packet = await packets.getKeyPacket(origin + target, { verifyKeyPackets: true })
              ?? await packets.getFirstPacket({ verifyKeyPackets: true });
            if (own !== revision || session !== current) return;
            if (!packet || packet.type !== 'key') throw new Error('没有可用的关键帧参考画面');
            if (!current.images.has(packet.timestamp)) {
              const frame = await sink.getCanvas(packet.timestamp);
              if (own !== revision || session !== current) return;
              cacheImage(current.images, packet.timestamp, frame ? { time: Math.max(0, frame.timestamp - origin), image: frame.canvas.toDataURL('image/jpeg', 0.65) } : null);
            }
            const image = current.images.get(packet.timestamp);
            if (image) frames.push(image);
          }
          if (own !== revision || session !== current) return;
          onResult({ frames, status: '原片参考画面' });
        } catch (error) {
          if (session === current) closeSession();
          if (own === revision) onResult({ frames, status: `原片信息读取失败：${error.message}` });
        }
      });
    }, 300);
  }
  return { request, cancel };
}
