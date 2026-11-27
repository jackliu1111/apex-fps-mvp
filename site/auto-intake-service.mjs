import { createDirectoryWatcher } from './directory-watcher.mjs';
import { probeRecordingFile } from './recording-probe.mjs';
import { alignRecordingToLiveSession, extractMasterEnvelopeSlice } from './audio-aligner.mjs';
import { createMediaReadSource } from './media-read-source.mjs';
import { identifyFile } from './media-identity.mjs';
import { DEFAULT_MODEL } from './model-registry.mjs';
import { chooseAudioTracks } from './browser-analysis.mjs';

export const AUTO_INTAKE_STATES = Object.freeze({
  IDLE: 'idle',
  WATCHING: 'watching',
  ERROR: 'error',
});

export const INTAKE_EVENT_KINDS = Object.freeze({
  CONFORMED_EXACT: 'conformed-exact',
  CONFORMED_COARSE: 'conformed-coarse',
  UNANALYZED: 'unanalyzed',
});

export const ALIGNMENT_CONFIDENCE = Object.freeze({
  EXACT: 'exact',
  COARSE: 'coarse',
  UNMATCHED: 'unmatched',
});

function hasLiveHistoryCoverage(liveHistory) {
  if (!liveHistory || !Number.isFinite(liveHistory.startEpochMs) || liveHistory.startEpochMs <= 0) {
    return false;
  }
  const envLen = liveHistory.envRms?.length || 0;
  const winLen = liveHistory.scoreWindows?.length || 0;
  return envLen > 0 && winLen > 0;
}

/**
 * DOM-free background service for watch-directory auto-intake (自动接入)
 * and live-to-master recording conforming (原片升格), per ADR 0009.
 */
