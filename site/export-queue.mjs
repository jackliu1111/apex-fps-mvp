import { MAX_REUSABLE_ARTIFACTS, sourceExportSettings, exportSettings } from './export-policy.mjs';
const copy = (value) => structuredClone(value);
const freeze = (value) => { for (const child of Object.values(value || {})) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

// A storage planning estimate; every batch still requires a directory.
export function estimateExportBytes(batch) {
  const { videoBitrate: video, audioBitrate: audio } = sourceExportSettings(batch.output, { displayWidth: 3840, displayHeight: 2160 });
  return Math.ceil(batch.clips.reduce((bytes, clip) => bytes + 65536 + (clip.end - clip.start) * (video + audio) / 8 * 1.5, 0));
}

/** Serial export execution consumes submission snapshots, never the live editor. */
export function createExportQueue({ convert, canRun = () => true, onChange = () => {}, onOutput = () => {} } = {}) {
  const jobs = new Map();
  let running, disposed = false;
  const artifacts = new Map(), fileIds = new WeakMap();
  let fileSequence = 0;
  const notify = (job) => onChange(copy(job.state));
  const canonical = (value) => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  function artifactKey(job, clip) {
    if (!fileIds.has(job.source.file)) fileIds.set(job.source.file, ++fileSequence);
    const identity = job.batch.source?.fingerprint ? job.batch.source : { sourceId: job.batch.sourceId, fileId: fileIds.get(job.source.file) };
    return JSON.stringify(canonical({ identity, origin: job.source.origin || 0, start: clip.start, end: clip.end, audio: job.batch.audio || {}, output: exportSettings(job.batch.output) }));
  }
  function release(held) {
    artifacts.delete(held.key);
    for (const { job, output } of held.references) { output.available = false; notify(job); }
  }
  async function reusable(held, source) {
    if (!held) return false;
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
  async function permissionState(directory, signal) {
    signal.throwIfAborted();
    let onAbort;
    try {
      return await Promise.race([
        directory.queryPermission({ mode: 'readwrite' }),
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }
  async function run() {
    for (const job of jobs.values()) {
      if (disposed || !canRun() || job.state.status !== 'queued') continue;
      job.controller = new AbortController();
      job.state.status = 'running'; job.state.waitingReason = null; notify(job);
      try {
        for (const [index, clip] of job.batch.clips.entries()) {
          if (job.state.clipResults[index].status === 'completed') continue;
          job.controller.signal.throwIfAborted();
          job.activeIndex = index;
          const directory = job.source.directoryHandle;
          try {
            if (!directory || (directory.queryPermission && await permissionState(directory, job.controller.signal) !== 'granted')) {
              throw new Error('输出目录写入权限不可用，请重新选择目录');
            }
          } catch (error) {
            job.controller.signal.throwIfAborted();
            throw Object.assign(new Error(`无法确认输出目录权限：${error.message || error}`, { cause: error }), { needsDestination: true });
          }
          job.controller.signal.throwIfAborted();
          job.activeIndex = index; job.state.clipResults[index].status = 'running'; notify(job);
          const key = artifactKey(job, clip), cached = artifacts.get(key);
          if (await reusable(cached, job.source)) { job.controller.signal.throwIfAborted(); publishOutput(job, cached, index, true); continue; }
          const { blob, artifact, ...result } = await convert({ batch: job.batch, clip, index, source: job.source,
            signal: job.controller.signal,
            onProgress: (progress) => { job.state.progress = (index + progress) / job.batch.clips.length; notify(job); } });
          if (!result.saved) { job.controller.signal.throwIfAborted(); throw new Error('输出文件尚未成功保存到目录'); }
          if (blob) throw new Error('目录导出不能返回下载成片');
          const output = { ...result, saved: true, available: true,
            destination: { mode: 'directory', name: job.source.directoryHandle.name || '' } };
          const held = { key, output, artifact, directoryHandle: job.source.directoryHandle, references: [] };
          if (artifact) {
            if (artifacts.has(key)) release(artifacts.get(key));
            while (artifacts.size >= MAX_REUSABLE_ARTIFACTS) release(artifacts.values().next().value);
            artifacts.set(key, held);
          }
          publishOutput(job, held, index, false);
        }
        job.state.status = 'completed';
      } catch (error) {
        const needsDestination = error.needsDestination || ['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name);
        job.state.status = job.controller.signal.aborted ? 'cancelled' : needsDestination ? 'awaiting-destination' : 'failed';
        job.state.error = error.message || String(error);
        const active = job.state.clipResults[job.activeIndex];
        if (active && error.cleanupError) (active.cleanupWarnings ||= []).push(job.state.error);
        if (active && active.status !== 'completed') Object.assign(active, { status: job.state.status === 'awaiting-destination' ? 'not-started' : job.state.status, error: job.state.error });
      }
      job.state.waitingReason = null; notify(job);
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
      const job = { batch: freeze(snapshot), source: { ...source }, state: { id: snapshot.id, status: source.directoryHandle ? 'queued' : 'awaiting-destination', progress: 0, outputs: [], error: null,
        destination: source.directoryHandle ? { mode: 'directory', name: source.directoryHandle.name || '' } : null,
        clipResults: snapshot.clips.map(({ id, start, end }) => ({ id, start, end, status: 'not-started', error: null })),
        waitingReason: canRun() ? null : '等待分析释放资源' } };
      jobs.set(snapshot.id, job); notify(job); queue.pump();
      return queue.getBatch(snapshot.id);
    },
    resume(id, directoryHandle) {
      const job = jobs.get(id);
      if (disposed) throw new Error('导出队列已关闭');
      if (!job || job.state.status !== 'awaiting-destination') return;
      if (!directoryHandle) throw new Error('请先选择输出目录');
      job.source.directoryHandle = directoryHandle;
      const destination = { mode: 'directory', name: directoryHandle.name || '' };
      job.state.destination ||= destination;
      job.state.pendingDestination = destination;
      job.state.status = 'queued'; job.state.error = null;
      job.state.waitingReason = canRun() ? null : '等待分析释放资源';
      notify(job); queue.pump();
      return queue.getBatch(id);
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
      if (!job || !['awaiting-destination', 'queued', 'running'].includes(job.state.status)) return;
      job.controller?.abort(new DOMException('本批导出已取消', 'AbortError'));
      if (job.state.status === 'running') {
        job.state.waitingReason = '正在取消，等待当前文件写入结果';
      } else { job.state.status = 'cancelled'; job.state.waitingReason = null; }
      notify(job);
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
