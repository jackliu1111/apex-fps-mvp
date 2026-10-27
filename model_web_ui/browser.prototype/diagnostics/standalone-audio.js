import * as MB from '/assets/vendor/mediabunny.mjs';
import { sequentialAudio } from '../stream-audio.js';

// Isolated experiment. The model and PCM pipeline are the existing app modules.
const $ = id => document.getElementById(id);
let busy = false, cancelled = false, reportUrl, activeWorker, rejectInference;
const checkCancelled = () => { if (cancelled) throw new Error('已取消'); };
$('status').textContent = `等待选择文件\n浏览器：${navigator.userAgent}\n隔离上下文：${crossOriginIsolated}\nAudioDecoder：${typeof AudioDecoder !== 'undefined'}`;

// Same window threshold, 5-second event merge and 5-second padding as app.js.
export function windowCandidates(scores, threshold, duration, frontier = Infinity) {
  const groups = [];
  for (const window of scores) {
    if (Math.max(...window.scores) <= threshold) continue;
    const previous = groups.at(-1);
    if (previous && window.start - previous.end <= 5) previous.end = window.end;
    else groups.push({ start: window.start, end: window.end });
  }
  return groups.map(g => ({ key: `event-${g.start.toFixed(6)}`, provisional: frontier <= g.end + 5,
    start: Math.max(0, g.start - 5), end: Math.min(duration, g.end + 5), selected: true, manual: false }))
    .filter(g => g.end > g.start);
}

function makeWorker() {
  const worker = new Worker('../inference-worker.js', { type: 'module' });
  let pending, id = 0;
  worker.onmessage = ({ data }) => {
    if (data.type === 'status') return;
    if (!pending || data.id !== pending.id) return;
    const request = pending; pending = null; rejectInference = null;
    if (data.type === 'error') request.reject(new Error(data.message));
    else request.resolve(data);
  };
  worker.onerror = event => {
    pending?.reject(new Error(event.message)); pending = null; rejectInference = null;
  };
  activeWorker = worker;
  return {
    infer(waveform) {
      checkCancelled();
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending = { id: requestId, resolve, reject };
        rejectInference = reject;
        worker.postMessage({ id: requestId, model: 'efficientat', waveform }, [waveform.buffer]);
      });
    },
    close() { worker.terminate(); pending?.reject(new Error('Worker closed')); pending = null; rejectInference = null; activeWorker = null; },
  };
}

function saveReport(report) {
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  $('download').href = reportUrl;
  const name = report.source.name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const date = report.date.replace(/[:.]/g, '-');
  $('download').download = `apex-standalone-${name}-${date}.json`;
  $('download').hidden = false;
}

function brief(result) {
  const { windowScores, clips, ...rest } = result;
  return { ...rest, scoreWindows: windowScores.length, candidates: clips.length };
}

