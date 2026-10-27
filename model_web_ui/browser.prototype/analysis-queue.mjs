// Owns task lifetime only. Review navigation and human decisions live elsewhere.
export function createAnalysisQueue({ prepare, analyze, onPrepared = async () => {}, onChange = () => {}, onCandidates = () => {}, release = () => {} }) {
  const records = [], waiters = [], jobs = new Map(), generations = new Map(), prepared = new Set();
  let running = false, preparations = 0, disposed = false;
  const get = (id) => records.find((record) => record.id === id);
  const emit = (record) => onChange(record);
  const stopped = () => new DOMException('分析已停止', 'AbortError');
  function settle() {
    if (!running && preparations === 0 && !records.some((record) => record.status === 'queued')) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  }
  function begin(record) {
    const generation = (generations.get(record.id) || 0) + 1;
    generations.set(record.id, generation);
    const controller = new AbortController();
    jobs.set(record.id, controller);
    return { controller, current: () => generations.get(record.id) === generation && records.includes(record) };
  }
  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      let record;
      while (!disposed && (record = records.find((item) => item.status === 'queued'))) {
        const { controller, current } = begin(record);
        record.status = 'analyzing'; emit(record);
        try {
          await analyze(record, {
            signal: controller.signal,
            publish(candidates, progress = {}) {
              if (controller.signal.aborted || !current()) return;
              record.candidates = candidates; Object.assign(record, progress);
              onCandidates(record, candidates); emit(record);
            },
            progress(update) { if (!controller.signal.aborted && current()) { Object.assign(record, update); emit(record); } },
          });
          if (current()) record.status = controller.signal.aborted ? 'stopped' : 'complete';
        } catch (error) {
          if (current()) { record.status = controller.signal.aborted ? 'stopped' : 'failed'; record.error = controller.signal.aborted ? null : error.message || String(error); }
        }
        if (current()) { jobs.delete(record.id); emit(record); }
      }
    } finally { running = false; settle(); }
  }
  async function prepareOne(record) {
    const { controller, current } = begin(record);
    preparations++;
    try {
      const media = prepared.has(record.id) ? {} : await prepare(record, { signal: controller.signal });
      if (!current() || controller.signal.aborted) { media?.input?.dispose(); return; }
      Object.assign(record, media); prepared.add(record.id);
      await onPrepared(record);
      if (!current() || controller.signal.aborted) return;
      jobs.delete(record.id); record.status = 'queued'; emit(record); void pump();
    } catch (error) {
      if (current()) { record.status = controller.signal.aborted ? 'stopped' : 'failed'; record.error = controller.signal.aborted ? null : error.message || String(error); emit(record); }
    } finally {
      if (current() && jobs.get(record.id) === controller) jobs.delete(record.id);
      preparations--; settle();
    }
  }
  const queue = {
    records, get,
    async importFiles(files, options = {}) {
      if (disposed) throw new Error('分析队列已关闭');
      const added = [...files].map((file) => ({ id: crypto.randomUUID(), file, model: options.model || 'efficientat', threshold: options.threshold ?? 0.2, status: 'preparing', error: null, candidates: [], processedUntil: 0, windows: 0, frontier: -Infinity }));
      records.push(...added); added.forEach(emit);
      await Promise.all(added.map(prepareOne));
      return added;
    },
    stop(id) {
      const record = get(id);
      if (!record || !['preparing', 'queued', 'analyzing'].includes(record.status)) return false;
      jobs.get(id)?.abort(stopped());
      record.status = 'stopped'; emit(record); settle(); return true;
    },
    async retry(id, options = {}) {
      const record = get(id);
      if (!record || disposed || !['stopped', 'failed', 'complete'].includes(record.status)) return false;
      generations.set(id, (generations.get(id) || 0) + 1);
      jobs.get(id)?.abort(stopped()); jobs.delete(id);
      record.model = options.model || record.model; record.threshold = options.threshold ?? record.threshold; record.error = null;
      record.status = 'preparing'; emit(record); await prepareOne(record);
      return true;
    },
    remove(id) {
      const record = get(id);
      if (!record || ['preparing', 'analyzing'].includes(record.status) || jobs.has(id)) return false;
      records.splice(records.indexOf(record), 1); generations.delete(id); prepared.delete(id);
      record.input?.dispose(); settle(); return true;
    },
    whenIdle() { return new Promise((resolve) => { waiters.push(resolve); settle(); }); },
    async dispose() {
      disposed = true;
      for (const record of records) queue.stop(record.id);
      await queue.whenIdle();
      release();
      for (const record of records) record.input?.dispose();
    },
  };
  return queue;
}
