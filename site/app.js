import { preview, mountReviewPreview, renderReviewPreview } from './review-preview.mjs';
import { projectRecordingLibrary, extractBasename } from './recording-library-projection.mjs';
import { createRecordingLibraryView } from './recording-library-view.mjs';
import { isLibraryPreview, mountLibraryPreview } from './recording-library-preview.mjs';
import {
  resolveReviewPrimaryAction,
  resolveClippingLayout,
  reconcileSplitSelection,
  createSplitPlayerSync,
  createWorkspaceUxController,
  resolveRecordingShortcutTarget,
  resolveDrawerEscape,
  canAcceptWorkspaceDrop,
} from './split-workspace-controller.mjs';
import {
  isWorkspacePreview,
  mountSplitWorkspacePreview,
  renderWorkspacePreviewCanvas,
} from './split-workspace-preview.mjs';
import { createSelectionTimeline, selectionWindow } from './selection-timeline.mjs';
import { batchSummary, justCompleted, taskFeedback, createFrameSignal } from './task-feedback.mjs';
import * as MB from '/assets/vendor/mediabunny.mjs';
import { createReviewWorkspace } from './review-workspace.mjs';
import { identifyFile } from './media-identity.mjs';
import { createBrowserAnalysis } from './browser-analysis.mjs';
import { DEFAULT_MODEL } from './model-registry.mjs';
import { createSourcePlayer } from './source-player.mjs';
import { createExportQueue } from './export-queue.mjs';
import { createBrowserConverter } from './browser-export.mjs';
import { DEFAULT_EXPORT_SETTINGS, sourceExportSettings, exportSettings } from './export-policy.mjs';
import { t, getLang, onLanguageChange } from './i18n.js';
import { createWorkspaceEngineBridge } from './workspace-engine-bridge.mjs';
import { createLibraryIntakeControls } from './library-intake-controls.mjs';
import { createWatchDirStore } from './watch-dir-store.mjs';
import { createReadyNotifier } from './ready-notifier.mjs';
import {
  createBackgroundReadinessController,
  pickFirstReviewableCandidate,
} from './background-readiness-controller.mjs';
import { createDiagnosticLog, collectDiagnostics, copyTextToClipboard } from './diagnostics.mjs';

const $ = (id) => document.getElementById(id);
const libraryPreview = isLibraryPreview();
const workspacePreview = isWorkspacePreview();
const bindings = new Map(), identified = new WeakMap(), pendingImports = new Map();
const identifyingImports = new Set();
const autoIngestedIds = new Set(), manualImportedIds = new Set();
const batchRows = new Map();
const seenCandidates = new Map();
const startingExports = new Set();
const recordedErrors = new Map();
const diagnosticLog = createDiagnosticLog();
diagnosticLog.attachGlobalListeners(window);
let libraryPreviewHarness = null, workspacePreviewHarness = null;
let currentPage = 'clipping', activeSourceId = null, activeRecordId = null;
let directoryHandle = null, exportQueue, selectionTimeline, engineBridge = null, libraryIntakeControls = null;
let view = { sources: [], batches: [] }, playerState = { position: 0, playing: false, status: 'empty' };
let latestLibrarySnapshot = null;
let isRendering = false;
let lastRenderedCollapsed = null;
const intakeStateOverride = {
  liveMonitor: null,
  watchDirectory: null,
};
const intakeHandlers = {
  onChooseWatchDir: null,
  onStopWatchDir: null,
  onToggleAutoAnalyze: null,
  onToggleMonitoring: null,
  onStartMonitoring: null,
};
const uxController = createWorkspaceUxController({
  onChange() {
    if (!isRendering) render();
  },
});
const watchDirStore = createWatchDirStore();
const formatCandidateCountLabel = (count) => (
  count === 1 ? t('library_candidates_one') : t('library_candidates_count', { count })
);
const readyNotifier = createReadyNotifier({
  doc: document,
  getBaseTitle: () => t('page_title'),
  formatNotification({ name, candidateCount, isCoarse }) {
    const candidates = formatCandidateCountLabel(candidateCount);
    return {
      title: t('ready_notification_title'),
      body: t(isCoarse ? 'ready_notification_body_coarse' : 'ready_notification_body', {
        name: extractBasename(name || ''),
        candidates,
      }),
    };
  },
  onNotificationClick({ sourceId }) {
    if (sourceId) safely(() => openReview(sourceId, { focusFirstCandidate: true }));
  },
  onChange() {
    if (!isRendering) render();
  },
});
const backgroundReadiness = createBackgroundReadinessController({
  getVisibilityState: () => document.visibilityState,
  getActiveSourceId: () => activeSourceId,
  getCurrentPage: () => currentPage,
  hasRecording: (id) => view.sources.some((item) => item.id === id) || bindings.has(id),
  readyNotifier,
  uxController,
  openRecording: (id, opts) => openReview(id, opts),
  onPollWatchDirectory: () => engineBridge?.pollWatchDirectory(),
  onToastChange() {
    renderReadyToast();
  },
});

function setIntakeHandlers(handlers = {}) {
  if ('onChooseWatchDir' in handlers) intakeHandlers.onChooseWatchDir = handlers.onChooseWatchDir || null;
  if ('onStopWatchDir' in handlers) intakeHandlers.onStopWatchDir = handlers.onStopWatchDir || null;
  if ('onToggleAutoAnalyze' in handlers) intakeHandlers.onToggleAutoAnalyze = handlers.onToggleAutoAnalyze || null;
  if ('onToggleMonitoring' in handlers) intakeHandlers.onToggleMonitoring = handlers.onToggleMonitoring || null;
  if ('onStartMonitoring' in handlers) intakeHandlers.onStartMonitoring = handlers.onStartMonitoring || null;
}

function setIntakeState({ watchDirectory, liveMonitor } = {}) {
  if (watchDirectory !== undefined) intakeStateOverride.watchDirectory = watchDirectory ? { ...watchDirectory } : null;
  if (liveMonitor !== undefined) intakeStateOverride.liveMonitor = liveMonitor ? { ...liveMonitor } : null;
  render();
}

function getEffectiveSessionState() {
  const base = engineBridge ? engineBridge.getState() : {
    liveMonitor: { status: 'off', active: false, canToggle: false },
    watchDirectory: { status: 'unset', name: null, canChoose: true, autoAnalyzeUncovered: false },
  };
  const mergedWatch = intakeStateOverride.watchDirectory
    ? { ...base.watchDirectory, ...intakeStateOverride.watchDirectory }
    : base.watchDirectory;
  const watchActive = mergedWatch.status === 'watching';
  const mergedLive = intakeStateOverride.liveMonitor
    ? {
        ...base.liveMonitor,
        ...intakeStateOverride.liveMonitor,
        active: intakeStateOverride.liveMonitor.active ?? ['listening', 'paused-loopback', 'starting'].includes(intakeStateOverride.liveMonitor.status),
      }
    : base.liveMonitor;
  const effectiveLive = {
    ...mergedLive,
    canToggle: mergedLive.canToggle !== undefined ? Boolean(mergedLive.canToggle) : Boolean(mergedLive.active || watchActive),
  };
  return {
    liveMonitor: effectiveLive,
    watchDirectory: mergedWatch,
    readyNotifications: {
      enabled: readyNotifier.notificationsEnabled,
      permission: readyNotifier.notificationPermission,
    },
  };
}

