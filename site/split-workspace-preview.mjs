// Mock preview harness for the split-pane Local Clipping Workspace (?workspacePreview=...).
// Populates review-workspace with realistic mock recordings across all 4 merged statuses so
// desktop visual & interactive inspection works standalone without importing real media.

import { extractBasename, formatDuration } from './recording-library-projection.mjs';
import { t, onLanguageChange } from './i18n.js';

export const WORKSPACE_PREVIEW_SCENARIOS = Object.freeze({
  mixed: 'workspace_preview_scenario_mixed',
  analyzing: 'workspace_preview_scenario_analyzing',
  coarse: 'workspace_preview_scenario_coarse',
  empty: 'workspace_preview_scenario_empty',
});

export function isWorkspacePreview(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).has('workspacePreview');
}

export function resolveWorkspacePreviewScenario(search = globalThis.location?.search || '') {
  const raw = new URLSearchParams(search).get('workspacePreview') || 'mixed';
  return Object.hasOwn(WORKSPACE_PREVIEW_SCENARIOS, raw) ? raw : 'mixed';
}

function todayAt(hour, minute) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0).getTime();
}

function makeMockWaveform(duration, coveredSeconds, candidates, seedOffset = 0) {
  const step = 0.5;
  const count = Math.max(1, Math.ceil(duration / step));
  const coveredBins = Math.min(count, Math.ceil(Math.max(0, coveredSeconds) / step));
  const peaks = new Array(count).fill(0);
  for (let i = 0; i < coveredBins; i++) {
    const sec = i * step;
    const inCandidate = candidates.some((c) => sec >= c.start && sec <= c.end);
    const wave = Math.abs(Math.sin((i + seedOffset) * 0.37) * 0.45 + Math.cos((i + seedOffset) * 0.13) * 0.3);
    peaks[i] = Number(Math.min(0.98, inCandidate ? 0.55 + wave * 0.43 : 0.08 + wave * 0.24).toFixed(3));
  }
  return {
    version: 1,
    step,
    peaks,
    decodedUntil: Math.min(duration, Math.max(0, coveredSeconds)),
    trackIndex: 0,
  };
}

function buildRecordingsForScenario(scenario) {
  const key = Object.hasOwn(WORKSPACE_PREVIEW_SCENARIOS, scenario) ? scenario : 'mixed';
  if (key === 'empty') {
    return { scenario: key, recordings: [] };
  }

  const all = [
    {
      id: 'ws-preview-ready-exact',
      name: '/Users/player/Videos/Apex Captures/2026-11-26_15-08-12_Olympus_Ranked_Win_1440p60.mkv',
      lastModified: todayAt(15, 8),
      duration: 1122,
      size: 1.8 * 1024 ** 3,
      rawStatus: 'completed',
      queueStatus: 'complete',
      alignment: { confidence: 'exact', offsetMs: -42 },
      processedUntil: 1122,
      candidates: [
        { id: 'ex-1', start: 94, end: 112 },
        { id: 'ex-2', start: 285, end: 309 },
        { id: 'ex-3', start: 468, end: 492 },
        { id: 'ex-4', start: 642, end: 660 },
        { id: 'ex-5', start: 785, end: 808 },
        { id: 'ex-6', start: 912, end: 936 },
        { id: 'ex-7', start: 1044, end: 1068 },
      ],
      savedExports: 2,
      mapLabel: 'Olympus · Ranked Win',
    },
    {
      id: 'ws-preview-coarse',
      name: 'C:\\OBS\\Apex\\2026-11-26_14-36-05_WorldsEdge_Endgame_SquadWipe.mp4',
      lastModified: todayAt(14, 36),
      duration: 855,
      size: 1.3 * 1024 ** 3,
      rawStatus: 'completed',
      queueStatus: 'complete',
      alignment: { confidence: 'coarse', offsetMs: 1200 },
      processedUntil: 855,
      candidates: [
        { id: 'co-1', start: 112, end: 132 },
        { id: 'co-2', start: 304, end: 325 },
        { id: 'co-3', start: 496, end: 518 },
        { id: 'co-4', start: 645, end: 668 },
        { id: 'co-5', start: 770, end: 794 },
      ],
      savedExports: 1,
      isNew: true,
      mapLabel: "World's Edge · Coarse Conform",
    },
    {
      id: 'ws-preview-analyzing',
      name: '2026-11-26_14-05-30_StormPoint_Clutch_Overtime.mkv',
      lastModified: todayAt(14, 5),
      duration: 668,
      size: 960 * 1024 ** 2,
      rawStatus: 'analyzing',
      queueStatus: 'analyzing',
      alignment: null,
      processedUntil: 414,
      candidates: [
        { id: 'an-1', start: 82, end: 99 },
        { id: 'an-2', start: 215, end: 234 },
        { id: 'an-3', start: 356, end: 378 },
      ],
      savedExports: 0,
      mapLabel: 'Storm Point · Analyzing 62%',
    },
    {
      id: 'ws-preview-unanalyzed',
      name: '2026-11-26_13-24-00_BrokenMoon_Warmup_Unanalyzed.mp4',
      lastModified: todayAt(13, 24),
      duration: 564,
      size: 740 * 1024 ** 2,
      rawStatus: 'stopped',
      queueStatus: 'stopped',
      alignment: null,
      processedUntil: 0,
      candidates: [],
      savedExports: 0,
      isNew: true,
      mapLabel: 'Broken Moon · Unanalyzed',
    },
    {
      id: 'ws-preview-ready-offline',
      name: '2026-11-26_12-45-18_EDistrict_Trios_FullOffline.mp4',
      lastModified: todayAt(12, 45),
      duration: 1010,
      size: 1.5 * 1024 ** 3,
      rawStatus: 'completed',
      queueStatus: 'complete',
      alignment: null,
      processedUntil: 1010,
      candidates: [
        { id: 'of-1', start: 120, end: 141 },
        { id: 'of-2', start: 360, end: 382 },
        { id: 'of-3', start: 615, end: 642 },
        { id: 'of-4', start: 840, end: 866 },
      ],
      savedExports: 3,
      mapLabel: 'E-District · Ready',
    },
  ];

  if (key === 'analyzing') {
    return { scenario: key, recordings: [all[2], all[3], all[0]] };
  }
  if (key === 'coarse') {
    return { scenario: key, recordings: [all[1], all[0], all[3]] };
  }
  return { scenario: key, recordings: all };
}

