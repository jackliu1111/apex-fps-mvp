import { createAnalysisQueue } from './analysis-queue.mjs';
import { sequentialAudio } from './stream-audio.js';
import { createMediaReadSource } from './media-read-source.mjs';

export function candidatesFromScores(record, threshold = record.threshold, frontier = record.frontier) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('阈值须在 0 到 1 之间');
  const events = [];
  if (record.windowScores) {
    for (const window of record.windowScores) if (Math.max(...window.scores) > threshold) events.push({ start: window.start, end: window.end });
  } else if (record.scores) {
    const length = record.scores.length / 2;
    const smooth = (index, category) => [record.scores[Math.max(0, index - 1) * 2 + category], record.scores[index * 2 + category], record.scores[Math.min(length - 1, index + 1) * 2 + category]].sort((a, b) => a - b)[1];
    let start = null;
    for (let index = 0; index <= length; index++) {
      const hit = index < length && (smooth(index, 0) > threshold || smooth(index, 1) > threshold);
      if (hit && start === null) start = index * 0.04;
      if (!hit && start !== null) {
        events.push({ start: start + record.audioOffset, end: Math.min(index * 0.04, record.audioDuration) + record.audioOffset }); start = null;
      }
    }
  }
  const groups = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && event.start - last.end <= 5) last.end = Math.max(last.end, event.end);
    else groups.push({ ...event });
  }
  return groups.map((group) => ({ key: `event-${group.start.toFixed(6)}`, start: Math.max(0, group.start - 5), end: Math.min(record.duration, group.end + 5), provisional: frontier <= group.end + 5, selected: true, manual: false })).filter((group) => group.end > group.start);
}

// Metadata/decoder capability selection only: never decode-scan all source tracks.
export async function chooseAudioTracks(input, tracks) {
  if (!tracks.length) throw new Error('录像中没有可用于分析的音轨');
  const primary = await input.getPrimaryAudioTrack();
  const primaryIndex = Math.max(0, tracks.findIndex((track) => track === primary || track.id === primary?.id));
  const order = [primaryIndex, ...tracks.map((_, index) => index).filter((index) => index !== primaryIndex)];
  for (const index of order) {
    let decodable = false;
    try { decodable = await tracks[index].canDecode(); } catch { /* A failed codec probe cannot block other decodable audio. */ }
    if (decodable) return {
      selected: index, outputAudioTrackIndex: primaryIndex,
      audioPolicy: { analysis: 'primary-decodable', selectedIndex: index, sourcePrimaryIndex: primaryIndex, fallback: index !== primaryIndex, message: '自动使用默认且可解码的音轨进行分析；未判断其是否为游戏声音。预览和导出沿用原片默认声音。' },
    };
  }
  throw new Error(`浏览器无法解码录像音轨（${tracks.map((track) => track.codec || '未知编码').join('、')}）`);
}

