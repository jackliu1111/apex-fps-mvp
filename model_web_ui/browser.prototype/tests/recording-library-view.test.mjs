import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  LIBRARY_STATUSES,
  extractBasename,
  formatClockTime,
  formatDuration,
  formatFileSize,
  projectRecordingStatus,
  projectRecordingLibrary,
} from '../../../site/recording-library-projection.mjs';
import { createRecordingLibraryView } from '../../../site/recording-library-view.mjs';
import {
  LIBRARY_PREVIEW_SCENARIOS,
  isLibraryPreview,
  resolveLibraryPreviewScenario,
  createLibraryPreviewSnapshot,
  mountLibraryPreview,
} from '../../../site/recording-library-preview.mjs';
import { translations, setLang } from '../../../site/i18n.js';

test('merged 4-status model maps offline complete and exact conform both to ready, and coarse to conformed-coarse', () => {
  assert.deepEqual(LIBRARY_STATUSES, ['unanalyzed', 'analyzing', 'ready', 'conformed-coarse']);

  // Both offline complete and exact conform MUST merge into 'ready' (no 5th badge)
  assert.equal(projectRecordingStatus('complete', null), 'ready');
  assert.equal(projectRecordingStatus('completed', null), 'ready');
  assert.equal(projectRecordingStatus('ready', null), 'ready');
  assert.equal(projectRecordingStatus('complete', { confidence: 'exact', correlation: 0.92, offsetMs: 140 }), 'ready');
  assert.equal(projectRecordingStatus('conformed-exact', { confidence: 'exact' }), 'ready');

  // Coarse conform stays 'conformed-coarse' unless actively re-analyzing
  assert.equal(projectRecordingStatus('complete', { confidence: 'coarse', correlation: 0.22, offsetMs: 0 }), 'conformed-coarse');
  assert.equal(projectRecordingStatus('conformed-coarse', null), 'conformed-coarse');
  assert.equal(projectRecordingStatus('analyzing', { confidence: 'coarse' }), 'analyzing');

  // Active states -> analyzing
  assert.equal(projectRecordingStatus('preparing', null), 'analyzing');
  assert.equal(projectRecordingStatus('queued', null), 'analyzing');
  assert.equal(projectRecordingStatus('analyzing', null), 'analyzing');

  // Idle / unanalyzed / stopped / failed -> unanalyzed
  assert.equal(projectRecordingStatus('unanalyzed', null), 'unanalyzed');
  assert.equal(projectRecordingStatus('idle', null), 'unanalyzed');
  assert.equal(projectRecordingStatus('stopped', null), 'unanalyzed');
  assert.equal(projectRecordingStatus('failed', null), 'unanalyzed');
});

test('extractBasename strips Unix and Windows directory paths cleanly', () => {
  assert.equal(extractBasename('/Users/player/Videos/Apex/2026-11-26_14-20.mkv'), '2026-11-26_14-20.mkv');
  assert.equal(extractBasename('C:\\Users\\Player\\Videos\\OBS\\match_01.mp4'), 'match_01.mp4');
  assert.equal(extractBasename('/Volumes/SSD/Apex Captures/'), 'Apex Captures');
  assert.equal(extractBasename('D:\\Recordings\\Apex\\'), 'Apex');
  assert.equal(extractBasename('plain_clip.webm'), 'plain_clip.webm');
  assert.equal(extractBasename(''), '');
  assert.equal(extractBasename(null), '');
});

test('identity formatters render HH:MM clock time, compact duration, and human file size', () => {
  const stamp = new Date(2026, 10, 26, 14, 20, 45).getTime();
  assert.equal(formatClockTime(stamp), '14:20');
  assert.equal(formatClockTime(new Date(2026, 10, 26, 9, 5, 0).getTime()), '09:05');
  assert.equal(formatClockTime(null), '');

  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(872), '14:32');
  assert.equal(formatDuration(3912), '1:05:12');
  assert.equal(formatDuration(null), '');

  assert.equal(formatFileSize(1.8 * 1024 ** 3), '1.8 GB');
  assert.equal(formatFileSize(480 * 1024 ** 2), '480 MB');
  assert.equal(formatFileSize(12.5 * 1024 ** 2), '12.5 MB');
  assert.equal(formatFileSize(820 * 1024), '820 KB');
  assert.equal(formatFileSize(null), '');
});