const time = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const errorText = (error) => error?.message || String(error);
const source = () => view.sources.find((item) => item.id === activeSourceId);
const selectedClip = () => source()?.clips.find((clip) => clip.id === source().review.selectedClipId && !clip.excluded);
const reportedPage = () => {
  if (currentPage === 'exports') return 'exports';
  return libraryPreview ? 'analysis' : 'review';
};
let noteTimer = null;
const note = (message, tone = 'info') => {
  if (tone === 'error') diagnosticLog.record('ui.error', message);
  const pageKey = reportedPage();
  $('status').textContent = message;
  $('status').dataset.tone = tone;
  $('status').dataset.page = pageKey;
  $('status').hidden = false;
  clearTimeout(noteTimer);
  if (pageKey === 'review') {
    noteTimer = setTimeout(() => {
      if (reportedPage() === 'review') $('status').hidden = true;
    }, tone === 'error' ? 6000 : 3500);
  }
};
const safely = (action) => Promise.resolve().then(action).catch((error) => note(errorText(error), 'error'));
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.onclick = () => safely(action); return node; };
const setValue = (node, value) => { if (document.activeElement !== node) node.value = value; };
const workspace = createReviewWorkspace({ onChange(next) { view = next; render(); } });
const queue = createBrowserAnalysis({ MB,
  onWaveform(record, waveform) { if (record.sourceId) workspace.updateWaveform(record.sourceId, waveform); },
  async onPrepared(record) {
    const identity = identified.get(record.file) || await identifyFile(record.file);
    record.sourceId = workspace.addSource({ ...identity, duration: record.duration });
    bindings.set(record.sourceId, record);
    uxController.promoteRecordingNew(`runtime:${record.id}`, record.sourceId, { activeSourceId });
  },
  onCandidates(record, candidates) { if (record.sourceId) workspace.publishCandidates(record.sourceId, candidates); },
  onChange(record) {
    if (record.error && recordedErrors.get(`analysis:${record.id}`) !== record.error) {
      recordedErrors.set(`analysis:${record.id}`, record.error);
      diagnosticLog.record('analysis', record.error, { status: record.status, model: record.model });
    }
    let workspaceUpdated = false;
    let becameReady = false;
    if (record.sourceId) {
      const next = { status: record.status === 'complete' ? 'completed' : record.status, processedUntil: Math.min(record.duration, Math.max(0, record.processedUntil || 0)), error: record.error || null };
      const prior = workspace.getSource(record.sourceId).analysis;
      becameReady = prior.status !== 'completed' && next.status === 'completed';
      if (Object.keys(next).some((key) => next[key] !== prior[key])) {
        workspace.updateAnalysis(record.sourceId, next);
        workspaceUpdated = true;
      }
    }
    if (!workspaceUpdated) render();
    if (becameReady && record.sourceId) {
      notifyRecordingReady(record.sourceId, record);
    }
    exportQueue?.pump();
  },
});
let idleTimer = null, lastMouseX = null, lastMouseY = null;
function resetPlayerIdle(event) {
  if ((event?.type === 'mousemove' || event?.type === 'mouseenter') && Number.isFinite(event.clientX)) {
    if (event.clientX === lastMouseX && event.clientY === lastMouseY) return;
    lastMouseX = event.clientX; lastMouseY = event.clientY;
  }
  if (idleTimer) clearTimeout(idleTimer);
  const frame = $('player-frame');
  if (!frame) return;
  frame.dataset.idle = 'false';
  if (playerState.playing) {
    idleTimer = setTimeout(() => {
      if (playerState.playing) frame.dataset.idle = 'true';
    }, 2500);
  }
}
const playerSync = createSplitPlayerSync({
  getRecord: (id) => bindings.get(id) || null,
  getPosition: (id) => workspace.getSource(id).review.position,
  pausePlayer: () => player.pause(),
  loadPlayer: (params) => player.load(params),
  disposePlayer: () => player.dispose(),
  clearCanvas: () => {
    const canvas = $('source-canvas');
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  },
  onStateChange: () => renderPlayer(),
  onError: (error) => note(errorText(error)),
});
const player = createSourcePlayer({ MB, canvas: $('source-canvas'), onState(next) {
  playerState = next;
  const frame = $('player-frame');
  if (frame) {
    frame.dataset.playing = String(!!next.playing);
    if (!next.playing) {
      if (idleTimer) clearTimeout(idleTimer);
      frame.dataset.idle = 'false';
    } else {
      resetPlayerIdle();
    }
  }
  const loadedId = playerSync.loadedSourceId;
  if (!playerSync.isLoading && loadedId && loadedId === activeSourceId) {
    const saved = workspace.getSource(loadedId).review.position;
    if (Math.abs(saved - next.position) >= 0.25 || (!next.playing && saved !== next.position)) workspace.setReview(loadedId, { position: next.position });
  }
  engineBridge?.notifyPlayerState(next);
  renderPlayer();
} });

let outputSettings = DEFAULT_EXPORT_SETTINGS;
exportQueue = createExportQueue({
  convert: createBrowserConverter({
    MB,
    onOutputFileCreated(name) {
      engineBridge?.registerExportedFilename(name);
    },
  }),
  onChange({ id, status, outputs, error, progress, clipResults, destination }) {
    if (error && recordedErrors.get(`export:${id}`) !== error) {
      recordedErrors.set(`export:${id}`, error);
      diagnosticLog.record('export', error, { status });
    }
    workspace.updateBatch(id, { status, outputs, error, progress, clipResults, destination });
  },
  onOutput(_batchId, output) {
    if (output?.name) {
      engineBridge?.registerExportedFilename(output.name);
    }
  },
});

engineBridge = createWorkspaceEngineBridge({
  MB,
  queue,
  uxController,
  watchDirStore,
  identified,
  identify: identifyFile,
  getActiveSourceId: () => activeSourceId,
  isLibraryEmpty: () => view.sources.length === 0 && queue.records.length === 0,
  translate: t,
  onStateChange() {
    if (!isRendering) render();
  },
  onIntake(event) {
    if (event?.sourceId) autoIngestedIds.add(event.sourceId);
    if (!isRendering) render();
  },
  onNotice(message, tone) {
    note(message, tone);
  },
  onError(err) {
    diagnosticLog.record('auto-intake', err);
    note(errorText(err), 'error');
  },
});
function directoryCapabilityError() {
  if (!window.isSecureContext) return t('err_dir_secure');
  if (typeof window.showDirectoryPicker !== 'function') return t('err_dir_support');
  return null;
}
async function chooseOutputDirectory() {
  const unavailable = directoryCapabilityError();
  if (unavailable) throw new Error(unavailable);
  const selected = await window.showDirectoryPicker({ id: 'apex-clip-exports', mode: 'readwrite' });
  let permission = await selected.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') permission = await selected.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error(t('err_dir_permission'));
  directoryHandle = selected;
  $('output-directory').textContent = t('output_dir_next', { name: directoryHandle.name });
  $('choose-directory').textContent = t('change_directory');
  return selected;
}
async function submitExport() {
  const saved = source(), record = bindings.get(activeSourceId);
  if (!saved) throw new Error(t('err_select_video_first'));
  if (!record) throw new Error(t('err_no_source_record'));
  const clips = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  if (!clips.length) throw new Error(t('err_no_clips_selected'));
  const batch = workspace.submitBatch(saved.id, { audio: { trackIndex: record.outputAudioTrackIndex, policy: 'source-primary' }, output: { ...sourceExportSettings(outputSettings, record.video), model: record.model } });
  return startExport(batch.id);
}
async function startExport(id) {
  const live = exportQueue.getBatch(id);
  if (startingExports.has(id) || (live && live.status !== 'awaiting-destination')) return;
  const batch = view.batches.find((item) => item.id === id), record = bindings.get(batch?.sourceId);
  if (!record) throw new Error(t('err_no_batch_source'));
  startingExports.add(id);
  let destination = directoryHandle;
  try {
    workspace.updateBatch(id, { status: 'awaiting-destination', error: null });
    showExports();
    const unavailable = directoryCapabilityError();
    if (unavailable) throw new Error(unavailable);
    // The picker is only invoked from this user action, never from queue execution.
    if (!destination || batch.status === 'awaiting-destination') destination = await chooseOutputDirectory();
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    if (await destination.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error(t('err_dir_permission_lost'));
    }
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    if (live) exportQueue.resume(id, destination);
    else exportQueue.enqueue(batch, { file: record.file, origin: record.origin, directoryHandle: destination });
  } catch (error) {
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    const message = error.name === 'AbortError' ? t('err_dir_aborted') : errorText(error);
    workspace.updateBatch(id, { status: 'awaiting-destination', error: message });
    return;
  } finally { startingExports.delete(id); renderExports(); }
  note(t('note_export_submitted'));
}

function trackImport(sourceId, promise) {
  const pending = promise.finally(() => pendingImports.delete(sourceId));
  pendingImports.set(sourceId, pending);
  return pending;
}

async function importFiles(files, options = {}) {
  await ready;
  const fileList = [...files];
  if (!fileList.length) return;
  const wasEmpty = view.sources.length === 0 && queue.records.length === 0;
  const importOptions = { model: options.model || DEFAULT_MODEL, threshold: options.threshold ?? 0.2 };
  const failures = [];
  const importMessage = t('note_prep_files', { count: fileList.length });
  note(importMessage);
  let claimedEmptyFirst = false;
  const incoming = fileList.map(file => ({
    id: crypto.randomUUID(), file, status: 'identifying', intakeSource: 'manual',
  }));
  incoming.forEach(entry => identifyingImports.add(entry));
  render();
  await Promise.all(incoming.map(async entry => {
    const { file } = entry;
    let identity = null;
    try {
      identity = await identifyFile(file);
      identified.set(file, identity);
      if (bindings.has(identity.id) || pendingImports.has(identity.id)) { note(t('note_file_exists', { name: file.name })); return; }
      manualImportedIds.add(identity.id);
      const shouldMarkNew = !(wasEmpty && !claimedEmptyFirst);
      if (!shouldMarkNew) claimedEmptyFirst = true;
      identifyingImports.delete(entry);
      const pending = trackImport(identity.id, queue.importFiles([file], importOptions, () => entry.id));
      if (shouldMarkNew) {
        uxController.markRecordingNew(identity.id, { activeSourceId });
      }
      await pending;
    } catch (error) {
      if (identity?.id) uxController.clearRecordingNew(identity.id);
      failures.push(`${file.name}: ${errorText(error)}`);
    } finally {
      identifyingImports.delete(entry);
      render();
    }
  }));
  if (failures.length) note(t('note_import_failed', { list: failures.join('; ') }), 'error');
  else if ($('status').textContent === importMessage) note(t('note_files_added'), 'quiet');
}
function buildLibrarySnapshot(selectedId = activeSourceId) {
  const combinedRecords = [...queue.records, ...identifyingImports];
  const seenSourceIds = new Set(combinedRecords.map((record) => record?.sourceId).filter(Boolean));
  for (const [sourceId, record] of bindings) {
    if (record && !seenSourceIds.has(sourceId)) {
      combinedRecords.push(record);
      seenSourceIds.add(sourceId);
    }
  }
  const effectiveNewIds = new Set(uxController.getNewRecordingIds());
  for (const record of combinedRecords) {
    if (!record || record.sourceId) continue;
    const pendingIdentity = record.file ? identified.get(record.file) : null;
    if (pendingIdentity && effectiveNewIds.has(pendingIdentity.id)) {
      effectiveNewIds.add(`runtime:${record.id}`);
    }
  }
  const sessionState = getEffectiveSessionState();
  const effectiveAutoIds = new Set(autoIngestedIds);
  const effectiveManualIds = new Set(manualImportedIds);
  for (const record of combinedRecords) {
    if (!record || record.sourceId) continue;
    const pendingIdentity = record.file ? identified.get(record.file) : null;
    if (pendingIdentity) {
      if (effectiveAutoIds.has(pendingIdentity.id)) effectiveAutoIds.add(`runtime:${record.id}`);
      if (effectiveManualIds.has(pendingIdentity.id)) effectiveManualIds.add(`runtime:${record.id}`);
    }
  }
  return projectRecordingLibrary({
    sources: view.sources,
    records: combinedRecords,
    batches: view.batches,
    activeSourceId: selectedId,
    newIds: effectiveNewIds,
    autoIngestedIds: effectiveAutoIds,
    manualImportedIds: effectiveManualIds,
    liveMonitor: sessionState.liveMonitor,
    watchDirectory: sessionState.watchDirectory,
    sortOrder: 'newest-first',
  });
}

