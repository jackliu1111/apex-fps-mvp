import { createAudioPeaks, appendAudioPeaks } from './audio-peaks.mjs';
import { createAnalysisQueue } from './analysis-queue.mjs';
import { sequentialAudio } from './stream-audio.js';
import { createMediaReadSource } from './media-read-source.mjs';
import { CANDIDATE_PADDING_SECONDS, CANDIDATE_GAP_SECONDS, mergeCandidateRanges } from './candidate-ranges.mjs';
import { DEFAULT_MODEL, assetRecoveryHint, defaultModelRegistry, validateModelManifest, validateInferenceOutput } from './model-registry.mjs';
import { FrameOverlap } from './lab-scores.mjs';
import { DISPLAY_GROUPS, createDisplayGrouping } from './lab-display-groups.mjs';
import { createGroupScorePyramid, updateGroupScorePyramid } from './waveform-layers.mjs';

export function candidatesFromScores(record, threshold = record.threshold, frontier = record.frontier) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('阈值须在 0 到 1 之间');
  const events = [];
  if (record.windowScores) {
    for (const window of record.windowScores) if (Math.max(...window.scores) > threshold) events.push({ start: window.start, end: window.end });
  } else if (record.scores) {
    const length = record.scoreFrames ?? (record.scores.length / 2);
    const frameSeconds = record.frameSeconds || 0.04;
    const audioOffset = record.audioOffset ?? 0;
    const audioLimit = record.audioDuration ?? (record.duration - audioOffset);
    const smooth = (index, category) => [record.scores[Math.max(0, index - 1) * 2 + category], record.scores[index * 2 + category], record.scores[Math.min(length - 1, index + 1) * 2 + category]].sort((a, b) => a - b)[1];
    let start = null;
    for (let index = 0; index <= length; index++) {
      const hit = index < length && (smooth(index, 0) > threshold || smooth(index, 1) > threshold);
      if (hit && start === null) start = index * frameSeconds;
      if (!hit && start !== null) {
        const end = Math.min(index * frameSeconds, audioLimit);
        if (end > start) events.push({ start: start + audioOffset, end: end + audioOffset });
        start = null;
      }
    }
  }
  // Merge the ranges the user actually sees, including context padding. A future
  // event may reach back by its own padding, so wait for that horizon to settle.
  const mergeHorizon = CANDIDATE_PADDING_SECONDS * 2 + CANDIDATE_GAP_SECONDS;
  return mergeCandidateRanges(events.map((event) => ({
    key: `event-${event.start.toFixed(6)}`,
    start: Math.max(0, event.start - CANDIDATE_PADDING_SECONDS),
    end: Math.min(record.duration, event.end + CANDIDATE_PADDING_SECONDS),
    provisional: frontier <= event.end + mergeHorizon,
    selected: true, manual: false,
  })).filter((candidate) => candidate.end > candidate.start));
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

export function modelManifestUrl(model, registry = defaultModelRegistry) {
  return registry.get(model).manifestUrl;
}

function serializeModelSpec(spec) {
  return {
    id: spec.id,
    manifestUrl: spec.manifestUrl,
    onnxUrl: spec.onnxUrl,
    frontendUrl: spec.frontendUrl ?? null,
    frontendType: spec.frontendType || 'efficientsed',
    sampleRate: spec.sampleRate,
    windowSeconds: spec.windowSeconds,
    strideSeconds: spec.strideSeconds,
    frameSeconds: spec.frameSeconds,
    framesPerWindow: spec.framesPerWindow,
    hopFrames: spec.hopFrames,
    scoreType: spec.scoreType,
    inputName: spec.inputName,
    inputShape: Array.isArray(spec.inputShape) ? [...spec.inputShape] : [],
    ...(spec.outputName ? { outputName: spec.outputName } : {}),
    ...(Array.isArray(spec.outputShape) ? { outputShape: [...spec.outputShape] } : {}),
    ...(spec.gunshotClasses ? { gunshotClasses: [...spec.gunshotClasses] } : {}),
  };
}