test('projectRecordingLibrary projects workspace sources, runtime records, saved-only exports, topbar slots, and strips forbidden fields', () => {
  const t1 = new Date(2026, 10, 26, 13, 10).getTime();
  const t2 = new Date(2026, 10, 26, 14, 20).getTime();
  const t3 = new Date(2026, 10, 26, 14, 45).getTime();
  const t4 = new Date(2026, 10, 26, 15, 5).getTime();

  const sources = [
    {
      id: 'src-offline-ready',
      identity: { name: 'C:\\OBS\\Apex\\match-offline.mp4', size: 1.5 * 1024 ** 3, lastModified: t1 },
      duration: 900,
      analysis: { status: 'completed', processedUntil: 900, error: null },
      clips: [
        { id: 'c1', provisional: false, excluded: false },
        { id: 'c2', provisional: false, excluded: true },
        { id: 'c3', provisional: true, excluded: false },
        { id: 'c4', provisional: false, excluded: false },
      ],
      waveform: { peaks: [0.1, 0.2] },
    },
    {
      id: 'src-exact-conform',
      identity: { name: '/Users/alice/Videos/Apex/match-exact.mkv', size: 1.9 * 1024 ** 3, lastModified: t4 },
      duration: 1122,
      analysis: { status: 'completed', processedUntil: 1122, error: null },
      clips: [{ id: 'e1', provisional: false, excluded: false }],
    },
    {
      id: 'src-coarse-conform',
      identity: { name: 'match-coarse.mkv', size: 840 * 1024 ** 2, lastModified: t3 },
      duration: 640,
      analysis: { status: 'completed', processedUntil: 640, error: null },
      clips: [
        { id: 'x1', provisional: false, excluded: false },
        { id: 'x2', provisional: false, excluded: false },
      ],
    },
    {
      id: 'src-analyzing',
      identity: { name: 'match-analyzing.mp4', size: 512 * 1024 ** 2, lastModified: t2 },
      duration: 600,
      analysis: { status: 'analyzing', processedUntil: 270, error: null },
      clips: [{ id: 'a1', provisional: false, excluded: false }],
    },
  ];

  const records = [
    {
      id: 'rec-exact',
      sourceId: 'src-exact-conform',
      status: 'complete',
      duration: 1122,
      processedUntil: 1122,
      alignment: { confidence: 'exact', correlation: 0.94, offsetMs: -125, driftPpm: 12 },
      file: { name: '/Users/alice/Videos/Apex/match-exact.mkv', size: 1.9 * 1024 ** 3, lastModified: t4 },
    },
    {
      id: 'rec-coarse',
      sourceId: 'src-coarse-conform',
      status: 'complete',
      duration: 640,
      processedUntil: 640,
      alignment: { confidence: 'coarse', correlation: 0.18, offsetMs: 3200, driftPpm: 0 },
      file: { name: 'match-coarse.mkv', size: 840 * 1024 ** 2, lastModified: t3 },
    },
    {
      id: 'rec-analyzing',
      sourceId: 'src-analyzing',
      status: 'analyzing',
      duration: 600,
      processedUntil: 270,
      file: { name: 'match-analyzing.mp4', size: 512 * 1024 ** 2, lastModified: t2 },
    },
    {
      id: 'rec-unanalyzed-only',
      sourceId: null,
      status: 'unanalyzed',
      duration: 420,
      processedUntil: 0,
      file: { name: '/Users/alice/Videos/Apex/match-unanalyzed.mp4', size: 320 * 1024 ** 2, lastModified: t1 - 60_000 },
    },
  ];

  const batches = [
    {
      id: 'batch-1',
      sourceId: 'src-exact-conform',
      outputs: [
        { name: 'clip-1.mp4', saved: true, destination: { name: 'Exports/Apex' } },
        { name: 'clip-2.mp4', saved: false },
        { name: 'clip-3.mp4', saved: true },
        { name: 'clip-4.mp4' },
      ],
    },
    {
      id: 'batch-2',
      sourceId: 'src-exact-conform',
      outputs: [{ name: 'clip-5.mp4', saved: true }],
    },
    {
      id: 'batch-3',
      sourceId: 'src-offline-ready',
      outputs: [{ name: 'unsaved.mp4', saved: false }],
    },
  ];

  const snapshot = projectRecordingLibrary({
    sources,
    records,
    batches,
    activeSourceId: 'src-coarse-conform',
    newIds: new Set(['src-exact-conform']),
    liveMonitor: { status: 'listening' },
    watchDirectory: { status: 'watching', name: '/Users/alice/Videos/Apex Captures/' },
  });

  // Newest-first ordering by recordedAtMs
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    ['src-exact-conform', 'src-coarse-conform', 'src-analyzing', 'src-offline-ready', 'runtime:rec-unanalyzed-only'],
  );

  // Exact conform merges into 'ready' with basename-only filename and saved-only export count (3, not 5)
  const exact = snapshot.items[0];
  assert.equal(exact.filename, 'match-exact.mkv');
  assert.equal(exact.recordedTimeText, '15:05');
  assert.equal(exact.durationText, '18:42');
  assert.equal(exact.sizeText, '1.9 GB');
  assert.equal(exact.status, 'ready');
  assert.equal(exact.candidateCount, 1);
  assert.equal(exact.exportedCount, 3);
  assert.equal(exact.primaryAction, 'review');
  assert.equal(exact.secondaryAction, null);
  assert.equal(exact.isNew, true);
  assert.equal(exact.selected, false);

  // Coarse conform has review + reanalyze and selected flag
  const coarse = snapshot.items[1];
  assert.equal(coarse.status, 'conformed-coarse');
  assert.equal(coarse.primaryAction, 'review');
  assert.equal(coarse.secondaryAction, 'reanalyze');
  assert.equal(coarse.selected, true);

  // Analyzing computes integer progress percentage and stop primary action
  const analyzing = snapshot.items[2];
  assert.equal(analyzing.status, 'analyzing');
  assert.equal(analyzing.progressPercent, 45);
  assert.equal(analyzing.primaryAction, 'stop');
  assert.equal(analyzing.secondaryAction, null);
  assert.equal(analyzing.canReview, true);

  // Offline complete also merges into 'ready' with 0 saved exports (unsaved output ignored) and non-provisional/non-excluded candidates (2)
  const offline = snapshot.items[3];
  assert.equal(offline.filename, 'match-offline.mp4');
  assert.equal(offline.status, 'ready');
  assert.equal(offline.candidateCount, 2);
  assert.equal(offline.exportedCount, 0);
  assert.equal(offline.primaryAction, 'review');

  // Unanalyzed runtime item has analyze primary action
  const unanalyzed = snapshot.items[4];
  assert.equal(unanalyzed.filename, 'match-unanalyzed.mp4');
  assert.equal(unanalyzed.status, 'unanalyzed');
  assert.equal(unanalyzed.primaryAction, 'analyze');
  assert.equal(unanalyzed.secondaryAction, null);

  // Zero forbidden technical/path/waveform properties leaked onto projected items
  for (const item of snapshot.items) {
    assert.equal('alignment' in item, false);
    assert.equal('correlation' in item, false);
    assert.equal('offsetMs' in item, false);
    assert.equal('waveform' in item, false);
    assert.equal('path' in item, false);
    assert.equal('directory' in item, false);
    assert.equal(item.filename.includes('/'), false);
    assert.equal(item.filename.includes('\\'), false);
  }

  // Counts summary
  assert.deepEqual(snapshot.counts, {
    total: 5,
    ready: 2,
    coarse: 1,
    analyzing: 1,
    unanalyzed: 1,
  });

  // Topbar slots: watch directory stripped to basename ONLY
  assert.deepEqual(snapshot.liveMonitor, {
    status: 'listening',
    active: true,
    canToggle: true,
  });
  assert.deepEqual(snapshot.watchDirectory, {
    status: 'watching',
    name: 'Apex Captures',
    canChoose: true,
  });
});