function notifyRecordingReady(sourceId, record = null) {
  if (!sourceId || !view.sources.some((item) => item.id === sourceId)) return;
  const saved = workspace.getSource(sourceId);
  const rec = record || bindings.get(sourceId) || null;
  const name = extractBasename(rec?.file?.name || saved?.identity?.name || '');
  const candidateCount = saved.clips.filter((clip) => !clip.provisional && !clip.excluded).length;
  const isCoarse = rec?.alignment?.confidence === 'coarse';
  backgroundReadiness.onRecordingReady({
    sourceId,
    name,
    candidateCount,
    isCoarse,
  });
}

function renderReadyToast() {
  const toastNode = $('ready-toast');
  if (!toastNode) return;
  const toast = backgroundReadiness.activeToast;
  if (!toast || libraryPreview) {
    toastNode.hidden = true;
    toastNode.dataset.sourceId = '';
    return;
  }
  toastNode.hidden = false;
  toastNode.dataset.sourceId = toast.sourceId;
  toastNode.dataset.coarse = String(Boolean(toast.isCoarse));
  const titleEl = $('ready-toast-title');
  const metaEl = $('ready-toast-meta');
  if (titleEl) {
    titleEl.textContent = toast.name;
    titleEl.title = toast.name;
  }
  if (metaEl) {
    if (toast.candidateCount > 0) {
      const candidates = formatCandidateCountLabel(toast.candidateCount);
      metaEl.textContent = t(toast.isCoarse ? 'ready_toast_meta_coarse' : 'ready_toast_meta_ready', { candidates });
    } else {
      metaEl.textContent = t(toast.isCoarse ? 'ready_toast_meta_coarse_no_candidates' : 'ready_toast_meta_no_candidates');
    }
  }
  const openBtn = $('ready-toast-open');
  if (openBtn) openBtn.textContent = t('ready_toast_open');
  const dismissBtn = $('ready-toast-dismiss');
  if (dismissBtn) {
    const label = t('ready_toast_dismiss_aria');
    dismissBtn.title = label;
    dismissBtn.setAttribute('aria-label', label);
  }
}

async function openReview(id, { focusFirstCandidate = false } = {}) {
  const snapshot = buildLibrarySnapshot();
  const hasItem = snapshot.items.some((item) => item.id === id) || view.sources.some((item) => item.id === id);
  if (!hasItem) return;

  const wasExports = currentPage === 'exports';
  currentPage = 'clipping';

  const loaded = playerSync.effectiveLoaded();
  const rec = reconcileSplitSelection({
    items: snapshot.items,
    activeSourceId,
    activeRecordId,
    requestedSourceId: id,
    loadedSourceId: loaded.sourceId,
    loadedFile: loaded.file,
    getFileForId: (sourceId) => bindings.get(sourceId)?.file || null,
  });

  const switched = rec.activeSourceId !== activeSourceId;
  let targetFirstClip = null;

  playerSync.withDeferredSync(() => {
    activeSourceId = rec.activeSourceId;
    activeRecordId = rec.activeRecordId;
    uxController.onRecordingOpened(activeSourceId);
    backgroundReadiness.onRecordingOpened(activeSourceId);

    if (activeSourceId && view.sources.some((item) => item.id === activeSourceId)) {
      const savedTarget = workspace.getSource(activeSourceId);
      seenCandidates.set(activeSourceId, savedTarget.clips.filter((clip) => !clip.provisional && !clip.excluded).length);
      if (focusFirstCandidate) {
        targetFirstClip = pickFirstReviewableCandidate(savedTarget);
        if (targetFirstClip) {
          workspace.setReview(activeSourceId, {
            selectedClipId: targetFirstClip.id,
            ...selectionWindow(savedTarget.duration, targetFirstClip),
            position: targetFirstClip.start,
          });
        }
      }
    }
    if (switched && !wasExports) {
      player.pause();
    }
    render();
  });

  const syncPromise = playerSync.syncSelection(rec);
  if (syncPromise) {
    await syncPromise;
  } else {
    if (playerSync.isLoading && playerSync.activeLoadPromise) {
      await playerSync.activeLoadPromise;
    }
    if (focusFirstCandidate && targetFirstClip && activeSourceId === rec.activeSourceId && bindings.get(activeSourceId)?.file) {
      await player.seek(targetFirstClip.start);
    }
    renderPlayer();
  }
}

function showAnalysis() {
  currentPage = 'clipping';
  render();
}

function showExports() {
  player.pause();
  playerSync.invalidate();
  currentPage = 'exports';
  selectionTimeline?.suspend();
  render();
}

function findLibraryRecord(id, item) {
  return bindings.get(id) || queue.records.find((record) => record.id === item?.recordId || record.sourceId === id) || null;
}

function invokeChooseWatchDir() {
  if (typeof intakeHandlers.onChooseWatchDir === 'function') {
    return intakeHandlers.onChooseWatchDir();
  }
  return engineBridge.chooseWatchDirectory();
}

function invokeRestoreWatchDir() {
  if (typeof intakeHandlers.onChooseWatchDir === 'function') {
    return intakeHandlers.onChooseWatchDir();
  }
  return engineBridge.restoreWatchDirectory();
}

function invokeStopWatchDir() {
  if (typeof intakeHandlers.onStopWatchDir === 'function') {
    return intakeHandlers.onStopWatchDir();
  }
  const state = engineBridge.stopWatchingDirectory();
  note(t('note_watch_dir_stopped'), 'quiet');
  return state;
}

function invokeToggleAutoAnalyze(enabled) {
  if (typeof intakeHandlers.onToggleAutoAnalyze === 'function') {
    return intakeHandlers.onToggleAutoAnalyze(enabled);
  }
  return engineBridge.setAutoAnalyzeUncovered(enabled);
}

function invokeToggleMonitoring() {
  const handler = intakeHandlers.onStartMonitoring || intakeHandlers.onToggleMonitoring;
  if (typeof handler === 'function') {
    return handler();
  }
  return engineBridge.toggleLiveMonitor();
}

libraryIntakeControls = createLibraryIntakeControls({
  doc: document,
  translate: t,
  onToggleLive: () => safely(invokeToggleMonitoring),
  onToggleAutoAnalyze: (enabled) => safely(() => invokeToggleAutoAnalyze(enabled)),
  onToggleReadyNotifications: (enabled) => safely(() => readyNotifier.setNotificationsEnabled(enabled)),
  onChooseWatchDir: () => safely(invokeChooseWatchDir),
  onRestoreWatchDir: () => safely(invokeRestoreWatchDir),
  onStopWatchDir: () => safely(invokeStopWatchDir),
});

async function dispatchLibraryAction(id, item) {
  const action = resolveReviewPrimaryAction(item);
  if (!action || action.disabled) return;
  if (workspacePreviewHarness && workspacePreviewHarness.runPreviewAction(id, action.kind)) {
    render();
    return;
  }
  const record = findLibraryRecord(id, item);
  await engineBridge.dispatchPrimaryAction({ item, record, action });
}

const libraryView = createRecordingLibraryView({
  listContainer: $('queue'),
  topbarContainer: null,
  countNode: $('queue-count'),
  summaryNode: $('queue-summary'),
  pageNode: $('analysis-page'),
  showActions: false,
  showSize: false,
  createEmptyGraphic: createFrameSignal,
  onReview: (id) => safely(() => openReview(id)),
  onAnalyze: (id, item) => safely(() => dispatchLibraryAction(id, item)),
  onSelect: (id) => safely(() => openReview(id)),
  onRowTransition: (row, kind) => taskFeedback(row, kind),
});