export function createWorkspacePreviewSeeds(scenario = 'mixed') {
  return buildRecordingsForScenario(scenario);
}

export function renderWorkspacePreviewCanvas(source, record, doc = globalThis.document) {
  if (!source || !record?.isPreviewMock || !doc) return false;
  const canvas = doc.getElementById?.('source-canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return false;

  const width = canvas.width || 1280;
  const height = canvas.height || 720;
  ctx.clearRect(0, 0, width, height);

  // Subtle dark slate stage with minimal tactical frame readout (pure preview placeholder)
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#181b20');
  grad.addColorStop(1, '#101216');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 36, width - 72, height - 72);

  const name = extractBasename(source.identity?.name || '');
  const position = formatDuration(source.review?.position || 0);
  const total = formatDuration(source.duration || 0);

  ctx.fillStyle = '#f4f4f5';
  ctx.font = '600 28px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(record.mapLabel || name, width / 2, height / 2 - 22);

  ctx.fillStyle = '#a1a1aa';
  ctx.font = '500 18px Menlo, Monaco, Consolas, monospace';
  ctx.fillText(`${name}  ·  ${position} / ${total}`, width / 2, height / 2 + 22);
  return true;
}

export async function mountSplitWorkspacePreview(app, {
  scenario = resolveWorkspacePreviewScenario(),
  search = globalThis.location?.search || '',
  doc = globalThis.document,
  onNote = () => {},
} = {}) {
  const params = new URLSearchParams(search);
  const seed = createWorkspacePreviewSeeds(scenario);
  const mockRecords = new Map();
  let extraCounter = 0;

  function addPreviewRecording(rec, seedIndex, { markNew = false } = {}) {
    const basename = extractBasename(rec.name);
    const id = app.workspace.addSource({
      id: rec.id,
      name: basename,
      size: rec.size,
      lastModified: rec.lastModified,
      duration: rec.duration,
    });
    if (rec.candidates.length) {
      app.workspace.publishCandidates(id, rec.candidates);
    }
    if (rec.processedUntil > 0) {
      app.workspace.updateWaveform(
        id,
        makeMockWaveform(rec.duration, rec.processedUntil, rec.candidates, seedIndex * 17),
      );
    }
    app.workspace.updateAnalysis(id, {
      status: rec.rawStatus,
      processedUntil: rec.processedUntil,
      error: null,
    });

    if (rec.savedExports > 0 && rec.candidates.length > 0) {
      const batch = app.workspace.submitBatch(id, {
        audio: { trackIndex: 0, policy: 'source-primary' },
        output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
      });
      const outputs = Array.from({ length: rec.savedExports }, (_, idx) => ({
        name: `${basename.replace(/\.[^.]+$/, '')}-clip-${idx + 1}.mp4`,
        saved: true,
        available: true,
        bytes: 4_500_000,
        requestedDuration: 18,
      }));
      app.workspace.updateBatch(batch.id, { status: 'completed', progress: 1, outputs });
    }

    const mockRecord = {
      id: `preview-rec-${rec.id}`,
      sourceId: id,
      file: null,
      origin: 0,
      duration: rec.duration,
      status: rec.queueStatus,
      processedUntil: rec.processedUntil,
      alignment: rec.alignment ? { ...rec.alignment } : null,
      candidates: rec.candidates,
      isPreviewMock: true,
      mapLabel: rec.mapLabel,
    };
    mockRecords.set(id, mockRecord);
    app.bindings.set(id, mockRecord);
    if (markNew) {
      app.markRecordingNew?.(id);
    }
    return id;
  }

  for (let i = 0; i < seed.recordings.length; i++) {
    addPreviewRecording(seed.recordings[i], i, { markNew: false });
  }

  function simulateNewRecording() {
    extraCounter += 1;
    const minute = Math.min(59, 15 + extraCounter * 3);
    const id = addPreviewRecording({
      id: `ws-preview-dropped-${extraCounter}`,
      name: `2026-11-26_15-${String(minute).padStart(2, '0')}-00_KingsCanyon_NewDrop_${extraCounter}.mp4`,
      lastModified: todayAt(15, minute) + extraCounter * 1000,
      duration: 740,
      size: 1.1 * 1024 ** 3,
      rawStatus: 'completed',
      queueStatus: 'complete',
      alignment: { confidence: 'exact', offsetMs: -18 },
      processedUntil: 740,
      candidates: [
        { id: `nd-${extraCounter}-1`, start: 108, end: 129 },
        { id: `nd-${extraCounter}-2`, start: 342, end: 365 },
        { id: `nd-${extraCounter}-3`, start: 590, end: 614 },
      ],
      savedExports: 0,
      mapLabel: `Kings Canyon · New Drop #${extraCounter}`,
    }, seed.recordings.length + extraCounter, { markNew: true });
    app.render?.();
    onNote(`[preview] added new recording without switching: ${extractBasename(app.workspace.getSource(id)?.identity?.name || '')}`, 'info');
    return id;
  }

  function runPreviewAction(sourceId, actionKind) {
    const record = mockRecords.get(sourceId);
    if (!record) return false;
    if (actionKind === 'analyze') {
      const nextProcessed = Math.max(Math.round(record.duration * 0.18), record.processedUntil || 0);
      record.status = 'analyzing';
      record.processedUntil = nextProcessed;
      app.workspace.updateAnalysis(sourceId, { status: 'analyzing', processedUntil: nextProcessed, error: null });
      onNote(`[preview] analyze: ${extractBasename(app.workspace.getSource(sourceId)?.identity?.name || '')}`, 'info');
      return true;
    }
    if (actionKind === 'stop') {
      record.status = 'stopped';
      app.workspace.updateAnalysis(sourceId, { status: 'stopped', processedUntil: record.processedUntil, error: null });
      onNote(`[preview] stop: ${extractBasename(app.workspace.getSource(sourceId)?.identity?.name || '')}`, 'info');
      return true;
    }
    if (actionKind === 'reanalyze') {
      const nextProcessed = Math.round(record.duration * 0.12);
      record.alignment = null;
      record.status = 'analyzing';
      record.processedUntil = nextProcessed;
      app.workspace.updateAnalysis(sourceId, { status: 'analyzing', processedUntil: nextProcessed, error: null });
      onNote(`[preview] reanalyze: ${extractBasename(app.workspace.getSource(sourceId)?.identity?.name || '')}`, 'info');
      return true;
    }
    return false;
  }

  const mockOnboardingState = {
    watchDirectory: { status: 'unset', name: null },
    liveMonitor: { status: 'off' },
  };
  const mockFolders = ['Apex Captures', 'OBS Recordings', 'ShadowPlay Clips'];
  let mockFolderIndex = -1;
  if (typeof app.setOnboardingHandlers === 'function') {
    app.setOnboardingHandlers({
      onChooseWatchDir() {
        mockFolderIndex = (mockFolderIndex + 1) % mockFolders.length;
        mockOnboardingState.watchDirectory = { status: 'watching', name: mockFolders[mockFolderIndex] };
        app.setOnboardingState?.({
          watchDirectory: { ...mockOnboardingState.watchDirectory },
          liveMonitor: { ...mockOnboardingState.liveMonitor },
        });
        onNote(`[preview] watchDirectory -> ${mockOnboardingState.watchDirectory.name}`, 'info');
      },
      onToggleMonitoring() {
        mockOnboardingState.liveMonitor = {
          status: mockOnboardingState.liveMonitor.status === 'listening' ? 'off' : 'listening',
        };
        app.setOnboardingState?.({
          watchDirectory: { ...mockOnboardingState.watchDirectory },
          liveMonitor: { ...mockOnboardingState.liveMonitor },
        });
        onNote(`[preview] liveMonitor -> ${mockOnboardingState.liveMonitor.status}`, 'info');
      },
    });
  }

  const main = doc?.querySelector?.('#main');
  let bar = null;
  let unsubscribeLang = () => {};
  if (main) {
    bar = doc.createElement('section');
    bar.id = 'workspace-preview-banner';
    bar.className = 'panel review-preview-banner workspace-preview-banner';

    const controls = doc.createElement('div');
    controls.className = 'preview-controls';
    const label = doc.createElement('label');
    const labelText = doc.createElement('span');
    const select = doc.createElement('select');
    for (const key of Object.keys(WORKSPACE_PREVIEW_SCENARIOS)) {
      const opt = doc.createElement('option');
      opt.value = key;
      opt.selected = key === seed.scenario;
      select.append(opt);
    }
    select.onchange = () => {
      if (globalThis.location) globalThis.location.search = `?workspacePreview=${select.value}`;
    };
    label.append(labelText, select);

    const simulateNewBtn = doc.createElement('button');
    simulateNewBtn.id = 'workspace-preview-simulate-new';
    simulateNewBtn.type = 'button';
    simulateNewBtn.hidden = seed.recordings.length === 0;
    simulateNewBtn.onclick = () => { simulateNewRecording(); };

    const reset = doc.createElement('button');
    reset.type = 'button';
    reset.onclick = () => { globalThis.location?.reload?.(); };
    controls.append(label, simulateNewBtn, reset);

    const noteText = doc.createElement('p');
    bar.append(controls, noteText);
    main.prepend(bar);

    const renderLabels = () => {
      bar.setAttribute('aria-label', t('workspace_preview_aria'));
      labelText.textContent = t('workspace_preview_label');
      select.setAttribute('aria-label', t('workspace_preview_label'));
      for (const opt of select.options || []) {
        opt.textContent = t(WORKSPACE_PREVIEW_SCENARIOS[opt.value]);
      }
      simulateNewBtn.textContent = t('workspace_preview_add_new');
      reset.textContent = t('library_preview_reset');
      noteText.textContent = t('workspace_preview_note');
    };
    renderLabels();
    unsubscribeLang = onLanguageChange(renderLabels);
    bar.dataset.ready = 'true';
  }

  if (params.get('sidebar') === 'collapsed') {
    app.setSidebarCollapsed?.(true);
  } else if (params.get('sidebar') === 'expanded') {
    app.setSidebarCollapsed?.(false);
  }

  if (seed.recordings.length > 0) {
    await app.openReview(seed.recordings[0].id);
    for (const rec of seed.recordings) {
      if (rec.isNew && rec.id !== app.activeSourceId) {
        app.markRecordingNew?.(rec.id);
      }
    }
    if (params.get('drawer') === 'open') {
      app.openLibraryDrawer?.();
    }
  } else if (typeof app.render === 'function') {
    app.render();
  }

  return {
    scenario: seed.scenario,
    mockRecords,
    runPreviewAction,
    simulateNewRecording,
    renderCanvas: (source, record) => renderWorkspacePreviewCanvas(source, record, doc),
    dispose() {
      unsubscribeLang();
      bar?.remove?.();
    },
  };
}