// Lightweight fake DOM for pure unit testing without jsdom.
function createFakeDocument() {
  function makeElement(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      hidden: false,
      disabled: false,
      dataset: {},
      attributes: {},
      children: [],
      parentNode: null,
      listeners: new Map(),
      onclick: null,
      classList: {
        _set: new Set(),
        add(...names) { for (const n of names) if (n) this._set.add(n); el.className = [...this._set].join(' '); },
        remove(...names) { for (const n of names) this._set.delete(n); el.className = [...this._set].join(' '); },
        toggle(name, force) {
          const on = force === undefined ? !this._set.has(name) : Boolean(force);
          if (on) this._set.add(name); else this._set.delete(name);
          el.className = [...this._set].join(' ');
          return on;
        },
        contains(name) { return this._set.has(name); },
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'class') {
          this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
          this.className = String(value);
        }
      },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      removeAttribute(name) { delete this.attributes[name]; },
      append(...nodes) {
        for (const node of nodes) {
          if (!node) continue;
          if (node.parentNode) node.remove();
          node.parentNode = this;
          this.children.push(node);
        }
      },
      replaceChildren(...nodes) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this.append(...nodes);
      },
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      },
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      click() {
        if (this.disabled) return;
        let stopped = false;
        const event = {
          target: this,
          currentTarget: this,
          stopPropagation() { stopped = true; },
          preventDefault() {},
        };
        let node = this;
        while (node && !stopped) {
          event.currentTarget = node;
          if (typeof node.onclick === 'function') node.onclick(event);
          for (const fn of node.listeners.get('click') || []) fn(event);
          node = node.parentNode;
        }
      },
      querySelectorAll(selector) {
        const matches = [];
        const matchOne = (node) => {
          if (selector.startsWith('.')) {
            return node.className.split(/\s+/).includes(selector.slice(1));
          }
          const attrMatch = selector.match(/^\[([^=\]]+)="([^"]+)"\]$/);
          if (attrMatch) {
            const [, attr, val] = attrMatch;
            if (attr.startsWith('data-')) {
              const key = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
              return node.dataset[key] === val || node.attributes[attr] === val;
            }
            return node.attributes[attr] === val;
          }
          return node.tagName.toLowerCase() === selector.toLowerCase();
        };
        const walk = (root) => {
          for (const child of root.children) {
            if (matchOne(child)) matches.push(child);
            walk(child);
          }
        };
        walk(this);
        return matches;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      get innerText() {
        if (!this.children.length) return this.textContent;
        return [this.textContent, ...this.children.filter((c) => !c.hidden).map((c) => c.innerText)].filter(Boolean).join(' ');
      },
    };
    let rawClassName = '';
    Object.defineProperty(el, 'className', {
      get() { return rawClassName; },
      set(val) {
        rawClassName = String(val || '');
        el.classList._set = new Set(rawClassName.split(/\s+/).filter(Boolean));
      },
    });
    el.ownerDocument = doc;
    return el;
  }
  const doc = { createElement: makeElement };
  return doc;
}