function selectRange(clip, jump = true) {
  const hasMedia = Boolean(bindings.get(activeSourceId)?.file);
  const shouldMove = jump && (hasMedia || preview || workspacePreview);
  workspace.setReview(activeSourceId, {
    selectedClipId: clip.id,
    ...selectionWindow(source().duration, clip),
    ...(shouldMove ? { position: clip.start } : {}),
  });
  if (jump && hasMedia) return player.seek(clip.start);
}
function renderRange(saved) {
  const clip = selectedClip(), valid = !!clip && !clip.provisional;
  for (const key of ['start', 'end']) {
    const quickBtn = $(`quick-set-${key}`);
    if (quickBtn) quickBtn.disabled = !valid || (key === 'start' ? saved.review.position >= clip.end : saved.review.position <= clip.start);
  }
  if ($('quick-fit-clip')) $('quick-fit-clip').disabled = !valid;
  const toggleBtn = $('toggle-current-clip');
  if (toggleBtn) {
    toggleBtn.disabled = !valid;
    toggleBtn.setAttribute('aria-pressed', String(!!(valid && clip.selected)));
    const toggleLabel = toggleBtn.querySelector?.('.btn-label') || toggleBtn;
    toggleLabel.textContent = !valid ? t('toggle_clip_export') : clip.selected ? t('toggle_clip_export_on') : t('toggle_clip_export_off');
  }
}
function renderPlayer() {
  const saved = source();
  if (currentPage === 'clipping' && saved && !$('review-page').hidden) selectionTimeline?.render(saved);
  if (!saved) return;
  const record = bindings.get(saved.id);
  const bound = Boolean(record?.file);
  const isLoading = playerSync.isLoading;
  const loadedId = playerSync.loadedSourceId;
  const playPauseBtn = $('play-pause');
  playPauseBtn.disabled = !bound || isLoading || playerState.status === 'loading' || playerState.status === 'error';
  playPauseBtn.dataset.playing = String(Boolean(playerState.playing));
  (playPauseBtn.querySelector?.('.btn-label') || playPauseBtn).textContent = playerState.playing ? t('pause') : t('play');
  const clip = selectedClip();
  $('play-selection').disabled = $('play-pause').disabled || !clip || clip.provisional || !(clip.end > clip.start);
  $('play-selection').dataset.playing = String(!!playerState.playRange && playerState.playing);
  const volume = playerState.volume ?? 0.5, muted = !!playerState.muted;
  const volumeText = `${Math.round(volume * 100)}%`;
  setValue($('player-volume'), volume);
  $('player-volume').setAttribute('aria-valuetext', `${volumeText}${muted ? ` (${t('volume_muted')})` : ''}`);
  $('player-volume-value').textContent = muted ? t('volume_muted') : volumeText;
  $('player-mute').setAttribute('aria-pressed', String(muted));
  $('player-mute').dataset.silent = String(muted || volume === 0);
  $('player-mute').title = muted ? t('unmute_title') : t('mute_title');
  $('player-mute').setAttribute('aria-label', $('player-mute').title);
  const position = loadedId === saved.id ? playerState.position : saved.review.position;
  $('playback-time').textContent = `${time(position)} / ${time(saved.duration)}${playerState.actual !== null && loadedId === saved.id ? ` · ${t('frame_text')} ${time(playerState.actual)}` : ''}`;
  const neighbors = adjacentCandidates(saved, position);
  $('prev-candidate').disabled = !neighbors.previous;
  $('next-candidate').disabled = !neighbors.next && saved.analysis.status !== 'analyzing';
  const fsBtn = $('player-fullscreen');
  if (fsBtn) {
    fsBtn.disabled = !bound || isLoading || playerState.status === 'error';
    const isFull = document.fullscreenElement === $('player-frame') || document.webkitFullscreenElement === $('player-frame');
    fsBtn.title = isFull ? t('exit_fullscreen_title') : t('fullscreen_title');
    fsBtn.setAttribute('aria-label', fsBtn.title);
  }
  if (record?.isPreviewMock) {
    renderWorkspacePreviewCanvas(saved, record);
    $('player-status').textContent = '';
  } else {
    $('player-status').textContent = !bound ? t('player_select_hint') : isLoading || ['loading', 'seeking'].includes(playerState.status) ? (getLang() === 'zh' ? '正在准备该位置…' : 'Preparing position...') : playerState.status === 'error' ? playerState.error : '';
  }
  renderReviewPreview(saved, bound);
}
function formatReviewProgressText(saved, activeItem) {
  if (!saved) return activeItem ? t('review_preparing_source') : t('review_empty_hint');
  const status = activeItem?.status || 'unanalyzed';
  const total = time(saved.duration);
  if (status === 'ready') return t('review_progress_compact_ready', { total });
  if (status === 'conformed-coarse') return t('review_progress_compact_coarse', { total });
  if (status === 'analyzing') {
    return t('review_progress_compact_analyzing', {
      percent: activeItem?.progressPercent ?? 0,
      current: time(saved.analysis.processedUntil),
      total,
    });
  }
  return t('review_progress_compact_unanalyzed', { total });
}
function renderReviewPrimaryAction(activeItem) {
  const btn = $('review-primary-action');
  if (!btn) return;
  const action = resolveReviewPrimaryAction(activeItem);
  if (!action) {
    btn.hidden = true;
    btn.disabled = false;
    btn.dataset.action = '';
    btn.dataset.tone = '';
    btn.textContent = '';
    return;
  }
  btn.hidden = false;
  btn.disabled = action.disabled;
  btn.dataset.action = action.kind;
  btn.dataset.tone = action.tone;
  btn.className = action.tone === 'primary'
    ? 'primary review-primary-action'
    : action.tone === 'warning'
      ? 'review-primary-action review-primary-action-warning'
      : 'quiet review-primary-action';
  btn.textContent = t(action.labelKey);
}
function renderWelcomeState(sessionState) {
  const welcomeNode = $('review-welcome');
  if (!welcomeNode) return;
  const watch = sessionState?.watchDirectory || { status: 'unset', name: null, canChoose: true };
  const live = sessionState?.liveMonitor || { status: 'off' };
  const watchStatus = watch.status || 'unset';
  const liveStatus = live.status || 'off';
  const isWatching = watchStatus === 'watching' && Boolean(watch.name);
  const needsRestore = watchStatus === 'needs-permission' && Boolean(watch.name);

  welcomeNode.dataset.watchStatus = watchStatus;
  welcomeNode.dataset.liveStatus = liveStatus;

  const methodsNode = $('welcome-methods');
  const standbyNode = $('welcome-standby');
  if (methodsNode) methodsNode.hidden = isWatching;
  if (standbyNode) standbyNode.hidden = !isWatching;

  if (isWatching) {
    const standbyTitle = $('welcome-standby-title');
    if (standbyTitle) standbyTitle.textContent = t('welcome_standby_title', { name: watch.name });
  } else {
    const watchCard = $('welcome-watch-card');
    if (watchCard) watchCard.dataset.needsRestore = String(needsRestore);
    const watchDesc = $('welcome-watch-desc');
    if (watchDesc) {
      watchDesc.textContent = needsRestore
        ? t('welcome_watch_restore_desc', { name: watch.name })
        : t('welcome_auto_desc');
    }
    const watchBtnLabel = $('welcome-watch-btn-label');
    if (watchBtnLabel) {
      watchBtnLabel.textContent = needsRestore
        ? t('welcome_watch_restore_cta', { name: watch.name })
        : t('welcome_watch_cta');
    }
    const watchBtn = $('welcome-watch-btn');
    if (watchBtn) watchBtn.disabled = watch.canChoose === false;
  }
}
function renderReview(activeItem = null) {
  const saved = source();
  const isEmpty = !saved && !activeItem;
  const reviewPage = $('review-page');
  if (reviewPage) reviewPage.dataset.empty = String(isEmpty);
  const welcomeNode = $('review-welcome');
  if (welcomeNode) {
    welcomeNode.hidden = !isEmpty;
    if (isEmpty) renderWelcomeState(getEffectiveSessionState());
  }
  const titleNode = $('review-source-title');
  const displayName = activeItem?.filename || extractBasename(saved?.identity?.name || '') || t('review_heading');
  if (titleNode) {
    if (titleNode.textContent !== displayName) titleNode.textContent = displayName;
    if (titleNode.title !== displayName) titleNode.title = displayName;
  }
  renderReviewPrimaryAction(activeItem);
  $('review-progress').textContent = formatReviewProgressText(saved, activeItem);

  if (!saved) {
    if ($('new-candidates')) $('new-candidates').textContent = '';
    $('selection-summary').textContent = '';
    $('playback-time').textContent = '';
    $('export').disabled = true;
    $('export').textContent = t('submit_export');
    const playPauseEmptyBtn = $('play-pause');
    playPauseEmptyBtn.disabled = true;
    playPauseEmptyBtn.dataset.playing = 'false';
    (playPauseEmptyBtn.querySelector?.('.btn-label') || playPauseEmptyBtn).textContent = t('play');
    $('play-selection').disabled = true;
    $('prev-candidate').disabled = true;
    $('next-candidate').disabled = true;
    if ($('player-fullscreen')) $('player-fullscreen').disabled = true;
    if ($('quick-manual')) $('quick-manual').disabled = true;
    if ($('quick-set-start')) $('quick-set-start').disabled = true;
    if ($('quick-set-end')) $('quick-set-end').disabled = true;
    if ($('quick-fit-clip')) $('quick-fit-clip').disabled = true;
    const toggleBtn = $('toggle-current-clip');
    if (toggleBtn) {
      toggleBtn.disabled = true;
      toggleBtn.setAttribute('aria-pressed', 'false');
      (toggleBtn.querySelector?.('.btn-label') || toggleBtn).textContent = t('toggle_clip_export');
    }
    $('player-status').textContent = activeItem ? t('review_preparing_source') : t('player_empty_hint');
    selectionTimeline?.render(null);
    return;
  }
  if ($('quick-manual')) $('quick-manual').disabled = false;
  const record = bindings.get(saved.id), selected = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  const added = saved.clips.filter((clip) => !clip.provisional && !clip.excluded).length - (seenCandidates.get(saved.id) || 0);
  if ($('new-candidates')) $('new-candidates').textContent = added > 0 ? t('new_candidates_badge', { count: added }) : '';
  const selectionSummary = t('selection_summary_text', { count: selected.length, duration: selected.reduce((total, clip) => total + clip.end - clip.start, 0).toFixed(2), unexported: saved.hasUnexportedChanges ? t('unexported_changes_tag') : '' });
  if ($('selection-summary').textContent !== selectionSummary) $('selection-summary').textContent = selectionSummary;
  $('export').disabled = !selected.length || !record?.file;
  $('export').textContent = t('submit_export');
  renderRange(saved);
  renderPlayer();
}
function renderExports() {
  const batchStatusMap = {
    'awaiting-destination': t('batch_awaiting_dir'),
    queued: t('batch_queued'),
    running: t('batch_running'),
    completed: t('batch_completed'),
    cancelled: t('batch_cancelled'),
    failed: t('batch_failed'),
    interrupted: t('batch_interrupted')
  };
  $('export-count').textContent = t('export_count', { count: view.batches.length });
  $('export-batches').querySelector('.empty-batches')?.remove();
  if (!view.batches.length && !$('export-batches').children.length) $('export-batches').append(element('p', t('batch_empty'), 'muted empty-batches'));
  for (const batch of view.batches) {
    let row = batchRows.get(batch.id);
    if (!row) {
      row = element('article', undefined, 'export-batch'); row.dataset.batchId = batch.id;
      const title = element('strong', undefined, 'batch-title'), state = element('p', undefined, 'batch-state');
      const destination = element('p', undefined, 'batch-destination');
      const summary = element('p', undefined, 'batch-summary');
      const attention = element('p', undefined, 'batch-attention');
      const files = element('details', undefined, 'batch-files');
      files.append(element('summary', t('batch_view_files', { count: 0 })));
      const details = element('details', undefined, 'inline-details batch-details');
      details.append(element('summary', t('batch_detail_summary')));
      const ranges = element('p', undefined, 'muted batch-ranges'), outcomes = element('ol', undefined, 'clip-outcomes'), outputs = element('div', undefined, 'batch-outputs');
      const cancel = button(t('batch_cancel_btn'), () => {
        if (exportQueue.getBatch(batch.id)) exportQueue.cancel(batch.id);
        else workspace.updateBatch(batch.id, { status: 'cancelled', error: t('batch_cancelled') });
      }); cancel.className = 'batch-cancel';
      const start = button(t('batch_start_btn'), () => startExport(batch.id)); start.className = 'batch-start';
      const review = button(t('batch_back_review_btn'), () => openReview(batch.sourceId)); review.className = 'batch-review';
      const actions = element('div', undefined, 'row'); actions.append(start, cancel, review);
      details.append(ranges, outcomes);
      files.append(outputs);
      row.append(title, state, summary, destination, attention, files, details, actions); batchRows.set(batch.id, row); $('export-batches').append(row);
    }
    const live = exportQueue.getBatch(batch.id);
    const completedNow = justCompleted(row.dataset.status, batch.status);
    row.dataset.status = batch.status;
    const summary = batchSummary(batch);
    row.querySelector('.batch-summary').textContent = batch.status === 'awaiting-destination' ? t('batch_summary_awaiting', { summary: summary.text }) : summary.text;
    const failures = (batch.clipResults || []).filter((result) => result.status === 'failed');
    const attention = row.querySelector('.batch-attention');
    const cleanupWarnings = (batch.clipResults || []).flatMap(result => result.cleanupWarnings || []);
    attention.hidden = !failures.length && !cleanupWarnings.length;
    attention.textContent = [failures.length ? `${getLang() === 'zh' ? '需处理' : 'Attention'}: ${failures.map((result) => `${time(result.start)}—${time(result.end)}${result.error ? `: ${result.error}` : ''}`).join('; ')}` : '', ...cleanupWarnings].filter(Boolean).join('; ');
    const files = row.querySelector('.batch-files');
    files.hidden = !(batch.outputs || []).length;
    files.querySelector('summary').textContent = t('batch_view_files', { count: (batch.outputs || []).length });
    if (completedNow) taskFeedback(row, 'completed');
    row.querySelector('.batch-title').textContent = t('batch_title_text', { name: batch.source.name, count: batch.clips.length });
    row.querySelector('.batch-destination').textContent = batch.destination?.mode === 'directory' ? t('batch_dest_dir', { name: batch.destination.name }) : batch.status === 'awaiting-destination' ? t('batch_dest_awaiting') : t('batch_dest_unrecorded');
    if (live?.pendingDestination && live.pendingDestination.name !== batch.destination?.name) row.querySelector('.batch-destination').textContent += t('batch_dest_pending', { name: live.pendingDestination.name });
    row.querySelector('.batch-state').textContent = `${batchStatusMap[batch.status] || batch.status}${batch.status === 'running' ? ` · ${Math.round(batch.progress * 100)}%` : ''}${live?.waitingReason ? ` · ${live.waitingReason}` : ''}${batch.error ? ` · ${batch.error}` : ''}`;
    row.querySelector('.batch-state').classList.toggle('error', batch.status === 'failed');
    row.querySelector('.batch-ranges').textContent = t('batch_ranges_info', {
      time: new Date(batch.createdAt).toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US'),
      ranges: batch.clips.map((clip) => `${clip.start.toFixed(2)}—${clip.end.toFixed(2)}s`).join('; '),
      format: (batch.output.format || outputSettings.format).toUpperCase(),
      video: (batch.output.videoCodec || outputSettings.videoCodec).toUpperCase(),
      audio: batch.output.audioCodec || outputSettings.audioCodec
    });
    row.querySelector('.batch-cancel').textContent = t('batch_cancel_btn');
    row.querySelector('.batch-cancel').hidden = batch.status !== 'awaiting-destination' && (!live || !['queued', 'running'].includes(batch.status));
    row.querySelector('.batch-start').hidden = batch.status !== 'awaiting-destination';
    row.querySelector('.batch-start').disabled = startingExports.has(batch.id);
    row.querySelector('.batch-start').textContent = bindings.has(batch.sourceId) ? t('batch_start_btn') : t('batch_resume_link_btn');
    row.querySelector('.batch-review').textContent = t('batch_back_review_btn');
    row.querySelector('.batch-details summary').textContent = t('batch_detail_summary');
    const resultKey = JSON.stringify(batch.clipResults || []);
    if (row.resultKey !== resultKey) {
      row.resultKey = resultKey;
      const labels = {
        'not-started': t('outcome_not_started'),
        running: t('outcome_running'),
        completed: t('outcome_completed'),
        failed: t('outcome_failed'),
        cancelled: t('outcome_cancelled'),
        interrupted: t('outcome_interrupted')
      };
      row.querySelector('.clip-outcomes').replaceChildren(...(batch.clipResults || []).map((result) => element('li', `${result.start.toFixed(2)}—${result.end.toFixed(2)} s · ${labels[result.status]}${result.error ? `: ${result.error}` : ''}`, 'clip-outcome')));
    }
    const outputKey = JSON.stringify(batch.outputs || []);
    if (row.outputKey !== outputKey) {
      row.outputKey = outputKey; const outputList = row.querySelector('.batch-outputs'); outputList.replaceChildren();
      for (const output of batch.outputs || []) {
        const item = element('div', undefined, 'output-item');
        const destName = output.destination?.name || batch.destination?.name || (getLang() === 'zh' ? '所选目录' : 'chosen folder');
        item.append(element('span', `${t('output_item_saved', { name: output.name, dest: destName })}${output.available ? '' : t('output_item_unverified')}`));
        if (output.verificationError) item.append(element('small', t('output_item_check_error', { err: output.verificationError }), 'muted'));
        const metadata = element('details', undefined, 'output-details');
        metadata.append(element('summary', t('output_item_details_summary', { size: (output.bytes / 1048576).toFixed(2) })));
        const reusedStr = output.reused ? t('output_item_reused') : '';
        const measuredStr = Number.isFinite(output.measuredDuration) ? t('output_item_readback', { duration: output.measuredDuration.toFixed(3) }) : t('output_item_readback_incomplete');
        metadata.append(element('small', t('output_item_meta', {
          reused: reusedStr,
          size: (output.bytes / 1048576).toFixed(2),
          duration: output.requestedDuration.toFixed(2),
          measured: measuredStr
        }), 'muted'));
        item.append(metadata);
        outputList.append(item);
      }
    }
  }
}
function renderWorkspaceUxChrome(snapshot, layout) {
  const clippingWorkspace = $('clipping-workspace');
  const collapsed = uxController.sidebarCollapsed;
  const drawerOpen = uxController.drawerOpen;
  if (clippingWorkspace) {
    clippingWorkspace.dataset.sidebarCollapsed = String(collapsed);
    clippingWorkspace.dataset.drawerOpen = String(drawerOpen);
  }

  const collapseBtn = $('sidebar-collapse-toggle');
  if (collapseBtn) {
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    const collapseLabel = t(collapsed ? 'sidebar_expand_title' : 'sidebar_collapse_title');
    collapseBtn.title = collapseLabel;
    collapseBtn.setAttribute('aria-label', collapseLabel);
  }

  const drawerToggle = $('library-drawer-toggle');
  if (drawerToggle) {
    drawerToggle.setAttribute('aria-expanded', String(drawerOpen));
    drawerToggle.dataset.hasNew = String(uxController.newCount > 0);
  }
  const drawerCount = $('library-drawer-count');
  if (drawerCount) {
    drawerCount.textContent = String(snapshot?.items?.length || 0);
  }
  const drawerNewDot = $('library-drawer-new-dot');
  if (drawerNewDot) {
    drawerNewDot.hidden = uxController.newCount === 0;
  }
  const backdrop = $('library-drawer-backdrop');
  if (backdrop) {
    backdrop.setAttribute('aria-hidden', String(!drawerOpen));
  }

  if (layout === 'split' && lastRenderedCollapsed !== null && lastRenderedCollapsed !== collapsed) {
    requestAnimationFrame(() => {
      const saved = source();
      if (currentPage === 'clipping' && saved && !$('review-page').hidden) {
        selectionTimeline?.render(saved);
      }
    });
  }
  lastRenderedCollapsed = collapsed;
}

