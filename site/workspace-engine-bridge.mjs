// DOM-free coordinator wiring the pure-audio Live Monitor engine (#58) and
// Watch-Folder Auto-Intake / Master Conform service (#60) into the split-pane
// Local Clipping Workspace (#64/#65), with clean hook slots for #62 restore & alerts.

import {
  createLiveMonitorEngine,
  LIVE_MONITOR_STATES,
  AUDIO_SOURCE_KINDS,
} from './live-monitor-engine.mjs';
import {
  createAutoIntakeService,
  AUTO_INTAKE_STATES,
  INTAKE_EVENT_KINDS,
} from './auto-intake-service.mjs';
import { extractBasename } from './recording-library-projection.mjs';
import { dispatchReviewPrimaryAction } from './split-workspace-controller.mjs';
import { identifyFile } from './media-identity.mjs';
import { restorePersistedWatchDirectory as restorePersistedWatchDir } from './watch-dir-store.mjs';

export function mapLiveEngineStatus(engineStatus) {
  if (engineStatus === LIVE_MONITOR_STATES.IDLE || !engineStatus) return 'off';
  if (
    engineStatus === LIVE_MONITOR_STATES.STARTING
    || engineStatus === LIVE_MONITOR_STATES.LISTENING
    || engineStatus === LIVE_MONITOR_STATES.PAUSED_LOOPBACK
    || engineStatus === LIVE_MONITOR_STATES.DISCONNECTED
    || engineStatus === LIVE_MONITOR_STATES.ERROR
  ) {
    return engineStatus;
  }
  return 'off';
}

export function isUnmutedPlayback(playerState) {
  return Boolean(
    playerState
    && playerState.playing
    && !playerState.muted
    && Number(playerState.volume) > 0,
  );
}