test('createRecordingLibraryView renders all 4 merged statuses, minimal 4-block rows, topbar slots, and invokes callbacks without engine dependencies', () => {
  const doc = createFakeDocument();
  const listContainer = doc.createElement('div');
  const topbarContainer = doc.createElement('div');
  const countNode = doc.createElement('span');
  const summaryNode = doc.createElement('span');
  const pageNode = doc.createElement('div');

  const events = [];
  const makeTranslate = (lang) => (key, params = {}) => {
    let text = translations[lang]?.[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
  };

  let lang = 'zh';
  const view = createRecordingLibraryView({
    listContainer,
    topbarContainer,
    countNode,
    summaryNode,
    pageNode,
    doc,
    translate: (key, params) => makeTranslate(lang)(key, params),
    onReview: (id) => events.push(['review', id]),
    onReanalyze: (id) => events.push(['reanalyze', id]),
    onAnalyze: (id) => events.push(['analyze', id]),
    onStop: (id) => events.push(['stop', id]),
    onSelect: (id) => events.push(['select', id]),
    onToggleLiveMonitor: () => events.push(['toggle-live']),
    onChooseWatchDirectory: () => events.push(['choose-dir']),
  });

  const snapshot = projectRecordingLibrary({
    items: [
      {
        id: 'id-ready',
        filename: '/Users/demo/Apex/olympus_win.mkv',
        recordedAtMs: new Date(2026, 10, 26, 14, 48).getTime(),
        durationSeconds: 1122,
        sizeBytes: 1.8 * 1024 ** 3,
        status: 'conformed-exact',
        candidateCount: 7,
        exportedCount: 2,
      },
      {
        id: 'id-coarse',
        filename: 'C:\\OBS\\worlds_edge.mp4',
        recordedAtMs: new Date(2026, 10, 26, 14, 20).getTime(),
        durationSeconds: 855,
        sizeBytes: 1.3 * 1024 ** 3,
        status: 'conformed-coarse',
        candidateCount: 5,
        exportedCount: 0,
      },
      {
        id: 'id-analyzing',
        filename: 'storm_point.mkv',
        recordedAtMs: new Date(2026, 10, 26, 13, 55).getTime(),
        durationSeconds: 668,
        sizeBytes: 960 * 1024 ** 2,
        status: 'analyzing',
        progressPercent: 62,
        candidateCount: 3,
        exportedCount: 0,
      },
      {
        id: 'id-unanalyzed',
        filename: 'broken_moon.mp4',
        recordedAtMs: new Date(2026, 10, 26, 13, 18).getTime(),
        durationSeconds: 564,
        sizeBytes: 740 * 1024 ** 2,
        status: 'unanalyzed',
        candidateCount: 0,
        exportedCount: 0,
      },
    ],
    liveMonitor: { status: 'listening' },
    watchDirectory: { status: 'watching', name: '/Users/demo/Videos/Apex Captures/' },
  });

  view.render(snapshot);

  assert.equal(pageNode.classList.contains('has-recordings'), true);
  assert.equal(countNode.textContent, '4 份录像');
  assert.equal(countNode.dataset.i18nCount, '4');

  // Topbar shows basename-only watch directory & live monitor controls
  const liveSlot = topbarContainer.querySelector('[data-slot="live-monitor"]');
  const watchSlot = topbarContainer.querySelector('[data-slot="watch-directory"]');
  assert.ok(liveSlot);
  assert.ok(watchSlot);
  assert.match(liveSlot.innerText, /实时音频分析/);
  assert.match(liveSlot.innerText, /分析中/);
  assert.match(watchSlot.innerText, /Apex Captures/);
  assert.equal(watchSlot.innerText.includes('/Users/demo'), false);

  topbarContainer.querySelector('[data-action="toggle-live-monitor"]').click();
  topbarContainer.querySelector('[data-action="choose-watch-directory"]').click();
  assert.deepEqual(events.slice(0, 2), [['toggle-live'], ['choose-dir']]);

  // 4 rows rendered in newest-first order, each with minimal 4 blocks
  const rows = listContainer.querySelectorAll('.file');
  assert.equal(rows.length, 4);

  const [readyRow, coarseRow, analyzingRow, unanalyzedRow] = rows;

  // 1. Ready (merged from exact conform)
  assert.equal(readyRow.dataset.status, 'ready');
  assert.equal(readyRow.querySelector('.library-filename').textContent, 'olympus_win.mkv');
  assert.equal(readyRow.querySelector('.library-meta').textContent, '14:48 · 18:42 · 1.8 GB');
  assert.equal(readyRow.querySelector('.library-status-badge').textContent, '已就绪');
  assert.equal(readyRow.querySelector('.library-summary-text').textContent, '7 处候选 · 已导出 2');
  assert.equal(readyRow.querySelectorAll('button').filter((b) => !b.hidden).length, 1);
  assert.equal(readyRow.querySelector('[data-action="review"]').textContent, '复核');
  assert.equal(readyRow.innerText.includes('Apex Captures'), false);
  assert.equal(readyRow.innerText.includes('/Users/demo'), false);
  assert.equal(readyRow.querySelectorAll('progress').length, 0);
  assert.equal(readyRow.querySelectorAll('canvas').length, 0);

  // 2. Coarse conform: single status badge + review primary + reanalyze secondary
  assert.equal(coarseRow.dataset.status, 'conformed-coarse');
  assert.equal(coarseRow.querySelector('.library-filename').textContent, 'worlds_edge.mp4');
  assert.equal(coarseRow.querySelector('.library-status-badge').textContent, '已就绪 ⚠ 粗略');
  assert.equal(coarseRow.querySelector('.library-summary-text').textContent, '5 处候选');
  assert.equal(coarseRow.querySelectorAll('button').filter((b) => !b.hidden).length, 2);
  assert.equal(coarseRow.querySelector('[data-action="review"]').textContent, '复核');
  assert.equal(coarseRow.querySelector('[data-action="reanalyze"]').textContent, '重分析');

  // 3. Analyzing: percentage badge + single stop action
  assert.equal(analyzingRow.dataset.status, 'analyzing');
  assert.equal(analyzingRow.querySelector('.library-status-badge').textContent, '分析中 62%');
  assert.equal(analyzingRow.querySelectorAll('button').filter((b) => !b.hidden).length, 1);
  assert.equal(analyzingRow.querySelector('[data-action="stop"]').textContent, '停止');

  // 4. Unanalyzed: badge + single start analysis action
  assert.equal(unanalyzedRow.dataset.status, 'unanalyzed');
  assert.equal(unanalyzedRow.querySelector('.library-status-badge').textContent, '未分析');
  assert.equal(unanalyzedRow.querySelectorAll('button').filter((b) => !b.hidden).length, 1);
  assert.equal(unanalyzedRow.querySelector('[data-action="analyze"]').textContent, '开始分析');

  // Row action callbacks dispatch without triggering row select
  events.length = 0;
  readyRow.querySelector('[data-action="review"]').click();
  coarseRow.querySelector('[data-action="reanalyze"]').click();
  analyzingRow.querySelector('[data-action="stop"]').click();
  unanalyzedRow.querySelector('[data-action="analyze"]').click();
  analyzingRow.querySelector('.library-row-identity').click();
  assert.deepEqual(events, [
    ['review', 'id-ready'],
    ['reanalyze', 'id-coarse'],
    ['stop', 'id-analyzing'],
    ['analyze', 'id-unanalyzed'],
    ['select', 'id-analyzing'],
  ]);

  // Switch to English and re-render: updates badges & buttons cleanly
  lang = 'en';
  view.render(snapshot);
  assert.equal(readyRow.querySelector('.library-status-badge').textContent, 'Ready');
  assert.equal(coarseRow.querySelector('.library-status-badge').textContent, 'Ready ⚠ Coarse');
  assert.equal(analyzingRow.querySelector('.library-status-badge').textContent, 'Analyzing 62%');
  assert.equal(unanalyzedRow.querySelector('.library-status-badge').textContent, 'Unanalyzed');
  assert.equal(readyRow.querySelector('.library-summary-text').textContent, '7 candidates · 2 exported');
  assert.equal(readyRow.querySelector('[data-action="review"]').textContent, 'Review');
  assert.equal(coarseRow.querySelector('[data-action="reanalyze"]').textContent, 'Re-analyze');
  assert.equal(analyzingRow.querySelector('[data-action="stop"]').textContent, 'Stop');
  assert.equal(unanalyzedRow.querySelector('[data-action="analyze"]').textContent, 'Start Analysis');

  // Empty state renders cleanly and removes stale rows
  const emptySnapshot = projectRecordingLibrary({ items: [] });
  view.render(emptySnapshot);
  assert.equal(pageNode.classList.contains('has-recordings'), false);
  assert.equal(listContainer.querySelectorAll('.file').length, 0);
  assert.ok(listContainer.querySelector('.empty'));
  assert.equal(countNode.textContent, '0 recordings');
});

test('compact sidebar options (showActions: false, showSize: false) reuse the exact same view cleanly for #64', () => {
  const doc = createFakeDocument();
  const listContainer = doc.createElement('div');
  const selectedIds = [];
  const view = createRecordingLibraryView({
    listContainer,
    doc,
    showActions: false,
    showSize: false,
    translate: (key, params = {}) => {
      let text = translations.zh[key] || key;
      for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    },
    onSelect: (id) => selectedIds.push(id),
  });

  const snapshot = projectRecordingLibrary({
    items: [
      {
        id: 'sidebar-1',
        filename: 'match-latest.mkv',
        recordedAtMs: new Date(2026, 10, 26, 15, 10).getTime(),
        durationSeconds: 720,
        sizeBytes: 1.2 * 1024 ** 3,
        status: 'ready',
        candidateCount: 4,
        exportedCount: 1,
        selected: true,
        isNew: true,
      },
    ],
  });

  view.render(snapshot);
  const row = listContainer.querySelector('.file');
  assert.ok(row);
  assert.equal(row.dataset.selected, 'true');
  assert.equal(row.querySelector('.library-meta').textContent, '15:10 · 12:00');
  assert.equal(row.innerText.includes('GB'), false);
  assert.equal(row.querySelectorAll('button').length, 0);
  row.click();
  assert.deepEqual(selectedIds, ['sidebar-1']);
});

test('pure library modules have zero imports from audio capture, watcher, alignment, or mediabunny engines', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(testDir, '../../../site');
  const forbiddenPatterns = [
    /live-companion/i,
    /live-session/i,
    /live-audio-processor/i,
    /live-proxy/i,
    /directory-watcher/i,
    /audio-aligner/i,
    /recording-probe/i,
    /analysis-queue/i,
    /browser-analysis/i,
    /mediabunny/i,
    /getDisplayMedia/i,
    /getUserMedia/i,
  ];
  for (const filename of ['recording-library-projection.mjs', 'recording-library-view.mjs', 'recording-library-preview.mjs']) {
    const source = readFileSync(path.join(siteDir, filename), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${filename} must not depend on ${pattern}`);
    }
  }
});

test('library preview harness provides pure mock snapshots across all scenarios with strictly 4 merged statuses', () => {
  assert.equal(isLibraryPreview('?libraryPreview=mixed'), true);
  assert.equal(isLibraryPreview('?libraryPreview=empty'), true);
  assert.equal(isLibraryPreview('?libraryPreview=1'), true);
  assert.equal(isLibraryPreview('?reviewPreview=default'), false);
  assert.equal(isLibraryPreview(''), false);

  assert.equal(resolveLibraryPreviewScenario('?libraryPreview=empty'), 'empty');
  assert.equal(resolveLibraryPreviewScenario('?libraryPreview=1'), 'mixed');
  assert.equal(resolveLibraryPreviewScenario('?libraryPreview=unknown'), 'mixed');

  for (const scenario of Object.keys(LIBRARY_PREVIEW_SCENARIOS)) {
    const snapshot = createLibraryPreviewSnapshot(scenario);
    for (const item of snapshot.items) {
      assert.equal(LIBRARY_STATUSES.includes(item.status), true, `Invalid status ${item.status} in ${scenario}`);
      assert.equal(item.filename.includes('/'), false);
      assert.equal(item.filename.includes('\\'), false);
    }
    if (snapshot.watchDirectory.name) {
      assert.equal(snapshot.watchDirectory.name.includes('/'), false);
      assert.equal(snapshot.watchDirectory.name.includes('\\'), false);
    }
  }

  const mixed = createLibraryPreviewSnapshot('mixed');
  const statuses = new Set(mixed.items.map((item) => item.status));
  assert.deepEqual([...statuses].sort(), [...LIBRARY_STATUSES].sort());
  assert.equal(mixed.counts.ready >= 2, true);
  assert.equal(mixed.items.some((item) => item.exportedCount > 0), true);

  const empty = createLibraryPreviewSnapshot('empty');
  assert.equal(empty.items.length, 0);
  assert.equal(empty.liveMonitor.status, 'off');
  assert.equal(empty.watchDirectory.status, 'unset');
});

test('mountLibraryPreview drives interactive pure-view mock callbacks without real engines', () => {
  const doc = createFakeDocument();
  const main = doc.createElement('main');
  main.id = 'main';
  main.prepend = (...nodes) => {
    for (const node of [...nodes].reverse()) {
      node.parentNode = main;
      main.children.unshift(node);
    }
  };
  const pageNode = doc.createElement('div');
  const topbar = doc.createElement('div');
  const queue = doc.createElement('div');
  const countNode = doc.createElement('span');
  const summaryNode = doc.createElement('span');
  const byId = {
    'analysis-page': pageNode,
    'library-topbar-slots': topbar,
    queue,
    'queue-count': countNode,
    'queue-summary': summaryNode,
  };
  doc.getElementById = (id) => byId[id] || null;
  doc.querySelector = (sel) => (sel === '#main' ? main : null);

  const notes = [];
  const harness = mountLibraryPreview({
    scenario: 'mixed',
    doc,
    onNote: (msg) => notes.push(msg),
  });

  assert.equal(harness.getSnapshot().items.length, 5);
  assert.equal(harness.getSnapshot().liveMonitor.status, 'listening');

  // Toggle live monitor slot off -> on
  topbar.querySelector('[data-action="toggle-live-monitor"]').click();
  assert.equal(harness.getSnapshot().liveMonitor.status, 'off');

  // Cycle watch folder
  topbar.querySelector('[data-action="choose-watch-directory"]').click();
  assert.equal(harness.getSnapshot().watchDirectory.name, 'OBS Recordings');

  // Start analysis on unanalyzed row -> analyzing; stop -> unanalyzed
  const unanalyzedRow = queue.querySelectorAll('.file').find((row) => row.dataset.status === 'unanalyzed');
  unanalyzedRow.querySelector('[data-action="analyze"]').click();
  assert.equal(unanalyzedRow.dataset.status, 'analyzing');
  unanalyzedRow.querySelector('[data-action="stop"]').click();
  assert.equal(unanalyzedRow.dataset.status, 'unanalyzed');

  // Reanalyze on coarse row -> analyzing
  const coarseRow = queue.querySelectorAll('.file').find((row) => row.dataset.status === 'conformed-coarse');
  coarseRow.querySelector('[data-action="reanalyze"]').click();
  assert.equal(coarseRow.dataset.status, 'analyzing');

  assert.equal(notes.length >= 5, true);
  harness.dispose();
});

test('mountLibraryPreview dynamically mounts #library-topbar-slots when index.html omits static slot markup and removes it on dispose', () => {
  const doc = createFakeDocument();
  const main = doc.createElement('main');
  main.id = 'main';
  main.prepend = (...nodes) => {
    for (const node of [...nodes].reverse()) {
      node.parentNode = main;
      main.children.unshift(node);
    }
  };
  const pageNode = doc.createElement('div');
  const actionsRow = doc.createElement('div');
  actionsRow.className = 'row queue-heading-actions';
  actionsRow.prepend = (...nodes) => {
    for (const node of [...nodes].reverse()) {
      node.parentNode = actionsRow;
      actionsRow.children.unshift(node);
    }
  };
  const queue = doc.createElement('div');
  const countNode = doc.createElement('span');
  const summaryNode = doc.createElement('span');
  const byId = {
    'analysis-page': pageNode,
    queue,
    'queue-count': countNode,
    'queue-summary': summaryNode,
  };
  doc.getElementById = (id) => byId[id] || null;
  doc.querySelector = (sel) => {
    if (sel === '#main') return main;
    if (sel === '#analysis-page .queue-heading-actions') return actionsRow;
    return null;
  };

  const harness = mountLibraryPreview({ scenario: 'mixed', doc });
  const mountedTopbar = actionsRow.children.find((child) => child.id === 'library-topbar-slots');
  assert.ok(mountedTopbar, 'standalone libraryPreview must dynamically create #library-topbar-slots');
  assert.ok(mountedTopbar.querySelector('[data-action="toggle-live-monitor"]'));
  assert.ok(mountedTopbar.querySelector('[data-action="choose-watch-directory"]'));

  harness.dispose();
  assert.equal(actionsRow.children.some((child) => child.id === 'library-topbar-slots'), false, 'dispose must remove dynamically mounted preview topbar');
});

test('onRowTransition fires after rows are mounted in listContainer for added and completed transitions', () => {
  const doc = createFakeDocument();
  const listContainer = doc.createElement('div');
  const transitions = [];

  const view = createRecordingLibraryView({
    listContainer,
    doc,
    translate: (key, params = {}) => {
      let text = translations.en[key] || key;
      for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    },
    onRowTransition: (row, kind) => {
      transitions.push({
        id: row.dataset.sourceId,
        kind,
        mounted: row.parentNode === listContainer,
      });
    },
  });

  view.render(projectRecordingLibrary({
    items: [{ id: 'rec-1', filename: 'a.mp4', status: 'analyzing', progressPercent: 20 }],
  }));
  view.render(projectRecordingLibrary({
    items: [{ id: 'rec-1', filename: 'a.mp4', status: 'analyzing', progressPercent: 60 }],
  }));
  view.render(projectRecordingLibrary({
    items: [{ id: 'rec-1', filename: 'a.mp4', status: 'ready', candidateCount: 3 }],
  }));

  assert.deepEqual(transitions, [
    { id: 'rec-1', kind: 'added', mounted: true },
    { id: 'rec-1', kind: 'completed', mounted: true },
  ]);
});

test('i18n dictionary uses ADR 0010 Clip/选片 nav and Recording Library/录像库 heading with zero forbidden 分析队列 copy', () => {
  assert.equal(translations.zh.nav_analysis, '选片');
  assert.equal(translations.zh.page_heading, '录像库');
  assert.equal(translations.en.nav_analysis, 'Clip');
  assert.equal(translations.en.page_heading, 'Recording Library');
  for (const [lang, dict] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(/分析队列|analysis queue/i.test(value), false, `${lang}.${key} must not contain forbidden term: ${value}`);
    }
  }
  setLang('en');
});


