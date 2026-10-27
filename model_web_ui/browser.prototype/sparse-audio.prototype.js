// Experimental reader for an isolated audio-only Input, never preview/export.
export function alignedReader(size, readRange, pageSize = 4096) {
  const cache = new Map();
  return async (start, end) => {
    if (end - start > pageSize * 4) return readRange(start, end);
    const parts = [];
    for (let at = Math.floor(start / pageSize) * pageSize; at < end; at += pageSize) {
      let pending = cache.get(at);
      if (!pending) {
        pending = Promise.resolve(readRange(at, Math.min(size, at + pageSize)));
        cache.set(at, pending);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
      }
      const bytes = await pending;
      parts.push(bytes.subarray(Math.max(0, start - at), Math.min(bytes.length, end - at)));
    }
    if (parts.length === 1) return parts[0];
    const bytes = new Uint8Array(end - start);
    let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
  };
}

export async function openSparseAudio(file, trackId, metrics = {}) {
  const MB = await import('/assets/vendor/mediabunny-sparse.mjs');
  metrics.sparseReadBytes = 0; metrics.sparseReadCalls = 0;
  const source = new MB.StreamSource({
    getSize: () => file.size, prefetchProfile: 'none', maxCacheSize: 8 * 2 ** 20,
    read: alignedReader(file.size, async (start, end) => {
      const data = new Uint8Array(await file.slice(start, end).arrayBuffer());
      metrics.sparseReadBytes += data.length; metrics.sparseReadCalls++;
      return data;
    }),
  });
  source._apexAudioTrackId = trackId;
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  try {
    const track = (await input.getAudioTracks()).find((t) => t.id === trackId);
    if (!track) throw new Error('实验读取器未找到所选音轨');
    return { MB, track, close: () => input.dispose() };
  } catch (error) { input.dispose(); throw error; }
}
