// Diagnostic experiment: bounded, independent byte scans; demux state remains serial.
import { alignedReader } from '../sparse-audio.prototype.js';
export function clusterPrefetch(size, readRange, concurrency, metrics = {}) {
  if (![1, 2, 4, 8].includes(concurrency)) throw Error('Invalid concurrency');
  const tasks = new Map();
  let closed = false, retained = 0;
  Object.assign(metrics, { clusters: 0, fallback: 0, maxTasks: 0, maxRetainedBytes: 0 });
  const boundaryRead = alignedReader(size, readRange);
  function vint(bytes, at, strip) {
    let width = 1;
    while (width <= 8 && !(bytes[at] & (1 << (8 - width)))) width++;
    if (width > 8 || at + width > bytes.length) throw Error('Invalid EBML integer');
    let value = strip ? bytes[at] & ((1 << (8 - width)) - 1) : bytes[at];
    let unknown = strip && value === (1 << (8 - width)) - 1;
    for (let i = 1; i < width; i++) { value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i] === 255; }
    if (!unknown && !Number.isSafeInteger(value)) throw Error('Unsafe EBML size');
    return { value, width, unknown };
  }
  async function header(read, pos, limit) {
    const b = await read(pos, Math.min(limit, pos + 12));
    const id = vint(b, 0, false), length = vint(b, id.width, true);
    if (length.unknown) throw Error('Unknown element size');
    const data = pos + id.width + length.width, end = data + length.value;
    if (end > limit || end <= pos) throw Error('Invalid element boundary');
    return { start: pos, id: id.value, data, end };
  }
  async function scan(start, end, track) {
    const read = alignedReader(size, readRange), parts = [];
    let bytes = 0;
    const trackAt = async e => vint(await read(e.data, Math.min(e.end, e.data + 8)), 0, true).value;
    try {
      for (let pos = start; pos < end;) {
        if (closed) throw Error('Closed');
        const e = await header(read, pos, end);
        let keep = e.id === 0xe7;
        if (e.id === 0xa3) keep = await trackAt(e) === track;
        if (e.id === 0xa0) {
          for (let p = e.data; p < e.end;) {
            const child = await header(read, p, e.end);
            if (child.id === 0xa1) { keep = await trackAt(child) === track; break; }
            p = child.end;
          }
        }
        if (keep) {
          if (bytes + e.end - e.start > 2 * 2 ** 20) throw Error('Cluster retention limit');
          const data = (await read(e.start, e.end)).slice();
          parts.push({ start: e.start, data }); bytes += data.length; retained += data.length;
          metrics.maxRetainedBytes = Math.max(metrics.maxRetainedBytes, retained);
        }
        pos = e.end;
      }
      metrics.clusters++;
      return { parts, bytes };
    } catch { retained -= bytes; metrics.fallback++; return { parts: null, bytes: 0 }; }
  }
  function launch(start, end, track) {
    const task = { end, promise: scan(start, end, track) };
    tasks.set(start, task); metrics.maxTasks = Math.max(metrics.maxTasks, tasks.size);
    return task;
  }
  async function clear() {
    for (const task of tasks.values()) retained -= (await task.promise).bytes;
    tasks.clear();
  }
  return {
    async take(start, end, track) {
      if (!tasks.has(start)) await clear(); // seek: settle old bounded work before restarting
      const current = tasks.get(start) || launch(start, end, track);
      let next = [...tasks.values()].at(-1).end;
      // Exact known-size Segment child boundaries, no assumption that Cues cover every Cluster.
      while (!closed && tasks.size < concurrency && next < size) {
        try {
          const e = await header(boundaryRead, next, size);
          if (e.id === 0x1f43b675) launch(e.data, e.end, track);
          else if (![0xec, 0xbf, 0x1c53bb6b, 0x1254c367].includes(e.id)) break;
          next = e.end;
        } catch { break; }
      }
      const result = await current.promise;
      tasks.delete(start); retained -= result.bytes;
      return result.parts;
    },
    async close() { closed = true; await clear(); },
  };
}
