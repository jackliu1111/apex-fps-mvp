const PREVIEW_CHUNK_BYTES = 4 * 1024 * 1024;
const BACKGROUND_IDLE_CHUNK_BYTES = 4 * 1024 * 1024;
const BACKGROUND_CONTENDED_CHUNK_BYTES = 1 * 1024 * 1024;
const PREVIEW_ACTIVE_WINDOW_MS = 2000;
const MAX_PREVIEW_BURST = 8;

const PRIORITY_RANK = Object.freeze({
  preview: 0,
  thumbnail: 1,
  prepare: 2,
  export: 3,
  analysis: 4,
});

function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.analysis;
}

const globalJobs = [];
let running = false;
let previewBurst = 0;
let urgentCount = 0;
let lastPreviewAtMs = 0;

function isPreviewHot() {
  if (urgentCount > 0) return true;
  if (lastPreviewAtMs > 0 && Date.now() - lastPreviewAtMs < PREVIEW_ACTIVE_WINDOW_MS) return true;
  return globalJobs.some((job) => job.priority === 'preview');
}

function pickNextJobIndex() {
  const previewIndex = globalJobs.findIndex((job) => job.priority === 'preview');
  if (urgentCount > 0) return previewIndex;

  let bestBackgroundIndex = -1;
  let bestBackgroundRank = Infinity;
  for (let i = 0; i < globalJobs.length; i++) {
    const job = globalJobs[i];
    if (job.priority === 'preview') continue;
    const rank = priorityRank(job.priority);
    if (rank < bestBackgroundRank) {
      bestBackgroundRank = rank;
      bestBackgroundIndex = i;
    }
  }

  if (previewIndex >= 0 && (previewBurst < MAX_PREVIEW_BURST || bestBackgroundIndex < 0)) {
    return previewIndex;
  }
  return bestBackgroundIndex >= 0 ? bestBackgroundIndex : previewIndex;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (globalJobs.length) {
      const index = pickNextJobIndex();
      if (index < 0) break;
      const job = globalJobs.splice(index, 1)[0];
      job.detachAbort?.();
      if (job.priority === 'preview') {
        previewBurst++;
        lastPreviewAtMs = Date.now();
      } else {
        previewBurst = 0;
      }
      try {
        job.signal?.throwIfAborted();
        const bytes = new Uint8Array(await job.file.slice(job.start, job.end).arrayBuffer());
        job.signal?.throwIfAborted();
        job.resolve(bytes);
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Mark an urgent preview phase (loading or seeking) so background disk reads defer
 * until the target frame is ready. Returns an idempotent release function.
 */
export function acquirePreviewUrgent() {
  let released = false;
  urgentCount++;
  lastPreviewAtMs = Date.now();
  return () => {
    if (released) return;
    released = true;
    urgentCount = Math.max(0, urgentCount - 1);
    void drain();
  };
}

/**
 * Schedule a bounded single-flight read slice on the global cross-file I/O queue.
 * Serializing across files prevents OS/HDD sequential read-ahead on one file from
 * starving preview reads or seeks on another file.
 */
export function scheduleFileRead(file, start, end, { priority = 'analysis', signal = null } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (priority === 'preview') lastPreviewAtMs = Date.now();
  return new Promise((resolve, reject) => {
    const job = { file, start, end, priority, signal, resolve, reject, detachAbort: null };
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        const idx = globalJobs.indexOf(job);
        if (idx >= 0) {
          globalJobs.splice(idx, 1);
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      job.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
    globalJobs.push(job);
    void drain();
  });
}

/**
 * Global cross-file media reader with strict preview priority and bounded chunks.
 * One in-flight disk read across all imported files eliminates cross-file HDD/USB
 * starvation when analyzing one recording while loading, seeking, or playing another.
 * Background analysis uses 4 MiB chunks when idle and shrinks to 1 MiB while preview
 * is active to bound head-of-line latency; every eight preview chunks an awaiting
 * background chunk still gets a turn outside urgent load/seek windows.
 * Each Input still owns an 8 MiB parser cache and its own disposal/cancellation lifetime.
 */
export function createMediaReadSource({ MB, file, priority = 'analysis', prefetchProfile = 'fileSystem' }) {
  const controller = new AbortController();
  let currentPriority = priority;
  let source;
  const options = {
    file,
    priority,
    getSize: () => file.size,
    prefetchProfile,
    maxCacheSize: 8 * 1024 * 1024,
    async read(start, end) {
      controller.signal.throwIfAborted();
      const result = new Uint8Array(end - start);
      let at = start;
      while (at < end) {
        const chunkBytes = currentPriority === 'preview'
          ? PREVIEW_CHUNK_BYTES
          : isPreviewHot() ? BACKGROUND_CONTENDED_CHUNK_BYTES : BACKGROUND_IDLE_CHUNK_BYTES;
        const nextEnd = Math.min(end, at + chunkBytes);
        const bytes = await scheduleFileRead(file, at, nextEnd, { priority: currentPriority, signal: controller.signal });
        result.set(bytes, at - start);
        at = nextEnd;
      }
      return result;
    },
    dispose: () => controller.abort(new DOMException('媒体读取已停止', 'AbortError')),
  };
  const setPriority = (next) => {
    currentPriority = next;
    if (source) source.priority = next;
  };
  if (!MB.StreamSource) {
    source = Object.assign(new MB.BlobSource(file), { priority: currentPriority, setPriority, dispose: options.dispose });
    return source;
  }
  source = Object.assign(new MB.StreamSource(options), { file, priority: currentPriority, setPriority, dispose: options.dispose });
  return source;
}
