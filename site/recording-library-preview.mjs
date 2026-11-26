// Pure mock preview harness for the Recording Library view layer (?libraryPreview=...).
// Zero dependencies on audio capture, folder watching, alignment, or media engines.

import { projectRecordingLibrary } from './recording-library-projection.mjs';
import { createRecordingLibraryView } from './recording-library-view.mjs';
import { t, onLanguageChange } from './i18n.js';

export const LIBRARY_PREVIEW_SCENARIOS = Object.freeze({
  mixed: 'library_preview_scenario_mixed',
  empty: 'library_preview_scenario_empty',
  analyzing: 'library_preview_scenario_analyzing',
  coarse: 'library_preview_scenario_coarse',
  long: 'library_preview_scenario_long',
});

export function isLibraryPreview(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).has('libraryPreview');
}

export function resolveLibraryPreviewScenario(search = globalThis.location?.search || '') {
  const raw = new URLSearchParams(search).get('libraryPreview') || 'mixed';
  return Object.hasOwn(LIBRARY_PREVIEW_SCENARIOS, raw) ? raw : 'mixed';
}

function todayAt(hour, minute) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0).getTime();
}

function buildScenarioSeed(scenario) {
  const key = Object.hasOwn(LIBRARY_PREVIEW_SCENARIOS, scenario) ? scenario : 'mixed';
  if (key === 'empty') {
    return {
      liveMonitor: { status: 'off' },
      watchDirectory: { status: 'unset', name: null },
      items: [],
    };
  }
  if (key === 'analyzing') {
    return {
      liveMonitor: { status: 'paused-loopback' },
      watchDirectory: { status: 'watching', name: 'OBS Recordings' },
      items: [
        {
          id: 'preview-an-1',
          filename: '2026-11-26_15-12-08_Olympus_Ranked.mkv',
          recordedAtMs: todayAt(15, 12),
          durationSeconds: 1180,
          sizeBytes: 1.9 * 1024 ** 3,
          status: 'analyzing',
          progressPercent: 34,
          candidateCount: 2,
          exportedCount: 0,
        },
        {
          id: 'preview-an-2',
          filename: '2026-11-26_14-50-44_WorldsEdge_Trio.mp4',
          recordedAtMs: todayAt(14, 50),
          durationSeconds: 845,
          sizeBytes: 1.2 * 1024 ** 3,
          status: 'analyzing',
          progressPercent: 0,
          candidateCount: 0,
          exportedCount: 0,
        },
        {
          id: 'preview-an-3',
          filename: '2026-11-26_14-15-00_StormPoint_Warmup.mp4',
          recordedAtMs: todayAt(14, 15),
          durationSeconds: 510,
          sizeBytes: 640 * 1024 ** 2,
          status: 'unanalyzed',
          candidateCount: 0,
          exportedCount: 0,
        },
      ],
    };
  }
  if (key === 'coarse') {
    return {
      liveMonitor: { status: 'disconnected' },
      watchDirectory: { status: 'needs-permission', name: 'Apex Clips' },
      items: [
        {
          id: 'preview-co-1',
          filename: '2026-11-26_16-05-19_EDistrict_FinalRing.mkv',
          recordedAtMs: todayAt(16, 5),
          durationSeconds: 1032,
          sizeBytes: 1.6 * 1024 ** 3,
          status: 'conformed-coarse',
          candidateCount: 6,
          exportedCount: 1,
        },
        {
          id: 'preview-co-2',
          filename: '2026-11-26_15-38-02_BrokenMoon_Ranked.mp4',
          recordedAtMs: todayAt(15, 38),
          durationSeconds: 912,
          sizeBytes: 1.4 * 1024 ** 3,
          status: 'conformed-coarse',
          candidateCount: 4,
          exportedCount: 0,
        },
        {
          id: 'preview-co-3',
          filename: '2026-11-26_15-02-11_Olympus_Endgame.mp4',
          recordedAtMs: todayAt(15, 2),
          durationSeconds: 1240,
          sizeBytes: 2.1 * 1024 ** 3,
          status: 'ready',
          candidateCount: 11,
          exportedCount: 3,
        },
      ],
    };
  }
  if (key === 'long') {
    return {
      liveMonitor: { status: 'listening' },
      watchDirectory: { status: 'watching', name: '/Volumes/ExternalNVMe/Captures/Apex_Season23_HighBitrate_Recordings/' },
      items: [
        {
          id: 'preview-lg-1',
          filename: 'C:\\Users\\Streamer\\Videos\\Apex Legends\\Apex_Legends_2026-11-26_16-42-19_Ranked_Olympus_Final_Squad_Wipe_1440p60_HEVC.mkv',
          recordedAtMs: todayAt(16, 42),
          durationSeconds: 4125,
          sizeBytes: 6.4 * 1024 ** 3,
          status: 'conformed-exact',
          candidateCount: 24,
          exportedCount: 8,
        },
        {
          id: 'preview-lg-2',
          filename: '/Users/player/Movies/OBS/Apex_Season23_WorldsEdge_VeryLongRecordingFileNameWithoutSpaces_20261126_1510.mp4',
          recordedAtMs: todayAt(15, 10),
          durationSeconds: 2210,
          sizeBytes: 3.1 * 1024 ** 3,
          status: 'conformed-coarse',
          candidateCount: 13,
          exportedCount: 2,
        },
        {
          id: 'preview-lg-3',
          filename: 'Apex_StormPoint_2026-11-26_14-18-09_Uninterrupted_Long_Session_Part2.mkv',
          recordedAtMs: todayAt(14, 18),
          durationSeconds: 1625,
          sizeBytes: 2.2 * 1024 ** 3,
          status: 'analyzing',
          progressPercent: 78,
          candidateCount: 5,
          exportedCount: 0,
        },
      ],
    };
  }
  // 'mixed': showcases all 4 merged statuses (both exact-conform and offline-complete merge into 'ready')
  return {
    liveMonitor: { status: 'listening' },
    watchDirectory: { status: 'watching', name: '/Users/player/Videos/Apex Captures/' },
    items: [
      {
        id: 'preview-mx-exact',
        filename: '/Users/player/Videos/Apex Captures/2026-11-26_14-48-12_Olympus_Win.mkv',
        recordedAtMs: todayAt(14, 48),
        durationSeconds: 1122,
        sizeBytes: 1.8 * 1024 ** 3,
        status: 'conformed-exact',
        candidateCount: 7,
        exportedCount: 2,
      },
      {
        id: 'preview-mx-coarse',
        filename: 'C:\\OBS\\Apex\\2026-11-26_14-22-05_WorldsEdge_Ranked.mp4',
        recordedAtMs: todayAt(14, 22),
        durationSeconds: 855,
        sizeBytes: 1.3 * 1024 ** 3,
        status: 'conformed-coarse',
        candidateCount: 5,
        exportedCount: 0,
      },
      {
        id: 'preview-mx-analyzing',
        filename: '2026-11-26_13-55-30_StormPoint_Clutch.mkv',
        recordedAtMs: todayAt(13, 55),
        durationSeconds: 668,
        sizeBytes: 960 * 1024 ** 2,
        status: 'analyzing',
        progressPercent: 62,
        candidateCount: 3,
        exportedCount: 0,
      },
      {
        id: 'preview-mx-unanalyzed',
        filename: '2026-11-26_13-18-00_BrokenMoon_Warmup.mp4',
        recordedAtMs: todayAt(13, 18),
        durationSeconds: 564,
        sizeBytes: 740 * 1024 ** 2,
        status: 'unanalyzed',
        candidateCount: 0,
        exportedCount: 0,
      },
      {
        id: 'preview-mx-offline',
        filename: '2026-11-26_12-40-15_EDistrict_Squad.mp4',
        recordedAtMs: todayAt(12, 40),
        durationSeconds: 1010,
        sizeBytes: 1.5 * 1024 ** 3,
        status: 'completed',
        candidateCount: 9,
        exportedCount: 4,
      },
    ],
  };
}

