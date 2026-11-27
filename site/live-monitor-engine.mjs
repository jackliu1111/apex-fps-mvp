import { createLiveAudioHistory, DEFAULT_MAX_HISTORY_SECONDS } from './live-audio-history.mjs';
import {
  DEFAULT_MODEL,
  assetRecoveryHint,
  defaultModelRegistry,
  serializeSpec,
  validateInferenceOutput,
  validateModelManifest,
} from './model-registry.mjs';
import { DISPLAY_GROUPS, createDisplayGrouping } from './lab-display-groups.mjs';

export const LIVE_MONITOR_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  PAUSED_LOOPBACK: 'paused-loopback',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

export const AUDIO_SOURCE_KINDS = Object.freeze({
  SYSTEM: 'system',
  DEVICE: 'device',
});

export const SILENCE_WARNING_SECONDS = 10;
export const DEFAULT_HOP_SECONDS = 2;

const RAW_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
});

function stopStreamTracks(stream) {
  if (!stream) return;
  for (const track of [...stream.getTracks()]) {
    try { track.stop(); } catch { /* ignore */ }
  }
}

/**
 * Pure-audio live monitoring engine (对局监听引擎, ADR 0009).
 * Captures game audio only (no video display/proxy/filmstrip, no manual marks or live pre-decisions),
 * computes gunshot/4-group prediction scores and 20 ms energy envelopes, and maintains a rolling
 * 60-minute history for master recording alignment & conforming (原片升格).
 */