function render() {
  isRendering = true;
  try {
    const clippingWorkspace = $('clipping-workspace');

    const baseSnapshot = libraryPreview ? null : buildLibrarySnapshot();
    const layout = resolveClippingLayout({
      page: currentPage,
      itemCount: baseSnapshot ? baseSnapshot.items.length : 0,
      forceStandaloneLibrary: libraryPreview,
    });
    uxController.handleLayoutChange(layout);
    libraryIntakeControls?.render(getEffectiveSessionState(), { hidden: layout !== 'split' });

    $('exports-section').hidden = layout !== 'exports';
    if (clippingWorkspace) {
      clippingWorkspace.hidden = layout === 'exports';
      clippingWorkspace.dataset.layout = layout === 'standalone-library' ? 'standalone-library' : 'split';
    }
    $('analysis-page').hidden = layout === 'exports';
    $('review-page').hidden = layout !== 'split';

    $('nav-exports').setAttribute('aria-current', layout === 'exports' ? 'page' : 'false');
    const activeExports = view.batches.filter((batch) => ['awaiting-destination', 'queued', 'running'].includes(batch.status)).length;
    $('nav-exports').textContent = activeExports ? t('nav_exports_badge', { count: activeExports }) : t('nav_exports');
    $('nav-analysis').setAttribute('aria-current', layout !== 'exports' ? 'page' : 'false');

    const canDrop = layout === 'split' || layout === 'standalone-library';
    $('drop-zone').setAttribute('aria-disabled', String(!canDrop));
    if (!canDrop) {
      $('drop-zone').classList.remove('drag-over');
      if (clippingWorkspace) {
        clippingWorkspace.dataset.dragOver = 'false';
        clippingWorkspace.classList.remove('drag-over');
      }
    }

    if (layout === 'standalone-library') {
      latestLibrarySnapshot = libraryPreviewHarness ? libraryPreviewHarness.rerender() : null;
    } else if (layout === 'split') {
      const hadLoaded = playerSync.loadedSourceId !== null || playerSync.isLoading;
      const loaded = playerSync.effectiveLoaded();
      const rec = reconcileSplitSelection({
        items: baseSnapshot.items,
        activeSourceId,
        activeRecordId,
        loadedSourceId: loaded.sourceId,
        loadedFile: loaded.file,
        getFileForId: (sourceId) => bindings.get(sourceId)?.file || null,
      });
      activeSourceId = rec.activeSourceId;
      activeRecordId = rec.activeRecordId;
      if (rec.changed && activeSourceId) {
        uxController.clearRecordingNew(activeSourceId);
      }
      if (rec.changed && activeSourceId && view.sources.some((item) => item.id === activeSourceId) && !seenCandidates.has(activeSourceId)) {
        seenCandidates.set(activeSourceId, workspace.getSource(activeSourceId).clips.filter((clip) => !clip.provisional && !clip.excluded).length);
      }
      const validIds = [
        ...baseSnapshot.items.map((item) => item.id),
        ...pendingImports.keys(),
        ...(engineBridge?.getPendingIntakeIds() || []),
      ];
      uxController.pruneNewIds(validIds);
      readyNotifier.prune(validIds);
      latestLibrarySnapshot = buildLibrarySnapshot(activeSourceId);
      const activeItem = latestLibrarySnapshot.items.find((item) => item.id === activeSourceId) || rec.activeItem;
      libraryView.render(latestLibrarySnapshot);
      renderReview(activeItem);
      if (baseSnapshot.items.length === 0 && hadLoaded) {
        void playerSync.loadSource(null, { forceDispose: true });
      } else {
        void playerSync.syncSelection(rec);
      }
    } else if (layout === 'exports') {
      latestLibrarySnapshot = baseSnapshot;
      renderExports();
    }

    if (layout !== 'split' || uxController.sidebarCollapsed) {
      hideLibraryRowHoverCard();
    }
    renderWorkspaceUxChrome(latestLibrarySnapshot, layout);
    renderReadyToast();

    const pageKey = reportedPage();
    $('status').hidden = $('status').dataset.page !== pageKey && $('status').dataset.tone !== 'error';
  } finally {
    isRendering = false;
  }
}

