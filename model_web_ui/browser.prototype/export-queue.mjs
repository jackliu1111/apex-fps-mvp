import { MAX_EXPORT_MEMORY_BYTES, MAX_REUSABLE_ARTIFACTS, exportSettings } from './export-policy.mjs';
const copy = (value) => structuredClone(value);
const freeze = (value) => { for (const child of Object.values(value || {})) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

export function estimateExportBytes(batch) {
  const { videoBitrate: video, audioBitrate: audio } = exportSettings(batch.output);
  return Math.ceil(batch.clips.reduce((bytes, clip) => bytes + 65536 + (clip.end - clip.start) * (video + audio) / 8 * 1.5, 0));
}

/** Serial export execution consumes submission snapshots, never the live editor. */
export function createExportQueue({ convert, canRun = () => true, onChange = () => {}, onOutput = () => {},
  maxMemoryBytes = MAX_EXPORT_MEMORY_BYTES, urls = URL } = {}) {
  if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes < 1) throw new Error('下载缓存预算无效');
  maxMemoryBytes = Math.floor(Math.min(maxMemoryBytes, MAX_EXPORT_MEMORY_BYTES));
  const jobs = new Map();
  let running, disposed = false;
  const retained = [], artifacts = new Map(), fileIds = new WeakMap();
  let retainedBytes = 0, fileSequence = 0;
  const notify = (job) => onChange(copy(job.state));
  const canonical = (value) => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  function artifactKey(job, clip) {
    if (!fileIds.has(job.source.file)) fileIds.set(job.source.file, ++fileSequence);
    const identity = job.batch.source?.fingerprint ? job.batch.source : { sourceId: job.batch.sourceId, fileId: fileIds.get(job.source.file) };
    return JSON.stringify(canonical({ identity, origin: job.source.origin || 0, start: clip.start, end: clip.end, audio: job.batch.audio || {}, output: exportSettings(job.batch.output) }));
  }
  function release(held) {
    artifacts.delete(held.key);
    if (held.output.url) {
      urls.revokeObjectURL(held.output.url); retainedBytes -= held.output.bytes;
      retained.splice(retained.indexOf(held), 1);
    }
    for (const { job, output } of held.references) { output.url = null; output.available = false; notify(job); }
  }
  function releaseOldest() { if (retained.length) release(retained[0]); }
  async function reusable(held, source) {
    if (!held) return false;
    if (held.output.url) return !source.directoryHandle;
    if (!held.artifact || !source.directoryHandle) return false;
    try {
      const sameDirectory = held.directoryHandle === source.directoryHandle || await held.directoryHandle.isSameEntry?.(source.directoryHandle);
      if (!sameDirectory) return false;
      const file = await held.artifact.fileHandle.getFile();
      if (file.size === held.artifact.size && file.lastModified === held.artifact.lastModified) return true;
    } catch { /* A removed file or revoked permission cannot be reused. */ }
    release(held); return false;
  }
  function publishOutput(job, held, index, reused) {
    const output = { ...held.output, reused };
    Object.assign(job.state.clipResults[index], { status: 'completed', outputIndex: job.state.outputs.length, error: null });
    held.references.push({ job, output }); job.state.outputs.push(output);
    job.state.progress = (index + 1) / job.batch.clips.length;
    notify(job); onOutput(job.batch.id, copy(output));
  }
  async function run() {
    for (const job of jobs.values()) {
      if (disposed || !canRun() || job.state.status !== 'queued') continue;
      job.controller = new AbortController();
      job.state.status = 'running'; job.state.waitingReason = null; notify(job);
      try {
        for (const [index, clip] of job.batch.clips.entries()) {
          job.controller.signal.throwIfAborted();
          job.activeIndex = index; job.state.clipResults[index].status = 'running'; notify(job);
          const key = artifactKey(job, clip), cached = artifacts.get(key);
          if (await reusable(cached, job.source)) { job.controller.signal.throwIfAborted(); publishOutput(job, cached, index, true); continue; }
          const expectedBytes = estimateExportBytes({ ...job.batch, clips: [clip] });
          while (!job.source.directoryHandle && retained.length && maxMemoryBytes - retainedBytes < expectedBytes) releaseOldest();
          const memoryBudgetBytes = maxMemoryBytes - retainedBytes;
          const { blob, artifact, ...result } = await convert({ batch: job.batch, clip, index, source: job.source,
            signal: job.controller.signal, memoryBudgetBytes,
            onProgress: (progress) => { job.state.progress = (index + progress) / job.batch.clips.length; notify(job); } });
          if (!result.saved) job.controller.signal.throwIfAborted();
          if (blob && blob.size > memoryBudgetBytes) throw new Error('成片超出内存预算，请选择输出目录后重新提交');
          const output = { ...result, bytes: blob?.size ?? result.bytes, saved: Boolean(result.saved), available: true,
            url: blob ? urls.createObjectURL(blob) : null };
          const held = { key, output, artifact, directoryHandle: job.source.directoryHandle, references: [] };
          if (blob || artifact) {
            if (artifacts.has(key)) release(artifacts.get(key));
            while (artifacts.size >= MAX_REUSABLE_ARTIFACTS) release(artifacts.values().next().value);
            artifacts.set(key, held);
            if (blob) { retained.push(held); retainedBytes += blob.size; }
          }
          publishOutput(job, held, index, false);
        }
        job.controller.signal.throwIfAborted(); job.state.status = 'completed';
      } catch (error) {
        job.state.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.state.error = error.message || String(error);
        const active = job.state.clipResults[job.activeIndex];
        if (active && active.status !== 'completed') Object.assign(active, { status: job.state.status, error: job.state.error });
      }
      notify(job);
    }
  }
  const queue = {
    enqueue(batch, source) {
      if (disposed) throw new Error('导出队列已关闭');
      if (jobs.has(batch.id)) throw new Error('该批次已经提交');
      const snapshot = copy(batch);
      snapshot.clips = snapshot.clips.filter((clip) => !clip.provisional).sort((a, b) => a.start - b.start);
      if (!snapshot.clips.length) throw new Error('没有范围确定的选片');
      if (snapshot.clips.some((clip) => !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start)) throw new Error('提交范围无效');
      if (estimateExportBytes(snapshot) > maxMemoryBytes && !source.directoryHandle) throw new Error('本批预计超过下载缓存预算，请先选择输出目录');
      const job = { batch: freeze(snapshot), source: { ...source }, state: { id: snapshot.id, status: 'queued', progress: 0, outputs: [], error: null,
        clipResults: snapshot.clips.map(({ id, start, end }) => ({ id, start, end, status: 'not-started', error: null })),
        waitingReason: canRun() ? null : '等待分析释放资源' } };
      jobs.set(snapshot.id, job); notify(job); queue.pump();
      return queue.getBatch(snapshot.id);
    },
    pump() {
      if (!running) running = run().finally(() => {
        running = null;
        if (!disposed && canRun() && [...jobs.values()].some((job) => job.state.status === 'queued')) queue.pump();
      });
      return running;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job || !['queued', 'running'].includes(job.state.status)) return;
      job.controller?.abort(new DOMException('本批导出已取消', 'AbortError'));
      const active = job.state.clipResults[job.activeIndex];
      if (active?.status === 'running') active.status = 'cancelled';
      job.state.status = 'cancelled'; job.state.waitingReason = null; notify(job);
    },
    async whenIdle() { while (running) await running; },
    getBatch(id) { return jobs.has(id) ? copy(jobs.get(id).state) : null; },
    list() { return [...jobs.values()].map((job) => copy(job.state)); },
    async dispose() {
      disposed = true; for (const id of jobs.keys()) queue.cancel(id);
      await running;
      for (const held of artifacts.values()) release(held);
    },
  };
  return queue;
}
