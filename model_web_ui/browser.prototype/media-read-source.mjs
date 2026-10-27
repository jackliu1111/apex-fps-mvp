const READ_CHUNK_BYTES = 1024 * 1024;
const schedulers = new WeakMap();

function schedulerFor(file) {
  if (schedulers.has(file)) return schedulers.get(file);
  const jobs = [];
  let running = false, previewBurst = 0;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (jobs.length) {
        const preview = jobs.findIndex((job) => job.priority === 'preview');
        const analysis = jobs.findIndex((job) => job.priority !== 'preview');
        const index = preview >= 0 && (previewBurst < 4 || analysis < 0) ? preview : analysis >= 0 ? analysis : 0;
        const job = jobs.splice(index, 1)[0];
        previewBurst = job.priority === 'preview' ? previewBurst + 1 : 0;
        try {
          job.signal.throwIfAborted();
          const bytes = new Uint8Array(await file.slice(job.start, job.end).arrayBuffer());
          job.signal.throwIfAborted(); job.resolve(bytes);
        } catch (error) { job.reject(error); }
      }
    } finally { running = false; }
  }
  const schedule = (start, end, priority, signal) => new Promise((resolve, reject) => {
    jobs.push({ start, end, priority, signal, resolve, reject }); void drain();
  });
  schedulers.set(file, schedule);
  return schedule;
}

/**
 * Analysis and review share bounded reads of the same File, with fair preview priority.
 * Independent open-ended Blob readers can stall preview for seconds during a sequential
 * scan. One outstanding 1 MiB file read bounds this contention; every four preview chunks
 * an awaiting analysis chunk gets a turn. Navigation never stops the analysis task.
 * Each Input still owns an 8 MiB parser cache and its own disposal/cancellation lifetime.
 */
export function createMediaReadSource({ MB, file, priority = 'analysis' }) {
  const schedule = schedulerFor(file), controller = new AbortController();
  return new MB.StreamSource({
    getSize: () => file.size,
    prefetchProfile: 'fileSystem',
    maxCacheSize: 8 * 1024 * 1024,
    async read(start, end) {
      controller.signal.throwIfAborted();
      const result = new Uint8Array(end - start);
      for (let at = start; at < end; at += READ_CHUNK_BYTES) {
        const bytes = await schedule(at, Math.min(end, at + READ_CHUNK_BYTES), priority, controller.signal);
        result.set(bytes, at - start);
      }
      return result;
    },
    dispose: () => controller.abort(new DOMException('媒体读取已停止', 'AbortError')),
  });
}