export function createLiveMonitorEngine({
  modelId = DEFAULT_MODEL,
  modelRegistry = defaultModelRegistry,
  hopSeconds = DEFAULT_HOP_SECONDS,
  maxHistorySeconds = DEFAULT_MAX_HISTORY_SECONDS,
  silenceWarningSeconds = SILENCE_WARNING_SECONDS,
  mediaDevices = globalThis.navigator?.mediaDevices ?? null,
  AudioContext: AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null,
  AudioWorkletNode: AudioWorkletNodeCtor = globalThis.AudioWorkletNode ?? null,
  Worker: WorkerCtor = globalThis.Worker ?? null,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  workletUrl = new URL('./live-audio-processor.js', import.meta.url),
  workerUrl = new URL('./inference-worker.js', import.meta.url),
} = {}) {
  const history = createLiveAudioHistory({ maxHistorySeconds });
  const subscribers = new Set();

  let disposed = false;
  let runToken = 0;

  let status = LIVE_MONITOR_STATES.IDLE;
  let sourceKind = null;
  let deviceId = null;
  let audioLabel = null;
  let modelStatus = null;
  let modelLoadProgress = null;
  let gateActive = false;
  let gateReason = null;
  let allowGateBypass = false;
  let playbackUnmuted = false;
  let playbackGateReason = null;
  let pausedAtMs = null;
  let silentSeconds = 0;
  let silenceWarning = false;
  let disconnectReason = null;
  let error = null;
  let latestScores = null;
  let droppedWindowCount = 0;
  let inferenceCount = 0;
  let lastInferenceMs = null;

  let mediaStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let workletNode = null;
  let silentGainNode = null;
  let trackEndCleanups = [];

  let modelMeta = null;
  let modelMetaPromise = null;
  let inferenceWorker = null;
  let workerBusy = false;
  let inFlightWindow = null;
  let pendingWindow = null;
  let reqSeq = 0;

  function isActiveStatus(s) {
    return s === LIVE_MONITOR_STATES.LISTENING || s === LIVE_MONITOR_STATES.PAUSED_LOOPBACK;
  }

  function snapshot() {
    const hist = history.summary();
    return Object.freeze({
      status,
      active: isActiveStatus(status),
      sourceKind,
      deviceId,
      audioLabel,
      modelId,
      modelStatus,
      modelLoadProgress,
      gateActive,
      gateReason,
      allowGateBypass,
      silentSeconds,
      silenceWarning,
      disconnectReason,
      error,
      historyStartEpochMs: hist.startEpochMs,
      latestEpochMs: hist.latestEpochMs,
      historyDurationSec: hist.durationSec,
      envelopeBucketCount: hist.envelopeBucketCount,
      scoreWindowCount: hist.scoreWindowCount,
      latestScores: latestScores
        ? Object.freeze({
            wallStartMs: latestScores.wallStartMs,
            wallEndMs: latestScores.wallEndMs,
            scores: Object.freeze([...latestScores.scores]),
            groupScores: Object.freeze([...latestScores.groupScores]),
            maxGunshotScore: latestScores.maxGunshotScore,
          })
        : null,
      droppedWindowCount,
      inferenceCount,
      lastInferenceMs,
    });
  }

  function emit() {
    if (disposed) return;
    const state = snapshot();
    for (const listener of [...subscribers]) listener(state);
  }

  function detachTrackListeners() {
    for (const cleanup of trackEndCleanups) cleanup();
    trackEndCleanups = [];
  }

  function terminateWorker() {
    if (inferenceWorker) {
      inferenceWorker.onmessage = null;
      inferenceWorker.onerror = null;
      try { inferenceWorker.terminate(); } catch { /* ignore */ }
      inferenceWorker = null;
    }
    workerBusy = false;
    inFlightWindow = null;
    pendingWindow = null;
  }

  async function ensureModelMeta() {
    if (modelMeta) return modelMeta;
    if (!modelMetaPromise) {
      modelMetaPromise = (async () => {
        const spec = modelRegistry.get(modelId);
        const res = await fetchImpl(spec.manifestUrl);
        if (!res.ok) {
          throw new Error(`模型清单读取失败 (HTTP ${res.status})：${spec.manifestUrl}。${assetRecoveryHint(res.status, spec.manifestUrl)}`);
        }
        const manifest = await res.json();
        const validated = validateModelManifest(spec, manifest);
        const groupProjector = createDisplayGrouping(manifest.classes);
        const entry = { spec, manifest, gunshotIndices: validated.gunshotIndices, groupProjector };
        modelMeta = entry;
        return entry;
      })().catch((err) => {
        modelMetaPromise = null;
        throw err;
      });
    }
    return modelMetaPromise;
  }

  function drainPendingWindow() {
    if (!pendingWindow) return;
    if (disposed || !isActiveStatus(status) || gateActive) {
      pendingWindow = null;
      return;
    }
    const next = pendingWindow;
    pendingWindow = null;
    void dispatchInference(next);
  }

  function ensureInferenceWorker() {
    if (inferenceWorker) return inferenceWorker;
    if (!WorkerCtor) throw new Error('当前环境不支持 Web Worker');
    const worker = new WorkerCtor(workerUrl, { type: 'module' });
    inferenceWorker = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== inferenceWorker || disposed || !data) return;
      if (data.type === 'status') {
        modelStatus = data.message ?? null;
        modelLoadProgress = data.progress ?? null;
        emit();
        return;
      }
      if (!inFlightWindow || (data.id !== undefined && data.id !== inFlightWindow.id)) return;
      const task = inFlightWindow;
      inFlightWindow = null;
      workerBusy = false;

      if (data.type === 'error') {
        error = data.message || '模型推理报错';
        emit();
        drainPendingWindow();
        return;
      }

      if (data.type === 'result' && modelMeta) {
        try {
          const { spec, manifest, gunshotIndices, groupProjector } = modelMeta;
          validateInferenceOutput(spec, manifest, { values: data.values, dims: data.dims });
          const classCount = manifest.classes.length;
          const groupCount = DISPLAY_GROUPS.length;
          const frames = spec.framesPerWindow || Math.floor(data.values.length / classCount);
          const gunshotPair = new Array(gunshotIndices.length).fill(0);
          const peakGroupScores = new Float32Array(groupCount);
          const frameGroupScores = new Float32Array(frames * groupCount);

          for (let f = 0; f < frames; f++) {
            const slice = data.values.subarray(f * classCount, (f + 1) * classCount);
            groupProjector(slice, frameGroupScores, f * groupCount);
            for (let g = 0; g < groupCount; g++) {
              const gv = frameGroupScores[f * groupCount + g];
              if (gv > peakGroupScores[g]) peakGroupScores[g] = gv;
            }
            for (let c = 0; c < gunshotIndices.length; c++) {
              const v = slice[gunshotIndices[c]] || 0;
              if (v > gunshotPair[c]) gunshotPair[c] = v;
            }
          }

          if (task.token === runToken && isActiveStatus(status) && !gateActive) {
            history.pushScoreWindow({
              wallStartMs: task.wallStartMs,
              wallEndMs: task.wallEndMs,
              scores: gunshotPair,
              groupScores: peakGroupScores,
              frameGroupScores,
              frameSeconds: spec.frameSeconds || 0.04,
            });
            inferenceCount++;
            lastInferenceMs = Number.isFinite(data.timings?.inferenceMs) ? data.timings.inferenceMs : null;
            latestScores = {
              wallStartMs: task.wallStartMs,
              wallEndMs: task.wallEndMs,
              scores: gunshotPair,
              groupScores: Array.from(peakGroupScores),
              maxGunshotScore: gunshotPair.length ? Math.max(...gunshotPair) : 0,
            };
            error = null;
            emit();
          }
        } catch (err) {
          error = err?.message || String(err);
          emit();
        }
      }
      drainPendingWindow();
    };
    worker.onerror = (event) => {
      if (worker !== inferenceWorker || disposed) return;
      terminateWorker();
      error = event?.message || '模型 Worker 异常';
      emit();
    };
    return worker;
  }

  async function dispatchInference(task) {
    workerBusy = true;
    inFlightWindow = task;
    try {
      const { spec, manifest } = await ensureModelMeta();
      if (task.token !== runToken || disposed || !isActiveStatus(status) || gateActive) {
        if (inFlightWindow === task) {
          inFlightWindow = null;
          workerBusy = false;
        }
        return;
      }
      const worker = ensureInferenceWorker();
      task.id = ++reqSeq;
      const transfer = task.waveform?.buffer ? [task.waveform.buffer] : undefined;
      worker.postMessage({
        id: task.id,
        waveform: task.waveform,
        model: spec.id,
        spec: serializeSpec(spec),
        manifest: {
          sha256: manifest.sha256,
          bytes: manifest.bytes,
          modelFile: manifest.modelFile,
        },
      }, transfer);
    } catch (err) {
      if (inFlightWindow === task) {
        inFlightWindow = null;
        workerBusy = false;
      }
      if (!disposed) {
        error = err?.message || String(err);
        emit();
      }
    }
  }

  async function teardownCapture() {
    detachTrackListeners();
    terminateWorker();
    if (workletNode) {
      if (workletNode.port) workletNode.port.onmessage = null;
      try { workletNode.disconnect(); } catch { /* ignore */ }
      workletNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch { /* ignore */ }
      sourceNode = null;
    }
    if (silentGainNode) {
      try { silentGainNode.disconnect(); } catch { /* ignore */ }
      silentGainNode = null;
    }
    if (audioCtx) {
      const ctx = audioCtx;
      audioCtx = null;
      try { await ctx.close?.(); } catch { /* ignore */ }
    }
    if (mediaStream) {
      stopStreamTracks(mediaStream);
      mediaStream = null;
    }
  }

  async function acquireSystemStream() {
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error('当前浏览器不支持系统音频共享');
    }
    const stream = await mediaDevices.getDisplayMedia({
      video: true,
      audio: { ...RAW_AUDIO_CONSTRAINTS },
    });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stopStreamTracks(stream);
      throw new Error('未获取到系统音频：请在共享窗口中勾选共享系统音频，或改用虚拟声卡音频设备。');
    }
    // Immediately stop and remove all video tracks before binding any audio listeners.
    for (const videoTrack of [...stream.getVideoTracks()]) {
      try { videoTrack.stop(); } catch { /* ignore */ }
      try { stream.removeTrack?.(videoTrack); } catch { /* ignore */ }
    }
    return stream;
  }

  async function acquireDeviceStream(requestedDeviceId) {
    if (!mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持音频设备输入');
    }
    const audio = requestedDeviceId
      ? { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: requestedDeviceId } }
      : { ...RAW_AUDIO_CONSTRAINTS };
    const stream = await mediaDevices.getUserMedia({ video: false, audio });
    if (!stream.getAudioTracks().length) {
      stopStreamTracks(stream);
      throw new Error('所选音频设备未提供可用音轨');
    }
    return stream;
  }

  async function listAudioDevices() {
    if (!mediaDevices?.enumerateDevices) return [];
    const devices = await mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device?.kind === 'audioinput')
      .map((device) => ({
        deviceId: device.deviceId || '',
        label: device.label || '',
        groupId: device.groupId || '',
      }));
  }

  async function cleanupLocalAudioPipeline({ ctx = null, node = null, source = null, silentGain = null } = {}) {
    if (node) {
      if (node.port) node.port.onmessage = null;
      try { node.disconnect(); } catch { /* ignore */ }
    }
    if (source) {
      try { source.disconnect(); } catch { /* ignore */ }
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch { /* ignore */ }
    }
    if (ctx) {
      try { await ctx.close?.(); } catch { /* ignore */ }
    }
  }

  async function attachAudioPipeline(stream, token) {
    if (!AudioContextCtor || !AudioWorkletNodeCtor) {
      throw new Error('当前环境不支持 Web Audio / AudioWorklet');
    }
    const spec = modelRegistry.get(modelId);
    const ctx = new AudioContextCtor();
    let node = null;
    let source = null;
    let silentGain = null;
    try {
      await ctx.resume?.();
      if (token !== runToken || disposed) {
        await cleanupLocalAudioPipeline({ ctx });
        return false;
      }
      await ctx.audioWorklet.addModule(workletUrl);
      if (token !== runToken || disposed) {
        await cleanupLocalAudioPipeline({ ctx });
        return false;
      }
      node = new AudioWorkletNodeCtor(ctx, 'live-audio-processor', {
        processorOptions: {
          targetRate: spec.sampleRate,
          windowSeconds: spec.windowSeconds,
          hopSeconds,
        },
      });
      node.port.onmessage = ({ data }) => {
        if (!data || token !== runToken || disposed || !isActiveStatus(status) || gateActive) return;
        if (data.type === 'envelope') {
          history.pushEnvelope(data.buckets, now());
          silentSeconds = Number(data.silentSeconds) || 0;
          silenceWarning = silentSeconds >= silenceWarningSeconds;
          emit();
        } else if (data.type === 'window') {
          const hist = history.summary();
          const wallEndMs = Math.max(hist.latestEpochMs, now());
          const rawStartMs = wallEndMs - spec.windowSeconds * 1000;
          const wallStartMs = hist.startEpochMs > 0 ? Math.max(hist.startEpochMs, rawStartMs) : rawStartMs;
          const task = {
            id: null,
            token,
            waveform: data.waveform,
            wallStartMs,
            wallEndMs,
          };
          if (workerBusy) {
            if (pendingWindow !== null) {
              droppedWindowCount++;
              pendingWindow = task;
              emit();
            } else {
              pendingWindow = task;
            }
          } else {
            void dispatchInference(task);
          }
        }
      };
      source = ctx.createMediaStreamSource(stream);
      silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      source.connect(node);
      node.connect(silentGain);
      silentGain.connect(ctx.destination);

      if (token !== runToken || disposed) {
        await cleanupLocalAudioPipeline({ ctx, node, source, silentGain });
        return false;
      }

      audioCtx = ctx;
      sourceNode = source;
      workletNode = node;
      silentGainNode = silentGain;
      return true;
    } catch (err) {
      await cleanupLocalAudioPipeline({ ctx, node, source, silentGain });
      throw err;
    }
  }

  function shouldGate() {
    return playbackUnmuted && !(sourceKind === AUDIO_SOURCE_KINDS.DEVICE && allowGateBypass);
  }

  function postWorkletPause(paused) {
    try {
      workletNode?.port?.postMessage?.({ type: 'pause', value: Boolean(paused) });
    } catch { /* ignore */ }
  }

  function reconcilePlaybackGate({ forceEmit = false } = {}) {
    if (!isActiveStatus(status)) {
      gateActive = false;
      gateReason = null;
      pausedAtMs = null;
      if (forceEmit) emit();
      return;
    }
    const nextGate = shouldGate();
    const nextReason = nextGate ? playbackGateReason : null;
    const nextStatus = nextGate ? LIVE_MONITOR_STATES.PAUSED_LOOPBACK : LIVE_MONITOR_STATES.LISTENING;
    const changed = nextGate !== gateActive || nextReason !== gateReason || nextStatus !== status;

    if (!gateActive && nextGate) {
      pendingWindow = null;
      pausedAtMs = now();
      postWorkletPause(true);
    } else if (gateActive && !nextGate) {
      if (pausedAtMs !== null) {
        history.syncWallClock(now());
        pausedAtMs = null;
      }
      postWorkletPause(false);
    }

    gateActive = nextGate;
    gateReason = nextReason;
    status = nextStatus;
    if (changed || forceEmit) emit();
  }

  function setPlaybackGate(isPlayingUnmuted, reason = '回放中 · 已暂停对局监听') {
    if (disposed) return snapshot();
    playbackUnmuted = Boolean(isPlayingUnmuted);
    playbackGateReason = playbackUnmuted ? (reason || '回放中 · 已暂停对局监听') : null;
    reconcilePlaybackGate();
    return snapshot();
  }

  function setAllowGateBypass(allow) {
    if (disposed || sourceKind !== AUDIO_SOURCE_KINDS.DEVICE) return false;
    const next = Boolean(allow);
    const changed = next !== allowGateBypass;
    allowGateBypass = next;
    reconcilePlaybackGate({ forceEmit: changed });
    return true;
  }

  function bindAudioTrackEnded(stream, token) {
    for (const track of stream.getAudioTracks()) {
      const onEnded = () => {
        if (token !== runToken || disposed) return;
        if (status !== LIVE_MONITOR_STATES.STARTING && !isActiveStatus(status)) return;
        runToken++;
        status = LIVE_MONITOR_STATES.DISCONNECTED;
        audioLabel = null;
        gateActive = false;
        gateReason = null;
        pausedAtMs = null;
        disconnectReason = '音频流已断开，对局监听已停止';
        void teardownCapture();
        emit();
      };
      track.addEventListener('ended', onEnded);
      trackEndCleanups.push(() => track.removeEventListener('ended', onEnded));
    }
  }

  function hasActiveResources() {
    return Boolean(mediaStream || audioCtx || workletNode || sourceNode || silentGainNode || inferenceWorker || trackEndCleanups.length);
  }

  async function start({ sourceKind: requestedKind = AUDIO_SOURCE_KINDS.SYSTEM, deviceId: requestedDeviceId = null } = {}) {
    if (disposed) throw new Error('对局监听引擎已销毁');
    if (requestedKind !== AUDIO_SOURCE_KINDS.SYSTEM && requestedKind !== AUDIO_SOURCE_KINDS.DEVICE) {
      throw new Error(`不支持的音频源类型：${String(requestedKind)}`);
    }

    const token = ++runToken;
    sourceKind = requestedKind;
    deviceId = requestedKind === AUDIO_SOURCE_KINDS.DEVICE ? (requestedDeviceId || null) : null;
    if (requestedKind === AUDIO_SOURCE_KINDS.SYSTEM) allowGateBypass = false;
    status = LIVE_MONITOR_STATES.STARTING;
    gateActive = false;
    gateReason = null;
    pausedAtMs = null;
    error = null;
    disconnectReason = null;
    silentSeconds = 0;
    silenceWarning = false;
    emit();

    if (hasActiveResources()) {
      await teardownCapture();
      if (token !== runToken || disposed) return snapshot();
    }

    let stream = null;
    try {
      stream = requestedKind === AUDIO_SOURCE_KINDS.DEVICE
        ? await acquireDeviceStream(requestedDeviceId)
        : await acquireSystemStream();
      if (token !== runToken || disposed) {
        stopStreamTracks(stream);
        return snapshot();
      }
      const attached = await attachAudioPipeline(stream, token);
      if (!attached || token !== runToken || disposed) {
        stopStreamTracks(stream);
        return snapshot();
      }

      mediaStream = stream;
      const primaryAudio = stream.getAudioTracks()[0] || null;
      audioLabel = primaryAudio?.label || null;
      if (requestedKind === AUDIO_SOURCE_KINDS.DEVICE) {
        deviceId = primaryAudio?.getSettings?.()?.deviceId || requestedDeviceId || null;
      }
      bindAudioTrackEnded(stream, token);

      history.begin(now());
      if (shouldGate()) {
        gateActive = true;
        gateReason = playbackGateReason;
        pausedAtMs = now();
        status = LIVE_MONITOR_STATES.PAUSED_LOOPBACK;
        postWorkletPause(true);
      } else {
        gateActive = false;
        gateReason = null;
        pausedAtMs = null;
        status = LIVE_MONITOR_STATES.LISTENING;
      }
      emit();
      return snapshot();
    } catch (err) {
      if (stream && mediaStream !== stream) stopStreamTracks(stream);
      if (token === runToken && !disposed) {
        await teardownCapture();
        status = LIVE_MONITOR_STATES.ERROR;
        gateActive = false;
        gateReason = null;
        pausedAtMs = null;
        error = err?.message || String(err);
        emit();
      }
      throw err;
    }
  }

  async function stop() {
    if (disposed) return snapshot();
    const prevStatus = status;
    runToken++;
    await teardownCapture();
    status = LIVE_MONITOR_STATES.IDLE;
    audioLabel = null;
    gateActive = false;
    gateReason = null;
    pausedAtMs = null;
    silentSeconds = 0;
    silenceWarning = false;
    disconnectReason = null;
    error = null;
    if (prevStatus !== LIVE_MONITOR_STATES.IDLE) emit();
    return snapshot();
  }

  async function switchAudioSource({ sourceKind: nextKind, deviceId: nextDeviceId = null } = {}) {
    return start({ sourceKind: nextKind, deviceId: nextDeviceId });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    runToken++;
    await teardownCapture();
    status = LIVE_MONITOR_STATES.IDLE;
    audioLabel = null;
    gateActive = false;
    gateReason = null;
    pausedAtMs = null;
    silentSeconds = 0;
    silenceWarning = false;
    disconnectReason = null;
    error = null;
    history.clear();
    subscribers.clear();
  }

  return {
    start,
    stop,
    switchAudioSource,
    listAudioDevices,
    setPlaybackGate,
    setAllowGateBypass,
    getState: snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      if (disposed) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    getHistoryForAlignment: () => history.exportForAlignment(),
    dispose,
  };
}