export function createLibraryPreviewSnapshot(scenario = 'mixed') {
  const seed = buildScenarioSeed(scenario);
  return projectRecordingLibrary({
    items: seed.items,
    liveMonitor: seed.liveMonitor,
    watchDirectory: seed.watchDirectory,
    sortOrder: 'newest-first',
  });
}

export function mountLibraryPreview({
  scenario = resolveLibraryPreviewScenario(),
  doc = globalThis.document,
  onNote = () => {},
  createEmptyGraphic = null,
} = {}) {
  const seed = buildScenarioSeed(scenario);
  const state = {
    liveMonitor: { ...seed.liveMonitor },
    watchDirectory: { ...seed.watchDirectory },
    items: seed.items.map((item) => ({ ...item })),
    activeSourceId: null,
  };
  const mockFolders = ['Apex Captures', 'OBS Recordings', 'ShadowPlay Clips'];
  let folderIdx = Math.max(0, mockFolders.indexOf(state.watchDirectory.name));

  const main = doc.querySelector('#main');
  const bar = doc.createElement('section');
  bar.className = 'panel review-preview-banner library-preview-banner';

  const controls = doc.createElement('div');
  controls.className = 'preview-controls';
  const label = doc.createElement('label');
  const labelText = doc.createElement('span');
  const select = doc.createElement('select');
  for (const key of Object.keys(LIBRARY_PREVIEW_SCENARIOS)) {
    const opt = doc.createElement('option');
    opt.value = key;
    opt.selected = key === scenario;
    select.append(opt);
  }
  select.onchange = () => {
    if (globalThis.location) globalThis.location.search = `?libraryPreview=${select.value}`;
  };
  label.append(labelText, select);
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.onclick = () => { globalThis.location?.reload?.(); };
  controls.append(label, reset);
  const noteText = doc.createElement('p');
  bar.append(controls, noteText);
  if (main) main.prepend(bar);

  function renderBannerLabels() {
    bar.setAttribute('aria-label', t('library_preview_aria'));
    labelText.textContent = t('library_preview_label');
    select.setAttribute('aria-label', t('library_preview_label'));
    for (const opt of select.options || []) {
      opt.textContent = t(LIBRARY_PREVIEW_SCENARIOS[opt.value]);
    }
    reset.textContent = t('library_preview_reset');
    noteText.textContent = t('library_preview_note');
  }

  let view;
  const rerender = () => {
    renderBannerLabels();
    const snapshot = projectRecordingLibrary({
      items: state.items,
      liveMonitor: state.liveMonitor,
      watchDirectory: state.watchDirectory,
      activeSourceId: state.activeSourceId,
      sortOrder: 'newest-first',
    });
    view.render(snapshot);
    return snapshot;
  };

  view = createRecordingLibraryView({
    listContainer: doc.getElementById('queue'),
    topbarContainer: doc.getElementById('library-topbar-slots'),
    countNode: doc.getElementById('queue-count'),
    summaryNode: doc.getElementById('queue-summary'),
    pageNode: doc.getElementById('analysis-page'),
    doc,
    createEmptyGraphic,
    onReview: (id, item) => {
      state.activeSourceId = id;
      rerender();
      onNote(`[preview] review: ${item.filename}`, 'info');
    },
    onSelect: (id, item) => {
      state.activeSourceId = id;
      rerender();
      onNote(`[preview] select: ${item.filename}`, 'info');
    },
    onReanalyze: (id, item) => {
      const target = state.items.find((entry) => entry.id === id);
      if (target) {
        target.status = 'analyzing';
        target.progressPercent = 12;
      }
      rerender();
      onNote(`[preview] reanalyze: ${item.filename}`, 'info');
    },
    onAnalyze: (id, item) => {
      const target = state.items.find((entry) => entry.id === id);
      if (target) {
        target.status = 'analyzing';
        target.progressPercent = 15;
      }
      rerender();
      onNote(`[preview] analyze: ${item.filename}`, 'info');
    },
    onStop: (id, item) => {
      const target = state.items.find((entry) => entry.id === id);
      if (target) {
        target.status = 'unanalyzed';
        target.progressPercent = 0;
      }
      rerender();
      onNote(`[preview] stop: ${item.filename}`, 'info');
    },
    onToggleLiveMonitor: () => {
      state.liveMonitor.status = state.liveMonitor.status === 'listening' ? 'off' : 'listening';
      rerender();
      onNote(`[preview] liveMonitor -> ${state.liveMonitor.status}`, 'info');
    },
    onChooseWatchDirectory: () => {
      if (state.watchDirectory.status === 'needs-permission') {
        state.watchDirectory.status = 'watching';
      } else {
        folderIdx = (folderIdx + 1) % mockFolders.length;
        state.watchDirectory = { status: 'watching', name: mockFolders[folderIdx] };
      }
      rerender();
      onNote(`[preview] watchDirectory -> ${state.watchDirectory.name}`, 'info');
    },
  });

  rerender();
  const unsubscribeLang = onLanguageChange(rerender);
  bar.dataset.ready = 'true';

  return {
    view,
    rerender,
    getSnapshot: () => projectRecordingLibrary({
      items: state.items,
      liveMonitor: state.liveMonitor,
      watchDirectory: state.watchDirectory,
      activeSourceId: state.activeSourceId,
      sortOrder: 'newest-first',
    }),
    dispose() {
      unsubscribeLang();
      view.dispose();
      bar.remove();
    },
  };
}