export function createWorkspaceEngineBridge({
  MB,
  queue,
  uxController = null,
  identified = null,
  identify = identifyFile,
  liveMonitor: providedLiveMonitor = null,
  autoIntake: providedAutoIntake = null,
  liveMonitorOptions = {},
  autoIntakeOptions = {},
  watchDirStore = null,
  heartbeatPollIntervalMs = autoIntakeOptions.pollIntervalMs ?? 2000,
  now = () => Date.now(),
  isSecureContext = () => Boolean(globalThis.window?.isSecureContext ?? globalThis.isSecureContext),
  showDirectoryPicker = null,
  getActiveSourceId = () => null,
  isLibraryEmpty = () => true,
  translate = null,
  onStateChange = () => {},
  onIntake = () => {},
  onWatchDirectoryChange = () => {},
  onNotice = () => {},
  onError = () => {},
} = {}) {
  const ownsLiveMonitor = !providedLiveMonitor;
  const ownsAutoIntake = !providedAutoIntake;
  const subscribers = new Set();
  const pendingIntakeIds = new Set();
  const intakeWasEmptyById = new Map();

  let disposed = false;
  let preferredSourceKind = AUDIO_SOURCE_KINDS.SYSTEM;
  let preferredDeviceId = null;
  let desiredGateBypass = false;
  let audioDevices = [];

  let watchDirHandle = null;
  let watchDirRestorePending = false;
  let watchDirName = null;
  let watchDirError = null;
  let watchDirStatusOverride = null; // 'needs-permission' | 'error' | null

  let lastLiveStatus = 'off';
  let lastSilenceWarning = false;
  let lastEnvelopeBucketCount = 0;
  let lastHeartbeatPollMs = 0;

  const msg = (key, fallback, params = {}) => {
    if (typeof translate === 'function') return translate(key, params);
    let out = fallback;
    for (const [k, v] of Object.entries(params)) {
      out = out.replaceAll(`{${k}}`, v !== undefined && v !== null ? String(v) : '');
    }
    return out;
  };

  const liveMonitor = providedLiveMonitor || createLiveMonitorEngine({
    now,
    ...liveMonitorOptions,
  });

  const autoIntake = providedAutoIntake || createAutoIntakeService({
    MB,
    queue,
    liveMonitor,
    identify,
    now,
    ...autoIntakeOptions,
    async beforeImport(file, identity) {
      if (identified && file && identity) identified.set(file, identity);
      if (identity?.id) {
        const wasEmpty = Boolean(isLibraryEmpty());
        intakeWasEmptyById.set(identity.id, wasEmpty);
        pendingIntakeIds.add(identity.id);
        if (!wasEmpty) {
          uxController?.markRecordingNew?.(identity.id, { activeSourceId: getActiveSourceId() });
        }
      }
      if (typeof autoIntakeOptions.beforeImport === 'function') {
        await autoIntakeOptions.beforeImport(file, identity);
      }
    },
    onIntake(event) {
      const sourceId = event?.sourceId || null;
      const wasEmpty = sourceId ? Boolean(intakeWasEmptyById.get(sourceId)) : false;
      if (sourceId) {
        pendingIntakeIds.delete(sourceId);
        intakeWasEmptyById.delete(sourceId);
        if (!wasEmpty && sourceId !== getActiveSourceId()) {
          uxController?.markRecordingNew?.(sourceId, { activeSourceId: getActiveSourceId() });
        }
      }
      const basename = extractBasename(event?.name || event?.file?.name || '');
      if (event?.kind === INTAKE_EVENT_KINDS.CONFORMED_EXACT) {
        onNotice(msg('note_intake_exact', `Auto-ingested & ready: ${basename}`, { name: basename }), 'info');
      } else if (event?.kind === INTAKE_EVENT_KINDS.CONFORMED_COARSE) {
        onNotice(msg('note_intake_coarse', `Auto-ingested (coarse alignment): ${basename}`, { name: basename }), 'info');
      } else if (event?.kind === INTAKE_EVENT_KINDS.UNANALYZED) {
        onNotice(msg('note_intake_unanalyzed', `Auto-ingested (unanalyzed): ${basename}`, { name: basename }), 'info');
      }
      emit();
      onIntake({ ...event, wasEmpty });
      if (typeof autoIntakeOptions.onIntake === 'function') {
        autoIntakeOptions.onIntake(event);
      }
    },
    onError(err) {
      for (const id of [...pendingIntakeIds]) {
        if (!queue?.records?.some((rec) => rec.sourceId === id)) {
          uxController?.clearRecordingNew?.(id);
        }
      }
      pendingIntakeIds.clear();
      intakeWasEmptyById.clear();
      watchDirError = err?.message || String(err);
      onError(err);
      emit();
      if (typeof autoIntakeOptions.onError === 'function') {
        autoIntakeOptions.onError(err);
      }
    },
  });

  function resolvePicker() {
    if (typeof showDirectoryPicker === 'function') return showDirectoryPicker;
    if (typeof globalThis.window?.showDirectoryPicker === 'function') {
      return (...args) => globalThis.window.showDirectoryPicker(...args);
    }
    return null;
  }

  function buildLiveState() {
    const raw = liveMonitor.getState();
    const status = mapLiveEngineStatus(raw.status);
    const active = status === 'listening' || status === 'paused-loopback' || status === 'starting';
    const effectiveSourceKind = raw.sourceKind || preferredSourceKind;
    const effectiveDeviceId = effectiveSourceKind === AUDIO_SOURCE_KINDS.DEVICE
      ? (raw.deviceId || preferredDeviceId)
      : null;
    const allowGateBypass = effectiveSourceKind === AUDIO_SOURCE_KINDS.DEVICE
      ? Boolean(active ? raw.allowGateBypass : desiredGateBypass)
      : false;
    return Object.freeze({
      status,
      active,
      canToggle: true,
      sourceKind: raw.sourceKind,
      preferredSourceKind,
      effectiveSourceKind,
      deviceId: effectiveDeviceId,
      preferredDeviceId,
      audioLabel: raw.audioLabel || null,
      audioDevices: Object.freeze(audioDevices.map((d) => Object.freeze({ ...d }))),
      allowGateBypass,
      gateActive: Boolean(raw.gateActive),
      gateReason: raw.gateReason || null,
      silentSeconds: Number(raw.silentSeconds) || 0,
      silenceWarning: Boolean(raw.silenceWarning),
      disconnectReason: raw.disconnectReason || null,
      error: raw.error || null,
      modelStatus: raw.modelStatus || null,
      inferenceCount: Number(raw.inferenceCount) || 0,
      historyDurationSec: Number(raw.historyDurationSec) || 0,
    });
  }

  function buildWatchDirState() {
    const raw = autoIntake.getState();
    const activeBasename = extractBasename(raw.directoryName || '');
    const name = activeBasename || watchDirName || null;
    let status = 'unset';
    if (raw.watching && name) {
      status = 'watching';
    } else if (watchDirRestorePending && name) {
      status = 'needs-permission';
    } else if (watchDirStatusOverride === 'error' || raw.status === AUTO_INTAKE_STATES.ERROR) {
      status = 'error';
    } else if (name && raw.watching) {
      status = 'watching';
    }
    return Object.freeze({
      status,
      name,
      watching: Boolean(raw.watching),
      needsRestore: status === 'needs-permission',
      canChoose: true,
      error: watchDirError || raw.error || null,
      processingCount: Number(raw.processingCount) || 0,
      intakeCount: Number(raw.intakeCount) || 0,
      lastIntake: raw.lastIntake || null,
    });
  }

  function snapshot() {
    return Object.freeze({
      liveMonitor: buildLiveState(),
      watchDirectory: buildWatchDirState(),
    });
  }

  function emit() {
    if (disposed) return;
    const next = snapshot();
    onStateChange(next);
    for (const listener of [...subscribers]) listener(next);
  }

  const unsubLive = liveMonitor.subscribe((raw) => {
    const mapped = mapLiveEngineStatus(raw.status);
    if (mapped === 'disconnected' && lastLiveStatus !== 'disconnected') {
      onNotice(raw.disconnectReason || msg('note_live_disconnected', 'Audio stream disconnected; Live Monitoring stopped.'), 'error');
    } else if (mapped === 'error' && lastLiveStatus !== 'error' && raw.error) {
      onNotice(raw.error, 'error');
    } else if (raw.silenceWarning && !lastSilenceWarning && mapped === 'listening') {
      onNotice(msg('note_live_silence_warning', 'No game audio detected for 10+ seconds. Check shared audio or input device.'), 'info');
    }
    const bucketCount = Number(raw.envelopeBucketCount) || 0;
    const envelopeAdvanced = bucketCount > lastEnvelopeBucketCount;
    lastEnvelopeBucketCount = bucketCount;
    lastLiveStatus = mapped;
    lastSilenceWarning = Boolean(raw.silenceWarning);
    emit();

    // AudioWorklet runs on the unthrottled audio thread, so envelope frames provide a
    // reliable background heartbeat for watch-directory polling when Chrome throttles setInterval.
    if (
      envelopeAdvanced
      && Number.isFinite(heartbeatPollIntervalMs)
      && heartbeatPollIntervalMs > 0
      && (mapped === 'listening' || mapped === 'paused-loopback')
      && autoIntake.getState().watching
    ) {
      const currentMs = now();
      if (lastHeartbeatPollMs === 0) {
        lastHeartbeatPollMs = currentMs;
      } else if (currentMs - lastHeartbeatPollMs >= heartbeatPollIntervalMs) {
        lastHeartbeatPollMs = currentMs;
        void autoIntake.pollNow().catch(() => {});
      }
    }
  });

  const unsubIntake = autoIntake.subscribe((raw) => {
    if (raw.watching) {
      if (lastHeartbeatPollMs === 0) lastHeartbeatPollMs = now();
      watchDirRestorePending = false;
      watchDirStatusOverride = null;
      watchDirError = raw.error || null;
      const base = extractBasename(raw.directoryName || '');
      if (base) watchDirName = base;
    } else {
      lastHeartbeatPollMs = 0;
    }
    emit();
  });

  async function refreshAudioDevices() {
    if (disposed) return [];
    try {
      const list = await liveMonitor.listAudioDevices();
      audioDevices = Array.isArray(list) ? list : [];
      if (preferredDeviceId && !audioDevices.some((d) => d.deviceId === preferredDeviceId)) {
        preferredDeviceId = audioDevices[0]?.deviceId || null;
      }
      emit();
      return audioDevices;
    } catch {
      return audioDevices;
    }
  }

  async function startLiveMonitor(options = {}) {
    if (disposed) return snapshot().liveMonitor;
    const requestedKind = options.sourceKind ?? preferredSourceKind;
    const requestedDeviceId = requestedKind === AUDIO_SOURCE_KINDS.DEVICE
      ? (options.deviceId !== undefined ? options.deviceId : preferredDeviceId)
      : null;

    preferredSourceKind = requestedKind;
    if (requestedKind === AUDIO_SOURCE_KINDS.DEVICE) {
      preferredDeviceId = requestedDeviceId;
    } else {
      desiredGateBypass = false;
    }

    const started = await liveMonitor.start({
      sourceKind: requestedKind,
      deviceId: requestedDeviceId,
    });
    if (requestedKind === AUDIO_SOURCE_KINDS.DEVICE) {
      if (started?.deviceId) preferredDeviceId = started.deviceId;
      if (desiredGateBypass) liveMonitor.setAllowGateBypass(true);
      void refreshAudioDevices();
    }
    emit();
    return snapshot().liveMonitor;
  }

  async function stopLiveMonitor() {
    if (disposed) return snapshot().liveMonitor;
    await liveMonitor.stop();
    emit();
    return snapshot().liveMonitor;
  }

  async function toggleLiveMonitor() {
    const current = buildLiveState();
    if (current.active) {
      return stopLiveMonitor();
    }
    return startLiveMonitor();
  }

  async function setAudioSourcePreference({ sourceKind, deviceId } = {}) {
    if (disposed) return snapshot().liveMonitor;
    const nextKind = sourceKind === AUDIO_SOURCE_KINDS.DEVICE
      ? AUDIO_SOURCE_KINDS.DEVICE
      : AUDIO_SOURCE_KINDS.SYSTEM;
    const nextDeviceId = nextKind === AUDIO_SOURCE_KINDS.DEVICE
      ? (deviceId !== undefined ? (deviceId || null) : preferredDeviceId)
      : null;

    preferredSourceKind = nextKind;
    if (nextKind === AUDIO_SOURCE_KINDS.DEVICE) {
      preferredDeviceId = nextDeviceId;
      await refreshAudioDevices();
    } else {
      desiredGateBypass = false;
    }

    const current = buildLiveState();
    if (current.active) {
      const switched = await liveMonitor.switchAudioSource({
        sourceKind: nextKind,
        deviceId: nextDeviceId,
      });
      if (nextKind === AUDIO_SOURCE_KINDS.DEVICE) {
        if (switched?.deviceId) preferredDeviceId = switched.deviceId;
        if (desiredGateBypass) liveMonitor.setAllowGateBypass(true);
      }
    }
    emit();
    return snapshot().liveMonitor;
  }

  function setAllowGateBypass(allow) {
    if (disposed) return false;
    const current = buildLiveState();
    if (current.effectiveSourceKind !== AUDIO_SOURCE_KINDS.DEVICE) {
      desiredGateBypass = false;
      emit();
      return false;
    }
    desiredGateBypass = Boolean(allow);
    if (current.sourceKind === AUDIO_SOURCE_KINDS.DEVICE) {
      liveMonitor.setAllowGateBypass(desiredGateBypass);
    }
    emit();
    return true;
  }

  function notifyPlayerState(playerState) {
    if (disposed) return null;
    const unmuted = isUnmutedPlayback(playerState);
    const reason = msg('live_gate_playback_reason', 'Paused during unmuted playback');
    return liveMonitor.setPlaybackGate(unmuted, reason);
  }

  async function setWatchDirectoryHandle(dirHandle, { requestPermission = false, persist = true } = {}) {
    if (disposed) return snapshot().watchDirectory;
    if (!dirHandle) {
      return stopWatchingDirectory();
    }
    const base = extractBasename(dirHandle.name || '');
    const wasRestorePending = watchDirRestorePending;
    watchDirHandle = dirHandle;
    watchDirName = base || null;
    watchDirError = null;
    watchDirStatusOverride = null;
    try {
      await autoIntake.startWatching(dirHandle, { requestPermission });
      watchDirRestorePending = false;
      watchDirStatusOverride = null;
      watchDirError = null;
      if (persist && watchDirStore && typeof watchDirStore.save === 'function') {
        await watchDirStore.save(dirHandle);
      }
      emit();
      onWatchDirectoryChange({ handle: dirHandle, state: snapshot().watchDirectory });
      return snapshot().watchDirectory;
    } catch (err) {
      watchDirError = err?.message || String(err);
      if (!autoIntake.getState().watching) {
        if (wasRestorePending && watchDirHandle === dirHandle) {
          watchDirRestorePending = true;
          watchDirStatusOverride = 'needs-permission';
        } else {
          watchDirStatusOverride = 'error';
        }
      }
      emit();
      throw err;
    }
  }

  function setWatchDirectoryRestoreNeeded(dirHandle, nameOverride = null) {
    if (disposed) return snapshot().watchDirectory;
    watchDirHandle = dirHandle || null;
    watchDirName = extractBasename(nameOverride || dirHandle?.name || '') || null;
    watchDirRestorePending = Boolean(watchDirName);
    watchDirStatusOverride = watchDirRestorePending ? 'needs-permission' : null;
    watchDirError = null;
    if (autoIntake.getState().watching) {
      autoIntake.stopWatching();
    }
    emit();
    return snapshot().watchDirectory;
  }

  async function restoreWatchDirectory() {
    if (disposed) return snapshot().watchDirectory;
    if (!watchDirHandle) {
      return chooseWatchDirectory();
    }
    return setWatchDirectoryHandle(watchDirHandle, { requestPermission: true });
  }

  async function chooseWatchDirectory() {
    if (disposed) return null;
    if (!isSecureContext()) {
      const err = new Error(msg('err_watch_dir_secure', 'Choosing a Watch Folder requires HTTPS or localhost.'));
      watchDirError = err.message;
      if (!autoIntake.getState().watching) watchDirStatusOverride = 'error';
      emit();
      throw err;
    }
    const picker = resolvePicker();
    if (!picker) {
      const err = new Error(msg('err_watch_dir_support', 'This browser does not support folder watching. Use desktop Chrome or Edge.'));
      watchDirError = err.message;
      if (!autoIntake.getState().watching) watchDirStatusOverride = 'error';
      emit();
      throw err;
    }
    let picked;
    try {
      picked = await picker({ id: 'apex-watch-recordings', mode: 'read' });
    } catch (err) {
      if (err?.name === 'AbortError') {
        onNotice(msg('note_watch_dir_aborted', 'Watch Folder selection cancelled.'), 'quiet');
        return null;
      }
      watchDirError = err?.message || String(err);
      if (!autoIntake.getState().watching) watchDirStatusOverride = 'error';
      emit();
      throw err;
    }
    if (!picked) return null;
    const state = await setWatchDirectoryHandle(picked, { requestPermission: true });
    onNotice(msg('note_watch_dir_started', `Watching folder: ${state.name}`, { name: state.name }), 'info');
    return state;
  }

  async function activateWatchDirectory(dirHandle = null, options = {}) {
    if (dirHandle) {
      return setWatchDirectoryHandle(dirHandle, options);
    }
    if (watchDirRestorePending && watchDirHandle) {
      return restoreWatchDirectory();
    }
    return chooseWatchDirectory();
  }

  function stopWatchingDirectory() {
    if (disposed) return snapshot().watchDirectory;
    autoIntake.stopWatching();
    watchDirHandle = null;
    watchDirName = null;
    watchDirRestorePending = false;
    watchDirStatusOverride = null;
    watchDirError = null;
    if (watchDirStore && typeof watchDirStore.clear === 'function') {
      void watchDirStore.clear();
    }
    emit();
    onWatchDirectoryChange({ handle: null, state: snapshot().watchDirectory });
    return snapshot().watchDirectory;
  }

  async function pollWatchDirectory() {
    if (disposed) return null;
    return autoIntake.pollNow();
  }

  function registerExportedFilename(name) {
    if (disposed || !name) return;
    autoIntake.registerExportedFilename(name);
  }

  async function dispatchPrimaryAction({ item, record, action = null } = {}) {
    return dispatchReviewPrimaryAction({ item, record, queue, autoIntake, action });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (disposed) return () => {};
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    unsubLive();
    unsubIntake();
    pendingIntakeIds.clear();
    intakeWasEmptyById.clear();
    subscribers.clear();
    if (ownsAutoIntake) autoIntake.dispose();
    if (ownsLiveMonitor) await liveMonitor.dispose();
  }

  async function restorePersistedWatchDirectory(storeOverride = watchDirStore) {
    if (disposed || !storeOverride) {
      return { outcome: 'empty', handle: null, state: snapshot().watchDirectory };
    }
    const result = await restorePersistedWatchDir({ store: storeOverride, engineBridge: api });
    if (result.outcome === 'restored' && result.state?.name) {
      onNotice(msg('note_watch_dir_restored', `Watch Folder restored automatically: ${result.state.name}`, { name: result.state.name }), 'quiet');
    } else if (result.outcome === 'needs-permission' && result.state?.name) {
      onNotice(msg('note_watch_dir_restore_needed', `Click "Restore Watch" in the top bar to resume watching: ${result.state.name}`, { name: result.state.name }), 'quiet');
    }
    return result;
  }

  const api = {
    liveMonitor,
    autoIntake,
    getState: snapshot,
    get watchDirState() { return buildWatchDirState(); },
    getWatchDirectoryHandle: () => watchDirHandle,
    getPendingIntakeIds: () => [...pendingIntakeIds],
    subscribe,
    startLiveMonitor,
    stopLiveMonitor,
    toggleLiveMonitor,
    setAudioSourcePreference,
    refreshAudioDevices,
    setAllowGateBypass,
    notifyPlayerState,
    chooseWatchDirectory,
    activateWatchDirectory,
    setWatchDirectoryHandle,
    setWatchDirectoryRestoreNeeded,
    restoreWatchDirectory,
    restorePersistedWatchDirectory,
    stopWatchingDirectory,
    pollWatchDirectory,
    registerExportedFilename,
    dispatchPrimaryAction,
    dispose,
  };
  return api;
}
