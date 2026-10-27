const copy = (value) => structuredClone(value);
const freeze = (value) => { for (const child of Object.values(value || {})) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

export function estimateExportBytes(batch) {
  const video = batch.output?.videoBitrate ?? 2000000, audio = batch.output?.audioBitrate ?? 96000;
  if (![video, audio].every((value) => Number.isFinite(value) && value > 0)) throw new Error('输出码率无效');
  return Math.ceil(batch.clips.reduce((bytes, clip) => bytes + 65536 + (clip.end - clip.start) * (video + audio) / 8 * 1.5, 0));
}

/** Serial export execution consumes submission snapshots, never the live editor. */
export function createExportQueue({ convert, canRun = () => true, onChange = () => {}, onOutput = () => {},
  maxMemoryBytes = 64 * 1024 * 1024, urls = URL } = {}) {
  if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes < 1) throw new Error('下载缓存预算无效');
  maxMemoryBytes = Math.floor(Math.min(maxMemoryBytes, 64 * 1024 * 1024));
  const jobs = new Map();
  let running, disposed = false;
  const retained = [];
  let retainedBytes = 0;
  const notify = (job) => onChange(copy(job.state));
  function releaseOldest() {
    const held = retained.shift();
    if (!held) return;
    urls.revokeObjectURL(held.output.url); held.output.url = null; held.output.available = false;
    retainedBytes -= held.output.bytes; notify(held.job);
  }
  async function run() {
    for (const job of jobs.values()) {
      if (disposed || !canRun() || job.state.status !== 'queued') continue;
      job.controller = new AbortController();
      job.state.status = 'running'; job.state.waitingReason = null; notify(job);
      try {
        for (const [index, clip] of job.batch.clips.entries()) {
          job.controller.signal.throwIfAborted();
          const expectedBytes = estimateExportBytes({ ...job.batch, clips: [clip] });
          while (!job.source.directoryHandle && retained.length && maxMemoryBytes - retainedBytes < expectedBytes) releaseOldest();
          const memoryBudgetBytes = maxMemoryBytes - retainedBytes;
          const { blob, ...result } = await convert({ batch: job.batch, clip, index, source: job.source,
            signal: job.controller.signal, memoryBudgetBytes,
            onProgress: (progress) => { job.state.progress = (index + progress) / job.batch.clips.length; notify(job); } });
          if (!result.saved) job.controller.signal.throwIfAborted();
          if (blob && blob.size > memoryBudgetBytes) throw new Error('成片超出内存预算，请选择输出目录后重新提交');
          const output = { ...result, bytes: blob?.size ?? result.bytes, saved: Boolean(result.saved), available: true,
            url: blob ? urls.createObjectURL(blob) : null };
          job.state.outputs.push(output); job.state.progress = (index + 1) / job.batch.clips.length;
          if (blob) { retained.push({ job, output }); retainedBytes += blob.size; }
          notify(job); onOutput(job.batch.id, copy(output));
        }
        job.controller.signal.throwIfAborted(); job.state.status = 'completed';
      } catch (error) { job.state.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.state.error = error.message || String(error); }
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
      job.state.status = 'cancelled'; job.state.waitingReason = null; notify(job);
    },
    async whenIdle() { while (running) await running; },
    getBatch(id) { return jobs.has(id) ? copy(jobs.get(id).state) : null; },
    list() { return [...jobs.values()].map((job) => copy(job.state)); },
    async dispose() {
      disposed = true; for (const id of jobs.keys()) queue.cancel(id);
      await running;
      while (retained.length) releaseOldest();
    },
  };
  return queue;
}