$('export').onclick = () => safely(submitExport);
$('choose-directory').onclick = () => { chooseOutputDirectory().catch((error) => note(error.name === 'AbortError' ? t('err_no_dir_picker') : errorText(error), 'error')); };
$('import-files').onclick = () => { $('files').click(); };
if ($('welcome-import-btn')) {
  $('welcome-import-btn').onclick = () => { if (!$('import-files').disabled) $('import-files').click(); };
}
if ($('welcome-watch-btn')) {
  $('welcome-watch-btn').onclick = () => {
    const watch = getEffectiveSessionState().watchDirectory;
    if (watch?.status === 'needs-permission' && watch?.name) {
      safely(invokeRestoreWatchDir);
    } else {
      safely(invokeChooseWatchDir);
    }
  };
}
if ($('welcome-standby-settings-btn')) {
  $('welcome-standby-settings-btn').onclick = (event) => {
    event?.stopPropagation?.();
    if (window.innerWidth <= 900) uxController.openDrawer();
    else if (uxController.sidebarCollapsed) uxController.setSidebarCollapsed(false);
    libraryIntakeControls?.openPopover();
  };
}
if ($('welcome-standby-import-btn')) {
  $('welcome-standby-import-btn').onclick = () => { if (!$('import-files').disabled) $('import-files').click(); };
}

// Floating detail hover card for single-line desktop sidebar recording rows
const rowHoverCard = $('library-row-hover-card');
const rowHoverTitle = $('library-hover-title');
const rowHoverStatus = $('library-hover-status');
const rowHoverSource = $('library-hover-source');
const rowHoverMeta = $('library-hover-meta');
const rowHoverSummary = $('library-hover-summary');
let hoveredLibraryRow = null;

function hideLibraryRowHoverCard() {
  hoveredLibraryRow = null;
  if (rowHoverCard) rowHoverCard.hidden = true;
}

function showLibraryRowHoverCard(row) {
  if (!rowHoverCard || !row) return;
  const workspaceEl = $('clipping-workspace');
  if (
    !workspaceEl
    || workspaceEl.hidden
    || workspaceEl.dataset.layout !== 'split'
    || workspaceEl.dataset.sidebarCollapsed === 'true'
    || window.innerWidth <= 900
  ) {
    hideLibraryRowHoverCard();
    return;
  }
  const title = row.querySelector('.library-filename')?.textContent || row.title || '';
  if (!title) {
    hideLibraryRowHoverCard();
    return;
  }
  hoveredLibraryRow = row;
  const statusEl = row.querySelector('.library-status-badge');
  const metaText = row.querySelector('.library-meta')?.textContent || '';
  const summaryText = row.querySelector('.library-summary-text')?.textContent || '';
  if (rowHoverTitle) rowHoverTitle.textContent = title;
  if (rowHoverStatus) {
    rowHoverStatus.textContent = statusEl?.textContent || '';
    rowHoverStatus.dataset.status = statusEl?.dataset.status || row.dataset.status || '';
  }
  if (rowHoverSource) {
    const origin = row.dataset.intakeSource || '';
    if (origin === 'auto' || origin === 'manual') {
      rowHoverSource.hidden = false;
      rowHoverSource.dataset.intakeSource = origin;
      rowHoverSource.textContent = t(origin === 'auto' ? 'intake_source_auto' : 'intake_source_manual');
    } else {
      rowHoverSource.hidden = true;
      rowHoverSource.dataset.intakeSource = '';
      rowHoverSource.textContent = '';
    }
  }
  if (rowHoverMeta) rowHoverMeta.textContent = metaText;
  if (rowHoverSummary) rowHoverSummary.textContent = summaryText;

  rowHoverCard.hidden = false;
  const rowRect = row.getBoundingClientRect();
  const panelRect = document.querySelector('#analysis-page .queue-panel')?.getBoundingClientRect() || rowRect;
  const cardRect = rowHoverCard.getBoundingClientRect();
  const left = Math.min(window.innerWidth - cardRect.width - 12, Math.max(12, panelRect.right + 8));
  const top = Math.min(window.innerHeight - cardRect.height - 12, Math.max(62, rowRect.top - 6));
  rowHoverCard.style.left = `${Math.round(left)}px`;
  rowHoverCard.style.top = `${Math.round(top)}px`;
}