async function analyze(file, options, metadata, worker, round) {
  const runStarted = performance.now();
  const metrics = { decodeMs: 0, readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0,
    audioSetupMs: 0, audioWaitMs: 0, inferenceRoundTripMs: 0, postprocessAndRenderMs: 0,
    progressUiMs: 0, readBytes: 0, readCalls: 0, decodedBuffers: 0, decodedSamplesPerChannel: 0,
    timingVersion: 3 };
  const source = new MB.BlobSource(file);
  source.onread = (start, end) => { metrics.readBytes += end - start; metrics.readCalls++; };
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  const result = { round, modelSession: round === 1 ? 'new Worker/session; OS cache not flushed' : 'reused Worker/session; new Input; OS cache not flushed',
    status: 'running', windows: 0, windowScores: [], clips: [], timings: metrics };
  let stream, ahead, analysisStarted;
  try {
    const tracks = await input.getAudioTracks();
    if (!tracks[options.audioIndex]) throw new Error(`音轨 ${options.audioIndex} 不存在；共 ${tracks.length} 条音轨`);
    const track = tracks[options.audioIndex];
    metrics.importMs = performance.now() - runStarted;
    checkCancelled();
    analysisStarted = performance.now();
    const setupStarted = performance.now();
    if (!await track.canDecode()) throw new Error(`浏览器无法解码 ${track.codec}`);
    const origin = Math.max(0, await track.getFirstTimestamp());
    const endTimestamp = await track.computeDuration();
    const naturalDuration = endTimestamp - origin;
    if (!(naturalDuration > 0)) throw new Error('音轨时长无效');
    const duration = options.durationOverride ?? naturalDuration;
    if (duration > naturalDuration + 1e-7) throw new Error(`限定分析时长 ${duration} 超过音轨自然时长 ${naturalDuration}`);
    const audioOffset = origin + options.timestampShift - options.videoOrigin;
    result.audio = { trackId: track.id, index: options.audioIndex, codec: track.codec, origin,
      endTimestamp, naturalDuration, analysisDuration: duration, durationOverride: options.durationOverride,
      duration, mappedVideoOffset: audioOffset };
    const classIndices = ['Gunshot, gunfire', 'Machine gun'].map(name => metadata.classes.indexOf(name));
    if (classIndices.some(i => i < 0)) throw new Error('模型类别清单不匹配');
    const sampleCount = Math.round(duration * 16000);
    const windows = Math.ceil(Math.max(0, sampleCount - 160000) / 80000) + 1;
    // Observe actual native PCM delivery without changing samples or timestamps.
    class ObservedAudioBufferSink extends MB.AudioBufferSink {
      async *buffers(...args) {
        for await (const value of super.buffers(...args)) {
          if (metrics.firstPcmMs === undefined) {
            metrics.firstPcmMs = performance.now() - analysisStarted;
            result.firstDecoded = { timestamp: value.timestamp, sampleRate: value.buffer.sampleRate,
              channels: value.buffer.numberOfChannels, samples: value.buffer.length };
          }
          metrics.decodedBuffers++;
          metrics.decodedSamplesPerChannel += value.buffer.length;
          yield value;
        }
      }
    }
    stream = sequentialAudio({ ...MB, AudioBufferSink: ObservedAudioBufferSink }, track, origin, duration,
      metadata.sampleRate, checkCancelled, metrics);
    const prefetch = () => stream.next().then(value => ({ value }), error => ({ error }));
    metrics.audioSetupMs = performance.now() - setupStarted;
    ahead = prefetch();
    for (let i = 0; i < windows; i++) {
      checkCancelled();
      const waitStarted = performance.now();
      const decoded = await ahead;
      metrics.audioWaitMs += performance.now() - waitStarted;
      if (decoded.error) throw decoded.error;
      checkCancelled();
      if (metrics.firstWindowMs === undefined) metrics.firstWindowMs = performance.now() - analysisStarted;
      const inferenceStarted = performance.now();
      const inference = worker.infer(decoded.value);
      ahead = i + 1 < windows ? prefetch() : null;
      const response = await inference;
      metrics.inferenceRoundTripMs += performance.now() - inferenceStarted;
      if (metrics.firstScoreMs === undefined) metrics.firstScoreMs = performance.now() - analysisStarted;
      for (const key of ['readMs', 'initializeMs', 'frontendMs', 'inferenceMs']) metrics[key] += response.timings[key];
      checkCancelled();
      const postprocessStarted = performance.now();
      const values = response.values;
      if (values.length !== metadata.classes.length || values.some(v => !Number.isFinite(v))) throw new Error('窗口分数无效');
      result.windowScores.push({ start: i * 5 + audioOffset, end: Math.min(i * 5 + 10, duration) + audioOffset,
        scores: classIndices.map(k => values[k]) });
      result.windows = i + 1;
      const frontier = i + 1 === windows ? Infinity : (i + 1) * 5 + audioOffset;
      // Match progressive publishing: finalized candidates retain their boundaries.
      const preserved = result.clips.filter(c => !c.provisional);
      const keys = new Set(preserved.map(c => c.key));
      result.clips = [...preserved, ...windowCandidates(result.windowScores, options.threshold, options.videoDuration, frontier)
        .filter(c => !keys.has(c.key))];
      if (metrics.firstReviewableMs === undefined && result.clips.some(c => !c.provisional)) {
        metrics.firstReviewableMs = performance.now() - analysisStarted;
      }
      metrics.postprocessAndRenderMs += performance.now() - postprocessStarted;
      const progressStarted = performance.now();
      $('progress').value = (i + 1) / windows;
      if (i % 10 === 0 || i + 1 === windows) {
        $('status').textContent = `第 ${round} 轮：${i + 1} / ${windows} 窗口，已用 ${((performance.now() - analysisStarted) / 1000).toFixed(2)} 秒\n${file.name}\n读取 ${(metrics.readBytes / 1e6).toFixed(2)} MB / ${metrics.readCalls} 个交付块`;
      }
      metrics.progressUiMs += performance.now() - progressStarted;
    }
    metrics.totalMs = performance.now() - analysisStarted;
    result.status = 'complete';
  } catch (error) {
    result.status = cancelled ? 'cancelled' : 'failed';
    result.error = String(error.stack || error);
    if (analysisStarted !== undefined) metrics.partialElapsedMs = performance.now() - analysisStarted;
  } finally {
    await ahead;
    try { await stream?.close(); } finally { input.dispose(); }
    metrics.elapsedIncludingImportAndCleanupMs = performance.now() - runStarted;
  }
  return result;
}

