import { createMediaReadSource } from './media-read-source.mjs';

const MAX_CACHED_KEYFRAMES = 120;

// One replaceable visible-window request. Reuses Input/CanvasSink per active file
// session with a bounded keyframe dataURL cache; no whole-source media writes.
export function createSelectionEvidence({ MB, onResult, isBusy }) {
  let revision = 0, session = null, timer;
  const yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
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
      packetTimestamps: new Map(),
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
  function previewFromCache(images, start, end) {
    const available = [...images.values()].filter(Boolean).sort((a, b) => a.time - b.time);
    if (!available.length) return [];
    const span = Math.max(0, end - start);
    return Array.from({ length: 10 }, (_, index) => {
      const target = start + span * index / 10;
      let chosen = available[0];
      for (const item of available) {
        if (item.time <= target + 0.05) chosen = item;
        else break;
      }
      return chosen;
    });
  }
  function request(record, start, end) {
    abortPending();
    const own = revision;
    if (!record) {
      closeSession();
      onResult({ frames: [], provisional: false, status: '关联原录像后显示参考画面' });
      return;
    }
    if (session && session.file !== record.file) closeSession();
    const previewFrames = session ? previewFromCache(session.images, start, end) : [];
    onResult({ frames: previewFrames, provisional: true, status: '正在读取原片参考画面…' });
    timer = setTimeout(() => {
      if (own !== revision) return;
      const current = ensureSession(record);
      current.chain = current.chain.then(async () => {
        if (own !== revision || session !== current) return;
        for (let wait = 0; wait < 6 && own === revision && isBusy?.(); wait++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (own !== revision || session !== current) return;
        const frames = [];
        try {
          const { origin, sink, packets } = await current.ready;
          if (own !== revision || session !== current) return;
          for (let index = 0; index < 10; index++) {
            if (own !== revision || session !== current) return;
            const target = start + (end - start) * index / 10;
            const targetKey = Math.round((origin + target) * 1000);
            let packetTimestamp = current.packetTimestamps.get(targetKey);
            if (packetTimestamp === undefined || !current.images.has(packetTimestamp)) {
              // Reference pictures need no inter-frame decoding up to the target.
              // Use the preceding verified keyframe and reuse it within this file session.
              const packet = await packets.getKeyPacket(origin + target, { verifyKeyPackets: true })
                ?? await packets.getFirstPacket({ verifyKeyPackets: true });
              if (own !== revision || session !== current) return;
              if (!packet || packet.type !== 'key') throw new Error('没有可用的关键帧参考画面');
              packetTimestamp = packet.timestamp;
              if (current.packetTimestamps.size >= MAX_CACHED_KEYFRAMES * 4) {
                current.packetTimestamps.delete(current.packetTimestamps.keys().next().value);
              }
              current.packetTimestamps.set(targetKey, packetTimestamp);
            }
            if (!current.images.has(packetTimestamp)) {
              const frame = await sink.getCanvas(packetTimestamp);
              if (own !== revision || session !== current) return;
              cacheImage(current.images, packetTimestamp, frame ? { time: Math.max(0, frame.timestamp - origin), image: frame.canvas.toDataURL('image/jpeg', 0.65) } : null);
              if (index < 9) await yieldTurn();
            }
            const image = current.images.get(packetTimestamp);
            if (image) frames.push(image);
          }
          if (own !== revision || session !== current) return;
          onResult({ frames, provisional: false, status: '原片参考画面' });
        } catch (error) {
          if (session === current) closeSession();
          if (own === revision) onResult({ frames, provisional: false, status: `原片信息读取失败：${error.message}` });
        }
      });
    }, 240);
  }
  return { request, cancel };
}