export function createBrowserAnalysis({ MB, onChange = () => {}, onCandidates = () => {}, onPrepared = async () => {} }) {
  const metadata = new Map();
  let worker = null, workerModel = null, nextRequest = 0, activeRequest = null;
  function releaseWorker() {
    worker?.terminate(); worker = null; workerModel = null;
  }
  async function modelMetadata(model, signal) {
    if (!['efficientat', 'beats'].includes(model)) throw new Error('未知分析模型');
    if (!metadata.has(model)) {
      const response = await fetch(model === 'efficientat' ? '/assets/efficientat/model.json' : '/assets/model.json', { signal });
      if (!response.ok) throw new Error(`模型清单无法读取（HTTP ${response.status}）`);
      const value = await response.json();
      if (!Array.isArray(value.classes) || ![16000, 32000].includes(value.sampleRate)) throw new Error('模型清单格式不匹配');
      metadata.set(model, value);
    }
    signal.throwIfAborted();
    return metadata.get(model);
  }
  function infer(waveform, model, signal, progress) {
    signal.throwIfAborted();
    if (worker && workerModel !== model) releaseWorker();
    if (!worker) {
      worker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
      workerModel = model;
      worker.onmessage = ({ data }) => {
        if (data.type === 'status') { activeRequest?.progress({ message: data.message, modelLoadProgress: data.progress }); return; }
        if (data.id !== activeRequest?.id) return;
        if (data.type === 'error') activeRequest.reject(new Error(data.message));
        else activeRequest.resolve(data);
      };
      worker.onerror = (event) => { activeRequest?.reject(new Error(event.message || '模型 Worker 失败')); releaseWorker(); };
    }
    return new Promise((resolve, reject) => {
      const id = ++nextRequest;
      const finish = (callback, value) => {
        signal.removeEventListener('abort', abort);
        if (activeRequest?.id === id) activeRequest = null;
        callback(value);
      };
      const abort = () => { releaseWorker(); finish(reject, signal.reason); };
      activeRequest = { id, progress, resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
      signal.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ id, waveform, model }, [waveform.buffer]); }
      catch (error) { releaseWorker(); finish(reject, error); }
    });
  }
  const queue = createAnalysisQueue({
    onChange, onCandidates, onPrepared, release: releaseWorker,
    async prepare(record, { signal }) {
      const started = performance.now();
      const input = new MB.Input({ source: createMediaReadSource({ MB, file: record.file }), formats: MB.ALL_FORMATS });
      try {
        const video = await input.getPrimaryVideoTrack(); signal.throwIfAborted();
        if (!video) throw new Error('文件不包含视频轨道');
        const tracks = await input.getAudioTracks(); signal.throwIfAborted();
        const origin = Math.max(0, await video.getFirstTimestamp());
        const duration = await video.computeDuration() - origin;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定有效视频时长');
        const audio = await chooseAudioTracks(input, tracks); signal.throwIfAborted();
        return { input, video, tracks, origin, duration, ...audio, importMs: performance.now() - started };
      } catch (error) { input.dispose(); throw error; }
    },
    async analyze(record, { signal, publish, progress }) {
      const started = performance.now();
      const check = () => signal.throwIfAborted();
      const manifest = await modelMetadata(record.model, signal);
      const indices = ['Gunshot, gunfire', 'Machine gun'].map((name) => manifest.classes.indexOf(name));
      if (indices.some((index) => index < 0)) throw new Error('模型类别清单不匹配');
      const track = record.tracks[record.selected];
      const audioOrigin = Math.max(0, await track.getFirstTimestamp()); check();
      const duration = await track.computeDuration() - audioOrigin; check();
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('音轨没有有效采样');
      record.audioDuration = duration; record.audioOffset = audioOrigin - record.origin;
      record.modelInfo = { model: manifest.model, sha256: manifest.sha256, sampleRate: manifest.sampleRate, scoreType: manifest.scoreType };
      const metrics = record.timings = { decodeMs: 0, readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0, audioSetupMs: performance.now() - started, audioWaitMs: 0, inferenceRoundTripMs: 0, postprocessAndRenderMs: 0, timingVersion: 3 };
      record.analysisStarted = started; record.windows = 0; record.processedUntil = 0; record.frontier = -Infinity;
      record.scores = null; record.windowScores = null;
      const small = manifest.scoreType === 'window';
      const frameCount = Math.ceil(duration / 0.04), windows = Math.ceil(Math.max(0, duration - 10) / 5) + 1;
      const sums = small ? null : new Float32Array(frameCount * 2), counts = small ? null : new Uint16Array(frameCount);
      const windowScores = [];
      const previousStable = record.candidates.filter((candidate) => !candidate.provisional);
      let stream, ahead;
      function publishProgress(frontier, processedUntil) {
        const next = candidatesFromScores(record, record.threshold, frontier);
        // During retry, later previously stable suggestions stay reviewable until this pass reaches them.
        const retained = Number.isFinite(frontier) ? previousStable.filter((candidate) => candidate.end > processedUntil && !next.some((item) => item.key === candidate.key)) : [];
        publish([...next, ...retained].sort((a, b) => a.start - b.start), { frontier, processedUntil });
        if (metrics.firstReviewableMs === undefined && next.some((candidate) => !candidate.provisional)) metrics.firstReviewableMs = performance.now() - started;
      }
      try {
        stream = sequentialAudio(MB, track, audioOrigin, duration, manifest.sampleRate, check, metrics);
        const prefetch = () => stream.next().then((value) => ({ value }), (error) => ({ error }));
        ahead = prefetch();
        for (let index = 0; index < windows; index++) {
          check(); progress({ message: `正在分析第 ${index + 1} / ${windows} 个窗口`, totalWindows: windows });
          const audioWaitStarted = performance.now();
          const decoded = await ahead;
          metrics.audioWaitMs += performance.now() - audioWaitStarted;
          if (decoded.error) throw decoded.error;
          check();
          const inferenceStarted = performance.now();
          const inference = infer(decoded.value, record.model, signal, progress);
          ahead = index + 1 < windows ? prefetch() : null;
          const { values, timings } = await inference; check();
          metrics.inferenceRoundTripMs += performance.now() - inferenceStarted;
          for (const key of ['readMs', 'initializeMs', 'frontendMs', 'inferenceMs']) metrics[key] += timings[key] || 0;
          const postprocessStarted = performance.now();
          if (small) {
            if (values.length !== manifest.classes.length || values.some((value) => !Number.isFinite(value))) throw new Error('窗口分数无效');
            windowScores.push({ start: index * 5 + record.audioOffset, end: Math.min(index * 5 + 10, duration) + record.audioOffset, scores: indices.map((category) => values[category]) });
            record.windowScores = windowScores;
          } else {
            if (values.length !== 250 * manifest.classes.length || values.some((value) => !Number.isFinite(value))) throw new Error('模型输出无效');
            for (let offset = 0; offset < 250 && index * 125 + offset < frameCount; offset++) {
              const frame = index * 125 + offset; counts[frame]++;
              for (let category = 0; category < 2; category++) sums[frame * 2 + category] += values[offset * manifest.classes.length + indices[category]];
            }
            const stable = index + 1 === windows ? frameCount : Math.min(frameCount, (index + 1) * 125);
            record.scores = new Float32Array(stable * 2);
            for (let frame = 0; frame < stable; frame++) for (let category = 0; category < 2; category++) record.scores[frame * 2 + category] = sums[frame * 2 + category] / counts[frame];
          }
          record.windows = index + 1;
          const frontier = (small ? (index + 1) * 5 : (record.scores.length / 2 - 1) * 0.04) + record.audioOffset;
          publishProgress(frontier, Math.min(record.duration, Math.max(0, (index * 5 + 10) + record.audioOffset)));
          metrics.postprocessAndRenderMs += performance.now() - postprocessStarted;
        }
        if (!small && counts.some((count) => count === 0)) throw new Error('分数时间轴有缺口');
      } finally {
        await ahead; // Settle the one prefetched read before returning its iterator.
        await stream?.close();
      }
      check();
      publishProgress(Infinity, record.duration);
      metrics.totalMs = performance.now() - started;
      progress({ message: '分析完成', modelLoadProgress: null });
    },
  });
  queue.recompute = (id, threshold) => {
    const record = queue.get(id);
    if (!record?.scores && !record?.windowScores) throw new Error('该录像尚无可重算的预测分数');
    const next = candidatesFromScores(record, threshold, record.frontier);
    record.threshold = threshold; record.candidates = next;
    onCandidates(record, next); onChange(record);
    return next;
  };
  return queue;
}