if ($('queue')) {
  $('queue').addEventListener('pointerover', (event) => {
    const row = event.target?.closest?.('.file.library-row');
    if (row && row !== hoveredLibraryRow) showLibraryRowHoverCard(row);
  });
  $('queue').addEventListener('pointerleave', hideLibraryRowHoverCard);
  $('queue').addEventListener('focusin', (event) => {
    const row = event.target?.closest?.('.file.library-row');
    if (row) showLibraryRowHoverCard(row);
  });
  $('queue').addEventListener('focusout', (event) => {
    if (!$('queue')?.contains(event.relatedTarget)) hideLibraryRowHoverCard();
  });
}
$('drop-zone')?.addEventListener('scroll', hideLibraryRowHoverCard, { passive: true });
window.addEventListener('resize', hideLibraryRowHoverCard);
$('drop-zone').addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  const emptyEl = event.target.closest('.empty');
  if (currentPage === 'clipping' && !$('import-files').disabled && emptyEl && emptyEl.dataset.watchStatus !== 'watching') {
    $('import-files').click();
  }
});
$('files').onchange = () => { const files = [...$('files').files]; $('files').value = ''; safely(() => importFiles(files)); };
if ($('sidebar-collapse-toggle')) {
  $('sidebar-collapse-toggle').onclick = () => { uxController.toggleSidebarCollapsed(); };
}
if ($('library-drawer-toggle')) {
  $('library-drawer-toggle').onclick = () => { uxController.toggleDrawer(); };
}
if ($('library-drawer-close')) {
  $('library-drawer-close').onclick = () => { uxController.closeDrawer(); };
}
if ($('library-drawer-backdrop')) {
  $('library-drawer-backdrop').onclick = () => { uxController.closeDrawer(); };
}
window.addEventListener('resize', () => {
  uxController.handleViewportResize(window.innerWidth);
});

const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
let workspaceDragDepth = 0;
function setWorkspaceDragOver(active) {
  const workspaceEl = $('clipping-workspace');
  if (workspaceEl) {
    workspaceEl.dataset.dragOver = String(Boolean(active));
    workspaceEl.classList.toggle('drag-over', Boolean(active));
  }
  $('drop-zone')?.classList.toggle('drag-over', Boolean(active));
}
document.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  if (!canAcceptWorkspaceDrop({ page: currentPage, hasFiles: true })) return;
  event.preventDefault();
  workspaceDragDepth += 1;
  setWorkspaceDragOver(true);
});
document.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const canImport = canAcceptWorkspaceDrop({ page: currentPage, hasFiles: true });
  if (event.dataTransfer) event.dataTransfer.dropEffect = canImport ? 'copy' : 'none';
  setWorkspaceDragOver(canImport);
});
document.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  workspaceDragDepth = Math.max(0, workspaceDragDepth - 1);
  if (workspaceDragDepth === 0 || !event.relatedTarget) {
    workspaceDragDepth = 0;
    setWorkspaceDragOver(false);
  }
});
document.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  workspaceDragDepth = 0;
  setWorkspaceDragOver(false);
  if (!canAcceptWorkspaceDrop({ page: currentPage, hasFiles: true })) return;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) safely(() => importFiles(files));
});
window.addEventListener('dragend', () => {
  workspaceDragDepth = 0;
  setWorkspaceDragOver(false);
});
$('nav-exports').onclick = $('view-exports').onclick = showExports;
$('nav-analysis').onclick = showAnalysis;
if ($('review-primary-action')) {
  $('review-primary-action').onclick = () => safely(async () => {
    const item = latestLibrarySnapshot?.items.find((entry) => entry.id === activeSourceId) || null;
    await dispatchLibraryAction(activeSourceId, item);
  });
}
$('play-pause').onclick = () => { if (playerState.playing) player.pause(); else player.play().catch((error) => note(errorText(error))); };
$('play-selection').onclick = () => safely(() => {
  const clip = selectedClip();
  if (!$('play-selection').disabled && clip) return player.playRange({ start: clip.start, end: clip.end });
});
$('player-mute').onclick = () => player.toggleMute();
$('player-volume').oninput = () => {
  player.setVolume(Number($('player-volume').value));
  if (playerState.muted && playerState.volume > 0) player.toggleMute();
};
const playerFrame = $('player-frame');
if (playerFrame) {
  playerFrame.addEventListener('mousemove', resetPlayerIdle);
  playerFrame.addEventListener('mouseleave', () => {
    if (playerState.playing) {
      if (idleTimer) clearTimeout(idleTimer);
      playerFrame.dataset.idle = 'true';
    }
  });
}
function updateFullscreenState() {
  const isFull = document.fullscreenElement === playerFrame || document.webkitFullscreenElement === playerFrame;
  const btn = $('player-fullscreen');
  if (btn) {
    btn.dataset.fullscreen = String(isFull);
    btn.title = isFull ? t('exit_fullscreen_title') : t('fullscreen_title');
    btn.setAttribute('aria-label', btn.title);
  }
  if (playerFrame) playerFrame.dataset.fullscreen = String(isFull);
}
function toggleFullscreen() {
  if (!playerFrame) return;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (playerFrame.requestFullscreen) playerFrame.requestFullscreen().catch((err) => note(errorText(err)));
    else if (playerFrame.webkitRequestFullscreen) playerFrame.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch((err) => note(errorText(err)));
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}
$('player-fullscreen').onclick = () => safely(toggleFullscreen);
$('source-canvas').onclick = () => { if (!$('play-pause').disabled) $('play-pause').click(); };
$('source-canvas').ondblclick = () => safely(toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenState);
document.addEventListener('webkitfullscreenchange', updateFullscreenState);
async function seek(value) {
  const saved = source(); if (!saved) return;
  const position = Math.max(0, Math.min(saved.duration, Number(value)));
  if (!Number.isFinite(position)) return;
  workspace.setReview(saved.id, { position });
  if (bindings.get(saved.id)?.file) await player.seek(position);
}
function adjacentCandidates(saved, position) {
  const clips = saved.clips.filter((item) => !item.provisional && !item.excluded);
  // Prefer the focused clip when a manual edit overlaps another candidate.
  let index = clips.findIndex((clip) => clip.id === saved.review.selectedClipId && clip.start <= position && position <= clip.end);
  if (index < 0) index = clips.findIndex((clip) => clip.start <= position && position < clip.end);
  if (index >= 0) return { previous: clips[index - 1], next: clips[index + 1] };

  const next = clips.findIndex((clip) => clip.start > position);
  return { previous: next < 0 ? clips.at(-1) : clips[next - 1], next: clips[next] };
}
function stepCandidate(direction) {
  const saved = source(); if (!saved) return;
  const position = playerSync.loadedSourceId === saved.id ? playerState.position : saved.review.position;
  const neighbors = adjacentCandidates(saved, position);
  const clip = direction < 0 ? neighbors.previous : neighbors.next;
  if (clip) return selectRange(clip);
  if (direction < 0) note(t('note_no_earlier_candidate'));
  else note(saved.analysis.status === 'analyzing' ? t('note_tail_analyzing') : t('note_no_later_candidate'));
}
$('prev-candidate').onclick = () => safely(() => stepCandidate(-1));
$('next-candidate').onclick = () => safely(() => stepCandidate(1));
const addManualAtPlayhead = () => safely(() => {
  const saved = source();
  if (!saved) return;
  const start = Math.min(saved.review.position, Math.max(0, saved.duration - 5));
  const id = workspace.addManual(saved.id, { start, end: Math.min(saved.duration, start + 5) });
  selectRange(workspace.getSource(saved.id).clips.find((clip) => clip.id === id), false);
});
if ($('quick-manual')) $('quick-manual').onclick = addManualAtPlayhead;
if ($('toggle-current-clip')) $('toggle-current-clip').onclick = () => safely(() => {
  const saved = source(), clip = selectedClip();
  if (!saved || !clip || clip.provisional || clip.excluded) return;
  workspace.choose(saved.id, clip.id, !clip.selected);
});
function trimBoundary(key, value) {
  const saved = source(), clip = selectedClip();
  if (!clip || clip.provisional) return;
  if (value === '' || !Number.isFinite(Number(value))) throw new Error(t('err_valid_trim_time'));
  workspace.trim(saved.id, clip.id, { start: clip.start, end: clip.end, [key]: Number(value) });
}
for (const key of ['start', 'end']) {
  const quickSet = $(`quick-set-${key}`);
  if (quickSet) quickSet.onclick = () => safely(() => trimBoundary(key, source().review.position));
}
// Register workspace-level keyboard shortcuts BEFORE selectionTimeline so Escape closes
// the narrow library drawer cleanly without simultaneously resetting timeline zoom.
window.addEventListener('keydown', (event) => {
  const layout = resolveClippingLayout({
    page: currentPage,
    itemCount: latestLibrarySnapshot?.items.length ?? 0,
    forceStandaloneLibrary: libraryPreview,
  });
  const hasOpenDialog = Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])'));

  const esc = resolveDrawerEscape({
    event,
    drawerOpen: uxController.drawerOpen,
    layout,
    hasOpenDialog,
  });
  if (esc.handled && esc.shouldClose) {
    event.preventDefault();
    uxController.closeDrawer();
    return;
  }

  const nav = resolveRecordingShortcutTarget({
    event,
    items: latestLibrarySnapshot?.items || [],
    activeSourceId,
    layout,
    hasOpenDialog,
  });
  if (nav.handled) {
    event.preventDefault();
    if (nav.targetId && !event.repeat) {
      safely(() => openReview(nav.targetId));
    }
  }
});