$('cancel').onclick = () => {
  cancelled = true;
  activeWorker?.terminate();
  rejectInference?.(new Error('已取消'));
  $('status').textContent = '正在取消并释放解码器…';
};

$('run').onclick = async () => {
  if (busy) return;
  const file = $('file').files[0];
  if (!file) { $('status').textContent = '请先选择分析文件'; return; }
  const options = { audioIndex: Number($('track').value), videoOrigin: Number($('video-origin').value),
    videoDuration: Number($('video-duration').value), timestampShift: Number($('timestamp-shift').value),
    threshold: Number($('threshold').value), repeats: Number($('repeats').value),
    durationOverride: $('duration-override').value.trim() === '' ? null : Number($('duration-override').value) };
  if (!Object.values(options).filter(v => v !== null).every(Number.isFinite) || !Number.isInteger(options.audioIndex) || options.audioIndex < 0
      || options.videoDuration <= 0 || options.threshold < 0 || options.threshold > 1 || ![1, 2, 3].includes(options.repeats)) {
    $('status').textContent = '参数无效'; return;
  }
  if (options.durationOverride !== null && options.durationOverride <= 0) {
    $('status').textContent = '限定分析时长必须大于零，或留空使用自然时长'; return;
  }
  busy = true; cancelled = false;
  for (const control of document.querySelectorAll('input,select,button')) control.disabled = true;
  $('cancel').disabled = false;
  $('download').hidden = true;
  $('full-report-details').hidden = true;
  $('full-report-details').open = false;
  $('full-report').textContent = '';
  $('progress').value = 0;
  let worker;
  const report = { schemaVersion: 1, date: new Date().toISOString(), userAgent: navigator.userAgent,
    experiment: 'standalone audio versus original video; analysis only',
    source: { name: file.name, bytes: file.size, lastModified: file.lastModified },
    options, backend: 'existing EfficientAT WASM CPU / 1 thread',
    measurementNotes: ['Media generation/extraction is excluded and must be added for first-use total.',
      'BlobSource onread counts source byte ranges delivered to the library, not physical device I/O.',
      'readCalls counts onread callbacks (stream data chunks), not logical range requests or file-system calls.',
      'Timing stages overlap. totalMs excludes metadata import and cleanup; full elapsed is also recorded.',
      'No preview/export is exercised. Original-video mapping must be verified independently.'], results: [] };
  try {
    $('status').textContent = '正在加载模型清单…';
    const started = performance.now();
    const response = await fetch('/assets/efficientat/model.json');
    if (!response.ok) throw new Error(`模型清单 HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.sampleRate !== 32000 || metadata.scoreType !== 'window') throw new Error('模型输入契约发生变化');
    report.metadataReadMs = performance.now() - started;
    report.model = metadata.model; report.modelSha256 = metadata.sha256; report.sampleRate = metadata.sampleRate;
    worker = makeWorker();
    for (let round = 1; round <= options.repeats; round++) {
      checkCancelled();
      const result = await analyze(file, options, metadata, worker, round);
      report.results.push(result); saveReport(report);
      if (result.status !== 'complete') break;
    }
    $('status').textContent = JSON.stringify({ ...report, results: report.results.map(brief) }, null, 2);
  } catch (error) {
    report.error = String(error.stack || error); saveReport(report);
    $('status').textContent = report.error;
  } finally {
    worker?.close(); busy = false;
    // Keep full score rendering outside all measured analysis rounds.
    $('full-report').textContent = JSON.stringify(report, null, 2);
    $('full-report-details').hidden = false;
    for (const control of document.querySelectorAll('input,select,button')) control.disabled = false;
    $('cancel').disabled = true;
  }
};