export function createAutoIntakeService({
  MB,
  queue,
  liveMonitor = null,
  getLiveHistory = null,
  identify = identifyFile,
  probeFile = null,
  alignRecording = alignRecordingToLiveSession,
  extractEnvelopeSlice = extractMasterEnvelopeSlice,
  model = DEFAULT_MODEL,
  threshold = 0.2,
  pollIntervalMs = 2000,
  stablePollsRequired = 2,
  stableDurationMs = pollIntervalMs * stablePollsRequired,
  now = () => Date.now(),
  onIntake = () => {},
  onError = () => {},
  resolveExistingRecord = null,
  beforeImport = null,
} = {}) {
  if (!queue) throw new Error('自动接入服务缺少录像分析实例');

  const subscribers = new Set();
  const exportedNames = new Set();
  const processingFiles = new Set();
  const inFlightSourceIds = new Set();
  const ingestedBySourceId = new Map();
  const identityCache = new WeakMap();

  let disposed = false;
  let status = AUTO_INTAKE_STATES.IDLE;
  let watcherState = { watching: false, directoryName: null, startedAt: 0, tracked: [] };
  let intakeCount = 0;
  let lastIntake = null;
  let error = null;

  function snapshot() {
    return Object.freeze({
      status,
      watching: watcherState.watching,
      directoryName: watcherState.directoryName,
      startedAt: watcherState.startedAt,
      tracked: Object.freeze(watcherState.tracked.map((entry) => Object.freeze({ ...entry }))),
      processingCount: processingFiles.size,
      processingFiles: Object.freeze([...processingFiles]),
      intakeCount,
      lastIntake: lastIntake ? Object.freeze({ ...lastIntake }) : null,
      error,
    });
  }

  function emit() {
    if (disposed) return;
    const state = snapshot();
    for (const listener of [...subscribers]) listener(state);
  }

  function reportError(err) {
    if (disposed) return;
    error = err?.message || String(err);
    onError(err);
    emit();
  }

  function resolveModel() {
    return liveMonitor?.getState?.()?.modelId || model || DEFAULT_MODEL;
  }

  function readLiveHistory() {
    if (typeof getLiveHistory === 'function') return getLiveHistory();
    if (typeof liveMonitor?.getHistoryForAlignment === 'function') return liveMonitor.getHistoryForAlignment();
    return null;
  }

  async function tryAlignWithLiveHistory(file, meta, liveHistory) {
    let input = null;
    let openedMedia = null;

    async function ensureOpenedMedia() {
      if (openedMedia) return openedMedia;
      if (!MB?.Input) throw new Error('缺少媒体解析器，无法执行声纹对齐');
      input = new MB.Input({ source: createMediaReadSource({ MB, file, priority: 'analysis', prefetchProfile: 'none' }), formats: MB.ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('录像缺少视频轨');
      const origin = Number.isFinite(meta?.origin) ? meta.origin : Math.max(0, await video.getFirstTimestamp());
      const duration = Number.isFinite(meta?.duration) && meta.duration > 0
        ? meta.duration
        : (await video.computeDuration() - origin);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('无效视频时长');
      const tracks = typeof input.getAudioTracks === 'function' ? await input.getAudioTracks() : [];
      const fallbackPrimary = !tracks.length && typeof input.getPrimaryAudioTrack === 'function'
        ? await input.getPrimaryAudioTrack()
        : null;
      const trackList = tracks.length ? tracks : (fallbackPrimary ? [fallbackPrimary] : []);
      const { selected: trackIndex } = await chooseAudioTracks(input, trackList);
      const audioTrack = trackList[trackIndex];
      const audioOrigin = typeof audioTrack.getFirstTimestamp === 'function'
        ? Math.max(0, await audioTrack.getFirstTimestamp())
        : origin;
      const rawAudioDuration = typeof audioTrack.computeDuration === 'function'
        ? (await audioTrack.computeDuration() - audioOrigin)
        : duration;
      const audioDuration = Number.isFinite(rawAudioDuration) && rawAudioDuration > 0 ? rawAudioDuration : duration;
      openedMedia = {
        origin,
        duration,
        audioTrack,
        trackIndex,
        audioDuration,
      };
      return openedMedia;
    }

    try {
      let origin = Number.isFinite(meta?.origin) ? meta.origin : null;
      let duration = Number.isFinite(meta?.duration) && meta.duration > 0 ? meta.duration : null;
      if (duration === null || origin === null) {
        const info = await ensureOpenedMedia();
        origin = info.origin;
        duration = info.duration;
      }

      const aligned = await alignRecording({
        file,
        duration,
        origin,
        trackIndex: openedMedia?.trackIndex ?? 0,
        liveHistory,
        extractSlice: async ({ startSec, spanSec }) => {
          const info = await ensureOpenedMedia();
          return extractEnvelopeSlice({
            MB,
            track: info.audioTrack,
            origin: info.origin,
            startSec,
            spanSec,
          });
        },
      });

      if (openedMedia && aligned?.mapped?.waveform) {
        aligned.mapped.waveform.trackIndex = openedMedia.trackIndex;
      }

      return {
        aligned,
        duration,
        audioDuration: openedMedia?.audioDuration ?? duration,
      };
    } finally {
      input?.dispose?.();
    }
  }

  async function identifyCached(file) {
    if (identityCache.has(file)) return identityCache.get(file);
    const identity = await identify(file);
    identityCache.set(file, identity);
    return identity;
  }

  async function findExistingRecord(identity, file) {
    if (typeof resolveExistingRecord === 'function') {
      const resolved = await resolveExistingRecord(identity, file);
      if (resolved) return resolved;
    }
    const rememberedId = ingestedBySourceId.get(identity.id);
    if (rememberedId) {
      const remembered = queue.get(rememberedId);
      if (remembered) return remembered;
      ingestedBySourceId.delete(identity.id);
    }
    for (const candidate of queue.records) {
      if (candidate.sourceId === identity.id || candidate.file === file) return candidate;
      if (
        !candidate.sourceId
        && candidate.file
        && candidate.file.name === file.name
        && candidate.file.size === file.size
        && candidate.file.lastModified === file.lastModified
      ) {
        try {
          const candidateId = await identifyCached(candidate.file);
          if (candidateId?.id === identity.id) return candidate;
        } catch { /* ignore unreadable prior file reference */ }
      }
    }
    return null;
  }

  async function handleReady({ name, file, meta = null }) {
    if (disposed || !file || exportedNames.has(name) || exportedNames.has(file.name)) return null;
    processingFiles.add(name);
    emit();
    let sourceKey = null;
    try {
      const identity = await identifyCached(file);
      if (disposed || exportedNames.has(name) || exportedNames.has(file.name)) return null;

      sourceKey = identity.id;
      if (inFlightSourceIds.has(sourceKey)) return null;
      inFlightSourceIds.add(sourceKey);

      const initialExisting = await findExistingRecord(identity, file);
      if (disposed || exportedNames.has(name) || exportedNames.has(file.name)) return null;
      if (initialExisting && (initialExisting.status === 'complete' || initialExisting.status === 'preparing')) {
        ingestedBySourceId.set(identity.id, initialExisting.id);
        return null;
      }

      const resolvedModel = resolveModel();
      const liveHistory = readLiveHistory();
      let conformAttempt = null;
      if (hasLiveHistoryCoverage(liveHistory)) {
        conformAttempt = await tryAlignWithLiveHistory(file, meta, liveHistory);
        if (disposed || exportedNames.has(name) || exportedNames.has(file.name)) return null;
      }

      const existing = await findExistingRecord(identity, file);
      if (disposed || exportedNames.has(name) || exportedNames.has(file.name)) return null;
      if (existing && (existing.status === 'complete' || existing.status === 'preparing')) {
        ingestedBySourceId.set(identity.id, existing.id);
        return null;
      }

      const aligned = conformAttempt?.aligned;
      const canConform = Boolean(
        aligned
        && (aligned.confidence === ALIGNMENT_CONFIDENCE.EXACT || aligned.confidence === ALIGNMENT_CONFIDENCE.COARSE)
        && aligned.mapped?.windowScores?.length > 0,
      );

      // Existing library entry without live overlap needs no duplicate intake.
      if (existing && !canConform) {
        ingestedBySourceId.set(identity.id, existing.id);
        return null;
      }

      if (typeof beforeImport === 'function') await beforeImport(file, identity);
      if (disposed || exportedNames.has(name) || exportedNames.has(file.name)) return null;

      let record;
      let eventKind;
      let alignment = null;

      const reusableExistingId = existing
        && (['unanalyzed', 'queued', 'analyzing', 'stopped'].includes(existing.status)
          || (existing.status === 'failed' && existing.duration > 0))
        ? existing.id
        : undefined;

      if (canConform) {
        alignment = {
          confidence: aligned.confidence,
          offsetMs: aligned.offsetMs,
          correlation: aligned.correlation,
          driftPpm: aligned.driftPpm,
          anchorStartSec: aligned.anchorStartSec,
          ...(Number.isFinite(aligned.masterStartEpochMs) ? { masterStartEpochMs: aligned.masterStartEpochMs } : {}),
          ...(Number.isFinite(aligned.coarseStartEpochMs) ? { coarseStartEpochMs: aligned.coarseStartEpochMs } : {}),
        };
        const precomputed = {
          model: resolvedModel,
          threshold,
          audioDuration: conformAttempt.audioDuration,
          audioOffset: 0,
          windowScores: aligned.mapped.windowScores,
          alignment,
          modelInfo: {
            model: resolvedModel,
            scoreType: 'frame',
            sampleRate: 16000,
            frameSeconds: 0.04,
            source: 'live-monitor',
          },
          scoreTimeline: aligned.mapped.scoreTimeline,
          waveform: aligned.mapped.waveform,
        };
        record = await queue.importPrecomputed(file, precomputed, reusableExistingId);
        eventKind = aligned.confidence === ALIGNMENT_CONFIDENCE.EXACT
          ? INTAKE_EVENT_KINDS.CONFORMED_EXACT
          : INTAKE_EVENT_KINDS.CONFORMED_COARSE;
      } else {
        const [imported] = await queue.importFiles([file], {
          model: resolvedModel,
          threshold,
          autoAnalyze: false,
        });
        record = imported;
        eventKind = INTAKE_EVENT_KINDS.UNANALYZED;
      }

      if (disposed || !record) return null;
      if (record.status === 'failed') {
        reportError(new Error(record.error || `自动接入失败：${name}`));
        return null;
      }

      ingestedBySourceId.set(identity.id, record.id);
      const event = {
        kind: eventKind,
        file,
        record,
        alignment: alignment ? { ...alignment } : null,
        name,
        sourceId: record.sourceId ?? identity.id,
      };
      intakeCount++;
      error = null;
      lastIntake = {
        kind: event.kind,
        name: event.name,
        recordId: record.id,
        sourceId: event.sourceId,
        alignment: alignment ? Object.freeze({ ...alignment }) : null,
        timestamp: now(),
      };
      emit();
      onIntake(event);
      return event;
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      if (sourceKey) inFlightSourceIds.delete(sourceKey);
      processingFiles.delete(name);
      emit();
    }
  }

  const watcher = createDirectoryWatcher({
    pollIntervalMs,
    stablePollsRequired,
    stableDurationMs,
    probeFile: probeFile || ((file) => probeRecordingFile(file, MB)),
    now,
    onStatus(next) {
      watcherState = next;
      if (!disposed) {
        status = next.watching ? AUTO_INTAKE_STATES.WATCHING : AUTO_INTAKE_STATES.IDLE;
        emit();
      }
    },
    async onReady(readyItem) {
      await handleReady(readyItem);
    },
    onError(err) {
      reportError(err);
    },
  });

  async function ensureReadOnlyPermission(dirHandle, { requestPermission = false } = {}) {
    if (typeof dirHandle.queryPermission !== 'function') return;
    let permission = await dirHandle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && requestPermission && typeof dirHandle.requestPermission === 'function') {
      permission = await dirHandle.requestPermission({ mode: 'read' });
    }
    if (permission !== 'granted') {
      throw new Error('录像监听目录缺少只读权限');
    }
  }

  async function startWatching(dirHandle, options = {}) {
    if (disposed) throw new Error('自动接入服务已销毁');
    if (!dirHandle) throw new Error('请选择录像监听目录');
    try {
      await ensureReadOnlyPermission(dirHandle, options);
      error = null;
      await watcher.start(dirHandle);
      return snapshot();
    } catch (err) {
      status = watcherState.watching ? AUTO_INTAKE_STATES.WATCHING : AUTO_INTAKE_STATES.ERROR;
      reportError(err);
      throw err;
    }
  }

  function stopWatching() {
    if (disposed) return snapshot();
    watcher.stop();
    status = AUTO_INTAKE_STATES.IDLE;
    emit();
    return snapshot();
  }

  async function pollNow() {
    if (disposed) return snapshot();
    await watcher.pollNow();
    return snapshot();
  }

  function resolveRecord(recordId) {
    if (!recordId) return null;
    return queue.get(recordId) || queue.records.find((item) => item.sourceId === recordId) || null;
  }

  async function startAnalysis(recordId, options = {}) {
    if (disposed) return false;
    const record = resolveRecord(recordId);
    if (!record || !['unanalyzed', 'stopped', 'failed'].includes(record.status)) return false;
    return queue.retry(record.id, options);
  }

  async function reanalyze(recordId, options = {}) {
    if (disposed) return false;
    const record = resolveRecord(recordId);
    if (!record || !['complete', 'stopped', 'failed', 'unanalyzed'].includes(record.status)) return false;
    return queue.retry(record.id, options);
  }

  function registerExportedFilename(name) {
    if (!name) return;
    exportedNames.add(name);
    watcher.registerExportedFilename(name);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (disposed) return () => {};
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    watcher.stop();
    processingFiles.clear();
    inFlightSourceIds.clear();
    ingestedBySourceId.clear();
    status = AUTO_INTAKE_STATES.IDLE;
    subscribers.clear();
  }

  return {
    startWatching,
    stopWatching,
    pollNow,
    registerExportedFilename,
    startAnalysis,
    reanalyze,
    getState: snapshot,
    subscribe,
    dispose,
  };
}