selectionTimeline = createSelectionTimeline({ MB, workspace, getSource: source, getRecord: (id) => bindings.get(id), selectRange, seek, pause: () => player.pause(),
  isActive: () => currentPage === 'clipping' && Boolean(source()) && !playerSync.isLoading,
  playPause: () => { if (!$('play-pause').disabled) $('play-pause').click(); },
  playRange: () => { if (!$('play-selection').disabled) $('play-selection').click(); },
  toggleMute: () => player.toggleMute(),
  toggleFullscreen: () => { if (!$('player-fullscreen').disabled) $('player-fullscreen').click(); },
  isPlayerBusy: () => playerSync.isLoading || ['loading', 'seeking'].includes(playerState.status), report: (error) => note(errorText(error)) });
const fitSelectedClip = () => safely(() => { const clip = selectedClip(); if (clip) selectRange(clip, false); });
if ($('quick-fit-clip')) $('quick-fit-clip').onclick = fitSelectedClip;
$('export-format').onchange = () => { outputSettings = exportSettings({ format: $('export-format').value }); };

if ($('ready-toast-open')) {
  $('ready-toast-open').onclick = () => safely(() => backgroundReadiness.openToastTarget());
}
if ($('ready-toast-dismiss')) {
  $('ready-toast-dismiss').onclick = () => { backgroundReadiness.dismissToast(); };
}
document.addEventListener('visibilitychange', () => {
  safely(() => backgroundReadiness.handleVisibilityChange(document.visibilityState));
});

onLanguageChange(() => {
  readyNotifier.syncTitle();
  render();
});

// Session state is intentionally not written to browser storage.
const shouldWarnOnLeave = () => !preview && !libraryPreview && !workspacePreview && (
  identifyingImports.size > 0 || pendingImports.size > 0 || (engineBridge?.watchDirState.processingCount || 0) > 0 ||
  queue.records.some(record => ['preparing', 'queued', 'analyzing'].includes(record.status)) ||
  view.sources.some(item => item.hasUnexportedChanges) ||
  view.batches.some(batch => ['awaiting-destination', 'queued', 'running'].includes(batch.status))
);
window.addEventListener('beforeunload', event => {
  if (!shouldWarnOnLeave()) return;
  event.preventDefault(); event.returnValue = '';
});
window.addEventListener('pagehide', () => { player.pause(); selectionTimeline?.suspend(); });
const ready = Promise.resolve();
function buildDiagnosticState() {
  const sources = view.sources.map((saved) => {
    const record = bindings.get(saved.id);
    const clips = Array.isArray(saved.clips) ? saved.clips : [];
    const video = record?.video;
    const tracks = Array.isArray(record?.tracks) ? record.tracks : [];
    return {
      status: record?.status || saved.analysis?.status || null,
      phase: record?.phase,
      duration: saved.duration || record?.duration || null,
      processedUntil: record?.processedUntil ?? saved.analysis?.processedUntil ?? null,
      width: video?.displayWidth || video?.codedWidth || null,
      height: video?.displayHeight || video?.codedHeight || null,
      videoCodec: video?.codec || null,
      audioTrackCount: tracks.length || null,
      audioCodecs: tracks.map((track) => track?.codec).filter(Boolean),
      model: record?.model || null,
      candidateCount: clips.filter((clip) => !clip.provisional && !clip.excluded).length,
      selectedCount: clips.filter((clip) => clip.selected && !clip.provisional && !clip.excluded).length,
      timings: record?.timings || null,
      error: record?.error || saved.analysis?.error || null,
    };
  });
  for (const record of [...queue.records, ...identifyingImports]) {
    if (record.sourceId) continue;
    sources.push({
      phase: record.phase,
      status: record.status || null,
      duration: record.duration || null,
      processedUntil: record.processedUntil ?? null,
      model: record.model || null,
      error: record.error || null,
    });
  }
  const batches = view.batches.map((batch) => ({
    status: batch.status || null,
    format: batch.output?.format || null,
    clipCount: Array.isArray(batch.clips) ? batch.clips.length : null,
    savedCount: Array.isArray(batch.outputs) ? batch.outputs.filter((item) => item?.saved).length : 0,
    error: batch.error || null,
  }));
  const bridgeState = engineBridge?.getState?.() || null;
  return {
    page: reportedPage(),
    language: getLang(),
    workspace: {
      sources,
      batches,
      hasOutputDirectory: Boolean(directoryHandle),
      player: {
        status: playerState.status,
        playing: playerState.playing,
        muted: playerState.muted,
      },
    },
    liveMonitor: bridgeState?.liveMonitor || null,
    autoIntake: bridgeState?.watchDirectory || null,
  };
}

let diagnosticsCopiedTimer = null;
function setDiagnosticsCopiedVisual(copied) {
  const btn = $('copy-diagnostics');
  if (!btn) return;
  btn.dataset.copied = String(copied);
  const label = btn.querySelector('.diag-label');
  if (label) label.textContent = copied ? t('diagnostics_copied_btn') : t('diagnostics_btn');
}

async function getDiagnosticsSnapshot() {
  return collectDiagnostics({ env: window, getState: buildDiagnosticState, log: diagnosticLog });
}

function downloadDiagnosticsFallback(json) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `apex-local-cut-diagnostics-${stamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyDiagnostics({ allowDownloadFallback = true } = {}) {
  const btn = $('copy-diagnostics');
  if (btn) btn.disabled = true;
  try {
    const report = await getDiagnosticsSnapshot();
    const json = JSON.stringify(report, null, 2);
    const result = await copyTextToClipboard(json, window);
    if (result.ok) {
      clearTimeout(diagnosticsCopiedTimer);
      setDiagnosticsCopiedVisual(true);
      diagnosticsCopiedTimer = setTimeout(() => setDiagnosticsCopiedVisual(false), 2200);
      note(t('note_diagnostics_copied'), 'info');
      return { ...result, report, json };
    }
    if (allowDownloadFallback) {
      downloadDiagnosticsFallback(json);
      note(t('note_diagnostics_downloaded'), 'info');
      return { ok: true, method: 'download', report, json };
    }
    throw new Error('Clipboard unavailable');
  } catch (error) {
    note(t('note_diagnostics_failed', { err: errorText(error) }), 'error');
    return { ok: false, method: 'failed', error: errorText(error) };
  } finally {
    if (btn) btn.disabled = false;
  }
}

if ($('copy-diagnostics')) {
  $('copy-diagnostics').onclick = () => { void copyDiagnostics(); };
}
$('import-files').disabled = true;
if (libraryPreview) {
  libraryPreviewHarness = mountLibraryPreview({
    onNote: (message, tone) => note(message, tone),
    createEmptyGraphic: createFrameSignal,
  });
}
render();
note(t('status_ready'), 'quiet');
const watchDirRestoreReady = (!preview && !libraryPreview && !workspacePreview)
  ? engineBridge.restorePersistedWatchDirectory().catch(() => null)
  : Promise.resolve(null);

window.reviewApp = {
  workspace,
  queue,
  player,
  exportQueue,
  liveMonitor: engineBridge.liveMonitor,
  autoIntake: engineBridge.autoIntake,
  engineBridge,
  libraryIntakeControls,
  watchDirStore,
  readyNotifier,
  backgroundReadiness,
  watchDirRestoreReady,
  submitExport,
  importFiles,
  openReview,
  showAnalysis,
  render,
  libraryView,
  uxController,
  markRecordingNew: (id, opts) => uxController.markRecordingNew(id, { activeSourceId, ...opts }),
  clearRecordingNew: (id) => uxController.clearRecordingNew(id),
  getNewRecordingIds: () => uxController.getNewRecordingIds(),
  setSidebarCollapsed: (collapsed) => uxController.setSidebarCollapsed(collapsed),
  toggleSidebarCollapsed: () => uxController.toggleSidebarCollapsed(),
  openLibraryDrawer: () => uxController.openDrawer(),
  closeLibraryDrawer: () => uxController.closeDrawer(),
  toggleLibraryDrawer: () => uxController.toggleDrawer(),
  setIntakeHandlers,
  setIntakeState,
  setWatchDirectoryHandle: (handle, opts) => engineBridge.setWatchDirectoryHandle(handle, opts),
  setWatchDirectoryRestoreNeeded: (handle, name) => engineBridge.setWatchDirectoryRestoreNeeded(handle, name),
  getWatchDirectoryHandle: () => engineBridge.getWatchDirectoryHandle(),
  get watchDirState() { return engineBridge.watchDirState; },
  collectDiagnostics: getDiagnosticsSnapshot,
  copyDiagnostics,
  diagnosticLog,
  ready,
  bindings,
  shouldWarnOnLeave,
  get activeSourceId() { return activeSourceId; },
  get sidebarCollapsed() { return uxController.sidebarCollapsed; },
  get drawerOpen() { return uxController.drawerOpen; },
  get page() { return reportedPage(); },
};

if (workspacePreview) {
  void ready.then(async () => {
    workspacePreviewHarness = await mountSplitWorkspacePreview(window.reviewApp, {
      onNote: (message, tone) => note(message, tone),
    });
  }).catch((error) => note(errorText(error), 'error'));
} else if (preview) {
  void ready.then(() => mountReviewPreview(window.reviewApp)).catch((error) => note(errorText(error), 'error'));
}