export function createBrowserAnalysis({
  MB,
  models = defaultModelRegistry,
  Worker: WorkerImpl,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  infer: inferImpl,
  openAudioStream = sequentialAudio,
  onChange = () => {},
  onCandidates = () => {},
  onPrepared = async () => {},
  onWaveform = () => {},
}) {
  const metadata = new Map();
  let worker = null, workerModel = null, nextRequest = 0, activeRequest = null;
  function releaseWorker() {
    worker?.terminate(); worker = null; workerModel = null;
  }
  async function modelMetadata(model, signal) {
    const spec = models.get(model);
    const url = spec.manifestUrl;
    if (!metadata.has(model)) {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        throw new Error(`模型清单无法读取（HTTP ${response.status}）：${url}。${assetRecoveryHint(response.status)}`);
      }
      const value = await response.json();
      const validated = validateModelManifest(spec, value);
      metadata.set(model, { spec, manifest: value, validated });
    }
    signal.throwIfAborted();
    return metadata.get(model);
  }
  function inferWithWorker(waveform, spec, signal, progress, manifest) {
    signal.throwIfAborted();
    if (worker && workerModel !== spec.id) releaseWorker();
    if (!worker) {
      const WorkerCtor = WorkerImpl || globalThis.Worker;
      worker = new WorkerCtor(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
      workerModel = spec.id;
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
      try {
        worker.postMessage({
          id,
          waveform,
          model: spec.id,
          spec: serializeModelSpec(spec),
          manifest: { sha256: manifest.sha256, bytes: manifest.bytes, modelFile: manifest.modelFile },
        }, [waveform.buffer]);
      } catch (error) { releaseWorker(); finish(reject, error); }
    });
  }
  function infer(waveform, spec, manifest, signal, progress) {
    if (inferImpl) return inferImpl(waveform, { model: spec.id, spec, manifest, signal, progress });
    return inferWithWorker(waveform, spec, signal, progress, manifest);
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
      const { spec, manifest, validated } = await modelMetadata(record.model, signal);
      const indices = validated.gunshotIndices;
      const track = record.tracks[record.selected];
      const audioOrigin = Math.max(0, await track.getFirstTimestamp()); check();
      const duration = await track.computeDuration() - audioOrigin; check();
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('音轨没有有效采样');
      record.audioDuration = duration; record.audioOffset = audioOrigin - record.origin;
      record.modelInfo = {
        id: spec.id,
        model: manifest.model,
        sha256: manifest.sha256,
        sampleRate: spec.sampleRate,
        scoreType: spec.scoreType,
        frameSeconds: spec.frameSeconds ?? null,
      };
      const metrics = record.timings = { decodeMs: 0, readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0, audioSetupMs: performance.now() - started, audioWaitMs: 0, inferenceRoundTripMs: 0, postprocessAndRenderMs: 0, timingVersion: 3 };
      record.analysisStarted = started; record.windows = 0; record.processedUntil = 0; record.frontier = -Infinity;
      record.scores = null; record.scoreFrames = 0; record.frameSeconds = spec.frameSeconds || 0.04; record.windowScores = null;
      const groupCount = DISPLAY_GROUPS.length;
      record.scoreTimeline = null;
      record.waveform = createAudioPeaks(record.duration, record.selected);
      onWaveform(record, record.waveform);
      const frameSeconds = spec.frameSeconds || 0.04;
      const frameCount = Math.max(1, Math.ceil((duration - 1e-9) / frameSeconds));
      const windows = Math.ceil(Math.max(0, duration - spec.windowSeconds) / spec.strideSeconds) + 1;
      const overlap = new FrameOverlap(manifest.classes.length, frameCount, spec.framesPerWindow, spec.hopFrames);
      const preallocatedScores = new Float32Array(frameCount * 2);
      const preallocatedGroupScores = new Float32Array(frameCount * groupCount);
      const preallocatedGroupPyramid = createGroupScorePyramid(preallocatedGroupScores, frameCount, groupCount, frameSeconds);
      const groupFrame = createDisplayGrouping(manifest.classes);
      const previousStable = record.candidates.filter((candidate) => !candidate.provisional);
      let stream, ahead;
      function publishProgress(frontier, processedUntil) {
        const next = candidatesFromScores(record, record.threshold, frontier);
        // During retry, later previously stable suggestions stay reviewable until this pass reaches them.
        const retained = Number.isFinite(frontier) ? previousStable.filter((candidate) => candidate.end > processedUntil && !next.some((item) => item.key === candidate.key)) : [];
        publish(mergeCandidateRanges([...next, ...retained]), { frontier, processedUntil });
        if (metrics.firstReviewableMs === undefined && next.some((candidate) => !candidate.provisional)) metrics.firstReviewableMs = performance.now() - started;
      }
      try {
        stream = openAudioStream(MB, track, audioOrigin, duration, spec.sampleRate, check, metrics, (block) => appendAudioPeaks(record.waveform, block, record.origin, record.duration));
        const prefetch = () => stream.next().then((value) => { onWaveform(record, record.waveform); return { value }; }, (error) => { onWaveform(record, record.waveform); return { error }; });
        ahead = prefetch();
        for (let index = 0; index < windows; index++) {
          check(); progress({ message: `正在分析第 ${index + 1} / ${windows} 个窗口`, totalWindows: windows });
          const audioWaitStarted = performance.now();
          const decoded = await ahead;
          metrics.audioWaitMs += performance.now() - audioWaitStarted;
          if (decoded.error) throw decoded.error;
          check();
          const inferenceStarted = performance.now();
          const inference = infer(decoded.value, spec, manifest, signal, progress);
          ahead = index + 1 < windows ? prefetch() : null;
          const result = await inference; check();
          const { values, dims, timings = {} } = result;
          metrics.inferenceRoundTripMs += performance.now() - inferenceStarted;
          for (const key of ['readMs', 'initializeMs', 'frontendMs', 'inferenceMs']) metrics[key] += timings[key] || 0;
          const postprocessStarted = performance.now();
          validateInferenceOutput(spec, manifest, { values, dims });
          const block = overlap.push(values, index + 1 === windows);
          const classCount = manifest.classes.length;
          for (let frame = 0; frame < block.frameCount; frame++) {
            const dst = (block.startFrame + frame) * 2;
            const src = frame * classCount;
            preallocatedScores[dst] = block.values[src + indices[0]];
            preallocatedScores[dst + 1] = block.values[src + indices[1]];
            groupFrame(block.values.subarray(src, src + classCount), preallocatedGroupScores, (block.startFrame + frame) * groupCount);
          }
          updateGroupScorePyramid(preallocatedGroupPyramid, block.startFrame, block.frameCount);
          if (!record.scores) record.scores = preallocatedScores;
          record.scoreFrames = overlap.cursor;
          if (!record.scoreTimeline) {
            record.scoreTimeline = {
              groupScores: preallocatedGroupScores,
              groupScoreFrames: overlap.cursor,
              groupScorePyramid: preallocatedGroupPyramid,
              groupCount,
              frameSeconds,
              audioOffset: record.audioOffset,
              audioDuration: duration,
            };
          } else {
            record.scoreTimeline.groupScoreFrames = overlap.cursor;
          }
          record.windows = index + 1;
          const frontier = (record.scoreFrames - 1) * frameSeconds + record.audioOffset;
          publishProgress(frontier, Math.min(record.duration, Math.max(0, (index * spec.strideSeconds + spec.windowSeconds) + record.audioOffset)));
          metrics.postprocessAndRenderMs += performance.now() - postprocessStarted;
        }
        if (overlap.cursor !== frameCount) throw new Error('分数时间轴有缺口');
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
    const hasScores = (record?.scores && record.scoreFrames > 0) || record?.windowScores?.length;
    if (!hasScores) throw new Error('该录像尚无可重算的预测分数');
    const next = candidatesFromScores(record, threshold, record.frontier);
    record.threshold = threshold; record.candidates = next;
    onCandidates(record, next); onChange(record);
    return next;
  };
  const rawImportPrecomputed = queue.importPrecomputed;
  queue.importPrecomputed = (file, precomputed = {}) => rawImportPrecomputed(file, {
    model: precomputed.model || DEFAULT_MODEL,
    threshold: precomputed.threshold ?? 0.2,
    apply(record) {
      record.audioDuration = precomputed.audioDuration ?? record.duration;
      record.audioOffset = precomputed.audioOffset ?? 0;
      record.windowScores = Array.isArray(precomputed.windowScores) ? structuredClone(precomputed.windowScores) : [];
      record.windows = record.windowScores.length;
      record.alignment = precomputed.alignment ? structuredClone(precomputed.alignment) : null;
      record.modelInfo = precomputed.modelInfo || { model: record.model, scoreType: 'frame', sampleRate: 16000, frameSeconds: 0.04, source: 'live-companion' };
      record.scoreTimeline = precomputed.scoreTimeline || null;
      record.waveform = precomputed.waveform || createAudioPeaks(record.duration, record.selected);
      onWaveform(record, record.waveform);
      record.candidates = candidatesFromScores(record, record.threshold, Infinity);
    },
  });
  return queue;
}
