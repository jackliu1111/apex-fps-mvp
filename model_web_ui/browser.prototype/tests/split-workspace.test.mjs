import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  resolveReviewPrimaryAction,
  dispatchReviewPrimaryAction,
  resolveClippingLayout,
  reconcileSplitSelection,
  createSplitPlayerSync,
} from '../../../site/split-workspace-controller.mjs';
import { projectRecordingLibrary } from '../../../site/recording-library-projection.mjs';
import { createRecordingLibraryView } from '../../../site/recording-library-view.mjs';
import { createReviewWorkspace } from '../../../site/review-workspace.mjs';
import {
  WORKSPACE_PREVIEW_SCENARIOS,
  isWorkspacePreview,
  resolveWorkspacePreviewScenario,
  createWorkspacePreviewSeeds,
  mountSplitWorkspacePreview,
} from '../../../site/split-workspace-preview.mjs';
import { translations } from '../../../site/i18n.js';

test('resolveReviewPrimaryAction maps the 4 merged statuses to the single review-header CTA (or hidden for ready)', () => {
  assert.deepEqual(
    resolveReviewPrimaryAction({ id: 's1', status: 'unanalyzed', canAnalyze: true }),
    { kind: 'analyze', labelKey: 'library_action_analyze', disabled: false, tone: 'primary' },
  );

  assert.deepEqual(
    resolveReviewPrimaryAction({ id: 's1', status: 'unanalyzed', canAnalyze: false }),
    { kind: 'analyze', labelKey: 'library_action_analyze', disabled: true, tone: 'primary' },
  );

  assert.deepEqual(
    resolveReviewPrimaryAction({ id: 's2', status: 'analyzing', canStop: true }),
    { kind: 'stop', labelKey: 'library_action_stop', disabled: false, tone: 'quiet' },
  );

  assert.deepEqual(
    resolveReviewPrimaryAction({ id: 's3', status: 'conformed-coarse', canReanalyze: true }),
    { kind: 'reanalyze', labelKey: 'review_action_reanalyze_offline', disabled: false, tone: 'warning' },
  );

  assert.equal(resolveReviewPrimaryAction({ id: 's4', status: 'ready' }), null);
  assert.equal(resolveReviewPrimaryAction(null), null);
});

test('projectRecordingLibrary preserves canAnalyze/canStop/canReanalyze flags so detached recordless sources disable review primary action', () => {
  const snapshot = projectRecordingLibrary({
    sources: [
      {
        id: 'src-detached-unanalyzed',
        identity: { name: 'Detached_Unanalyzed.mp4', size: 100, lastModified: 1000 },
        duration: 60,
        analysis: { status: 'unanalyzed', processedUntil: 0, error: null },
        clips: [],
      },
      {
        id: 'src-detached-analyzing',
        identity: { name: 'Detached_Analyzing.mp4', size: 100, lastModified: 2000 },
        duration: 60,
        analysis: { status: 'analyzing', processedUntil: 20, error: null },
        clips: [],
      },
      {
        id: 'src-detached-coarse',
        identity: { name: 'Detached_Coarse.mp4', size: 100, lastModified: 3000 },
        duration: 60,
        analysis: { status: 'completed', processedUntil: 60, error: null },
        alignment: { confidence: 'coarse' },
        clips: [],
      },
      {
        id: 'src-live-unanalyzed',
        identity: { name: 'Live_Unanalyzed.mp4', size: 100, lastModified: 4000 },
        duration: 60,
        analysis: { status: 'unanalyzed', processedUntil: 0, error: null },
        clips: [],
      },
    ],
    records: [
      {
        id: 'rec-live',
        sourceId: 'src-live-unanalyzed',
        status: 'unanalyzed',
        duration: 60,
        processedUntil: 0,
        file: { name: 'Live_Unanalyzed.mp4', size: 100, lastModified: 4000 },
      },
    ],
  });

  const byId = new Map(snapshot.items.map((item) => [item.id, item]));

  const detachedUnanalyzed = byId.get('src-detached-unanalyzed');
  assert.equal(detachedUnanalyzed.canAnalyze, false);
  assert.equal(detachedUnanalyzed.canStop, false);
  assert.equal(detachedUnanalyzed.canReanalyze, false);
  assert.equal(resolveReviewPrimaryAction(detachedUnanalyzed).disabled, true);

  const detachedAnalyzing = byId.get('src-detached-analyzing');
  assert.equal(detachedAnalyzing.canStop, false);
  assert.equal(resolveReviewPrimaryAction(detachedAnalyzing).disabled, true);

  const detachedCoarse = byId.get('src-detached-coarse');
  assert.equal(detachedCoarse.canReanalyze, false);
  assert.equal(resolveReviewPrimaryAction(detachedCoarse).disabled, true);

  const liveUnanalyzed = byId.get('src-live-unanalyzed');
  assert.equal(liveUnanalyzed.canAnalyze, true);
  assert.equal(liveUnanalyzed.canStop, true);
  assert.equal(liveUnanalyzed.canReanalyze, true);
  assert.equal(resolveReviewPrimaryAction(liveUnanalyzed).disabled, false);
});

test('dispatchReviewPrimaryAction routes analyze/stop/reanalyze cleanly to analysis queue and clears coarse alignment on reanalyze', async () => {
  const calls = [];
  const fakeQueue = {
    async retry(id) { calls.push(['retry', id]); return true; },
    stop(id) { calls.push(['stop', id]); return true; },
  };

  // Unanalyzed -> retry(record.id)
  const unanalyzedRecord = { id: 'rec-1', status: 'stopped', alignment: null };
  const r1 = await dispatchReviewPrimaryAction({
    item: { id: 'src-1', status: 'unanalyzed', canAnalyze: true },
    record: unanalyzedRecord,
    queue: fakeQueue,
  });
  assert.deepEqual(r1, { dispatched: true, kind: 'analyze' });

  // Analyzing -> stop(record.id)
  const analyzingRecord = { id: 'rec-2', status: 'analyzing', alignment: null };
  const r2 = await dispatchReviewPrimaryAction({
    item: { id: 'src-2', status: 'analyzing', canStop: true },
    record: analyzingRecord,
    queue: fakeQueue,
  });
  assert.deepEqual(r2, { dispatched: true, kind: 'stop' });

  // Coarse conform -> clears alignment and retries full offline analysis
  const coarseRecord = { id: 'rec-3', status: 'complete', alignment: { confidence: 'coarse' } };
  const r3 = await dispatchReviewPrimaryAction({
    item: { id: 'src-3', status: 'conformed-coarse', canReanalyze: true },
    record: coarseRecord,
    queue: fakeQueue,
  });
  assert.deepEqual(r3, { dispatched: true, kind: 'reanalyze' });
  assert.equal(coarseRecord.alignment, null);

  // Ready -> no-op
  const r4 = await dispatchReviewPrimaryAction({
    item: { id: 'src-4', status: 'ready' },
    record: { id: 'rec-4', status: 'complete' },
    queue: fakeQueue,
  });
  assert.deepEqual(r4, { dispatched: false, kind: null });

  // Missing record -> safe no-op
  const r5 = await dispatchReviewPrimaryAction({
    item: { id: 'src-5', status: 'unanalyzed', canAnalyze: true },
    record: null,
    queue: fakeQueue,
  });
  assert.deepEqual(r5, { dispatched: false, kind: 'analyze' });

  assert.deepEqual(calls, [
    ['retry', 'rec-1'],
    ['stop', 'rec-2'],
    ['retry', 'rec-3'],
  ]);
});

test('resolveClippingLayout always keeps split workspace on Clipping page (even when empty), and preserves exports/libraryPreview', () => {
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 0 }), 'split');
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 1 }), 'split');
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 5 }), 'split');
  assert.equal(resolveClippingLayout({ page: 'exports', itemCount: 5 }), 'exports');
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 5, forceStandaloneLibrary: true }), 'standalone-library');
});

test('reconcileSplitSelection maintains selection stability across progress/candidate updates, new imports, and runtime->source promotion without unnecessary player reloads', () => {
  const fileA = { name: 'match-a.mp4' };
  const fileB = { name: 'match-b.mp4' };
  const files = new Map([['src-a', fileA], ['src-b', fileB]]);
  const getFileForId = (id) => files.get(id) || null;

  // 1. Empty -> first runtime preparing item auto-selects without loading player yet (no prepared file bound to sourceId)
  const step1 = reconcileSplitSelection({
    items: [{ id: 'runtime:rec-a', recordId: 'rec-a', status: 'analyzing' }],
    activeSourceId: null,
    activeRecordId: null,
    loadedSourceId: null,
    loadedFile: null,
    getFileForId,
  });
  assert.equal(step1.activeSourceId, 'runtime:rec-a');
  assert.equal(step1.activeRecordId, 'rec-a');
  assert.equal(step1.shouldReloadPlayer, false);

  // 2. Preparing item finishes and transitions runtime:rec-a -> src-a: promotes cleanly & triggers player load
  const step2 = reconcileSplitSelection({
    items: [{ id: 'src-a', recordId: 'rec-a', status: 'analyzing', progressPercent: 0 }],
    activeSourceId: step1.activeSourceId,
    activeRecordId: step1.activeRecordId,
    loadedSourceId: null,
    loadedFile: null,
    getFileForId,
  });
  assert.equal(step2.activeSourceId, 'src-a');
  assert.equal(step2.activeRecordId, 'rec-a');
  assert.equal(step2.shouldReloadPlayer, true);

  // 3. Analysis progress & candidate updates on active src-a: MUST NOT reload player or change selection
  const step3 = reconcileSplitSelection({
    items: [{ id: 'src-a', recordId: 'rec-a', status: 'analyzing', progressPercent: 64, candidateCount: 4 }],
    activeSourceId: 'src-a',
    activeRecordId: 'rec-a',
    loadedSourceId: 'src-a',
    loadedFile: fileA,
    getFileForId,
  });
  assert.equal(step3.activeSourceId, 'src-a');
  assert.equal(step3.shouldReloadPlayer, false);

  // 4. Newer recording arrives at top of newest-first list: MUST keep src-a active and NEVER jump rows or reload player
  const step4 = reconcileSplitSelection({
    items: [
      { id: 'src-b', recordId: 'rec-b', status: 'ready', candidateCount: 6 },
      { id: 'src-a', recordId: 'rec-a', status: 'ready', candidateCount: 7 },
    ],
    activeSourceId: 'src-a',
    activeRecordId: 'rec-a',
    loadedSourceId: 'src-a',
    loadedFile: fileA,
    getFileForId,
  });
  assert.equal(step4.activeSourceId, 'src-a');
  assert.equal(step4.shouldReloadPlayer, false);

  // 5. Clicking already-selected row src-a while loaded -> no reload
  const step5 = reconcileSplitSelection({
    items: [
      { id: 'src-b', recordId: 'rec-b', status: 'ready' },
      { id: 'src-a', recordId: 'rec-a', status: 'ready' },
    ],
    activeSourceId: 'src-a',
    activeRecordId: 'rec-a',
    requestedSourceId: 'src-a',
    loadedSourceId: 'src-a',
    loadedFile: fileA,
    getFileForId,
  });
  assert.equal(step5.activeSourceId, 'src-a');
  assert.equal(step5.shouldReloadPlayer, false);

  // 6. Explicitly clicking another row src-b -> switches selection & triggers player load
  const step6 = reconcileSplitSelection({
    items: [
      { id: 'src-b', recordId: 'rec-b', status: 'unanalyzed' },
      { id: 'src-a', recordId: 'rec-a', status: 'ready' },
    ],
    activeSourceId: 'src-a',
    activeRecordId: 'rec-a',
    requestedSourceId: 'src-b',
    loadedSourceId: 'src-a',
    loadedFile: fileA,
    getFileForId,
  });
  assert.equal(step6.activeSourceId, 'src-b');
  assert.equal(step6.activeRecordId, 'rec-b');
  assert.equal(step6.shouldReloadPlayer, true);

  // 7. Active item removed -> falls back cleanly to first remaining item
  const step7 = reconcileSplitSelection({
    items: [{ id: 'src-a', recordId: 'rec-a', status: 'ready' }],
    activeSourceId: 'src-b',
    activeRecordId: 'rec-b',
    loadedSourceId: 'src-b',
    loadedFile: fileB,
    getFileForId,
  });
  assert.equal(step7.activeSourceId, 'src-a');
  assert.equal(step7.shouldReloadPlayer, true);

  // 8. Library cleared -> clears selection & requests player disposal
  const step8 = reconcileSplitSelection({
    items: [],
    activeSourceId: 'src-a',
    activeRecordId: 'rec-a',
    loadedSourceId: 'src-a',
    loadedFile: fileA,
    getFileForId,
  });
  assert.equal(step8.activeSourceId, null);
  assert.equal(step8.shouldReloadPlayer, false);
  assert.equal(step8.shouldDisposePlayer, true);
});

test('createSplitPlayerSync loads player exactly once on recording switch even with re-entrant renders, respects focusFirstCandidate position, and coalesces duplicate loads', async () => {
  const fileA = { name: 'match-a.mp4' };
  const fileB = { name: 'match-b.mp4' };
  const records = new Map([
    ['src-a', { file: fileA, origin: 0, duration: 60 }],
    ['src-b', { file: fileB, origin: 0.5, duration: 90 }],
    ['src-detached', { file: null, origin: 0, duration: 45 }],
  ]);
  const positions = new Map([
    ['src-a', 4],
    ['src-b', 0],
    ['src-detached', 0],
  ]);

  const loadCalls = [];
  const disposeCalls = [];
  const pauseCalls = [];
  const pendingLoads = new Map();

  const playerSync = createSplitPlayerSync({
    getRecord: (id) => records.get(id) || null,
    getPosition: (id) => positions.get(id) ?? 0,
    pausePlayer: () => { pauseCalls.push('pause'); },
    loadPlayer: async ({ file, origin, duration, position }) => {
      loadCalls.push({ file, origin, duration, position });
      const deferred = Promise.withResolvers();
      pendingLoads.set(file, deferred);
      await deferred.promise;
    },
    disposePlayer: async () => {
      disposeCalls.push('dispose');
    },
  });

  const items = [
    { id: 'src-b', recordId: 'rec-b', status: 'ready' },
    { id: 'src-a', recordId: 'rec-a', status: 'ready' },
    { id: 'src-detached', recordId: null, status: 'ready' },
  ];

  let activeSourceId = null;
  let activeRecordId = null;
  const simulateRender = () => {
    const loaded = playerSync.effectiveLoaded();
    const rec = reconcileSplitSelection({
      items,
      activeSourceId,
      activeRecordId,
      loadedSourceId: loaded.sourceId,
      loadedFile: loaded.file,
      getFileForId: (id) => records.get(id)?.file || null,
    });
    activeSourceId = rec.activeSourceId;
    activeRecordId = rec.activeRecordId;
    playerSync.syncSelection(rec);
    return rec;
  };

  // 1) Initial load of src-a
  activeSourceId = 'src-a';
  activeRecordId = 'rec-a';
  simulateRender();
  assert.equal(loadCalls.length, 1);
  assert.equal(loadCalls[0].file, fileA);
  assert.equal(loadCalls[0].position, 4);
  pendingLoads.get(fileA).resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(playerSync.loadedSourceId, 'src-a');
  assert.equal(playerSync.isLoading, false);

  // 2) Switch to src-b with focusFirstCandidate while multiple re-entrant renders fire mid-transition
  const switchLoaded = playerSync.effectiveLoaded();
  const switchRec = reconcileSplitSelection({
    items,
    activeSourceId,
    activeRecordId,
    requestedSourceId: 'src-b',
    loadedSourceId: switchLoaded.sourceId,
    loadedFile: switchLoaded.file,
    getFileForId: (id) => records.get(id)?.file || null,
  });

  playerSync.withDeferredSync(() => {
    activeSourceId = switchRec.activeSourceId;
    activeRecordId = switchRec.activeRecordId;
    // Simulate uxController.onRecordingOpened -> re-entrant render BEFORE focusFirstCandidate sets position!
    simulateRender();
    positions.set('src-b', 22.5);
    // Simulate workspace.setReview -> re-entrant render
    simulateRender();
    // Simulate explicit render() at end of openReview prep
    simulateRender();
  });

  // Zero premature loads happened during deferred transition!
  assert.equal(loadCalls.length, 1, 'Re-entrant renders during openReview must not prematurely load player');

  // Now sync ONCE after deferred block
  const loadBPromise = playerSync.syncSelection(switchRec);
  assert.equal(loadCalls.length, 2, 'Switching recording must trigger player.load() exactly once');
  assert.equal(loadCalls[1].file, fileB);
  assert.equal(loadCalls[1].position, 22.5, 'Single player.load() must use updated focusFirstCandidate position');

  // Re-render while src-b is still loading (e.g. progress update or double-click) -> ZERO extra loads!
  simulateRender();
  const coalescedPromise = playerSync.loadSource('src-b');
  assert.equal(coalescedPromise, loadBPromise);
  assert.equal(loadCalls.length, 2, 'In-flight load for same source/file must coalesce without double-loading');

  pendingLoads.get(fileB).resolve();
  await loadBPromise;
  assert.equal(playerSync.loadedSourceId, 'src-b');
  assert.equal(playerSync.isLoading, false);

  // Subsequent render after load finishes -> ZERO extra loads!
  simulateRender();
  assert.equal(loadCalls.length, 2);

  // 3) Switching to detached source (no file) disposes player exactly once
  const detachedLoaded = playerSync.effectiveLoaded();
  const detachedRec = reconcileSplitSelection({
    items,
    activeSourceId,
    activeRecordId,
    requestedSourceId: 'src-detached',
    loadedSourceId: detachedLoaded.sourceId,
    loadedFile: detachedLoaded.file,
    getFileForId: (id) => records.get(id)?.file || null,
  });
  playerSync.withDeferredSync(() => {
    activeSourceId = detachedRec.activeSourceId;
    activeRecordId = detachedRec.activeRecordId;
    simulateRender();
  });
  await playerSync.syncSelection(detachedRec);
  assert.equal(disposeCalls.length, 1);
  assert.equal(playerSync.loadedSourceId, null);
});

function createFakeDocument() {
  function makeElement(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
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
      onkeydown: null,
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
      dispatchKey(key) {
        let prevented = false;
        const event = { key, preventDefault() { prevented = true; } };
        if (typeof this.onkeydown === 'function') this.onkeydown(event);
        for (const fn of this.listeners.get('keydown') || []) fn(event);
        return prevented;
      },
      querySelectorAll(selector) {
        const matches = [];
        const matchOne = (node) => {
          if (selector.startsWith('.')) {
            const needed = selector.slice(1).split('.').filter(Boolean);
            const classes = node.className.split(/\s+/);
            return needed.every((cls) => classes.includes(cls));
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

function makeTranslate(lang) {
  return (key, params = {}) => {
    let text = translations[lang]?.[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
}

test('sidebar library view renders flat newest-first rows with 4 merged statuses, zero inline buttons, zero file size/paths, tooltip full basename, and selects all 4 statuses via click or keyboard', () => {
  const doc = createFakeDocument();
  const listContainer = doc.createElement('div');
  const selected = [];

  const view = createRecordingLibraryView({
    listContainer,
    doc,
    showActions: false,
    showSize: false,
    translate: makeTranslate('zh'),
    onSelect: (id, item) => selected.push([id, item.status]),
  });

  const makeItems = (progress = 42, candidates = 2) => ([
    {
      id: 'id-unanalyzed',
      filename: 'C:\\OBS\\Apex\\2026-11-26_13-10_BrokenMoon_Warmup.mp4',
      recordedAtMs: new Date(2026, 10, 26, 13, 10).getTime(),
      durationSeconds: 510,
      sizeBytes: 720 * 1024 ** 2,
      status: 'unanalyzed',
      candidateCount: 0,
      exportedCount: 0,
      canReview: false,
    },
    {
      id: 'id-ready',
      filename: '/Users/alice/Videos/Apex/2026-11-26_15-05_Olympus_Win.mkv',
      recordedAtMs: new Date(2026, 10, 26, 15, 5).getTime(),
      durationSeconds: 1122,
      sizeBytes: 1.9 * 1024 ** 3,
      status: 'conformed-exact',
      candidateCount: 7,
      exportedCount: 2,
    },
    {
      id: 'id-analyzing',
      filename: '2026-11-26_14-12_StormPoint_Clutch.mkv',
      recordedAtMs: new Date(2026, 10, 26, 14, 12).getTime(),
      durationSeconds: 668,
      sizeBytes: 960 * 1024 ** 2,
      status: 'analyzing',
      progressPercent: progress,
      candidateCount: candidates,
      exportedCount: 0,
    },
    {
      id: 'id-coarse',
      filename: '2026-11-26_14-40_WorldsEdge_Ranked.mp4',
      recordedAtMs: new Date(2026, 10, 26, 14, 40).getTime(),
      durationSeconds: 855,
      sizeBytes: 1.3 * 1024 ** 3,
      status: 'conformed-coarse',
      candidateCount: 5,
      exportedCount: 1,
    },
  ]);

  view.render(projectRecordingLibrary({
    items: makeItems(),
    activeSourceId: 'id-analyzing',
    sortOrder: 'newest-first',
  }));

  const rows = listContainer.querySelectorAll('.file.library-row');
  assert.equal(listContainer.getAttribute('role'), 'listbox');
  assert.deepEqual(
    rows.map((r) => r.dataset.sourceId),
    ['id-ready', 'id-coarse', 'id-analyzing', 'id-unanalyzed'],
    'Sidebar list must be flat and strictly newest-first (never grouped by status)',
  );

  // Check each row invariant: zero inline buttons, zero file sizes, zero paths, full basename tooltip, aria-selected
  for (const row of rows) {
    assert.equal(row.querySelectorAll('button').length, 0, 'Sidebar rows must not contain inline action buttons');
    assert.equal(row.getAttribute('role'), 'option');
    assert.equal(row.getAttribute('tabindex'), '0');
    assert.equal(/\b(?:GB|MB|KB)\b/.test(row.innerText), false, 'Sidebar rows must not show file size');
    assert.equal(row.innerText.includes('/Users/'), false, 'Sidebar rows must not leak Unix paths');
    assert.equal(row.innerText.includes('C:\\'), false, 'Sidebar rows must not leak Windows paths');
    const nameEl = row.querySelector('.library-filename');
    assert.equal(nameEl.title, nameEl.textContent, 'Filename tooltip must expose full basename');
  }

  assert.equal(rows[0].querySelector('.library-meta').textContent, '15:05 · 18:42');
  assert.equal(rows[0].querySelector('.library-status-badge').textContent, '已就绪');
  assert.equal(rows[0].querySelector('.library-summary-text').textContent, '7 处候选 · 已导出 2');
  assert.equal(rows[1].querySelector('.library-status-badge').textContent, '已就绪 ⚠ 粗略');
  assert.equal(rows[1].querySelector('.library-summary-text').textContent, '5 处候选 · 已导出 1');
  assert.equal(rows[2].querySelector('.library-status-badge').textContent, '分析中 42%');
  assert.equal(rows[2].getAttribute('aria-selected'), 'true');
  assert.equal(rows[3].querySelector('.library-status-badge').textContent, '未分析');

  // Clicking ANY row (including unanalyzed with canReview: false & analyzing) triggers onSelect
  rows[3].click();
  rows[2].click();
  rows[1].click();
  assert.equal(rows[0].dispatchKey('Enter'), true);
  assert.deepEqual(selected, [
    ['id-unanalyzed', 'unanalyzed'],
    ['id-analyzing', 'analyzing'],
    ['id-coarse', 'conformed-coarse'],
    ['id-ready', 'ready'],
  ]);

  // Updating progress & candidate counts reuses the exact same DOM row node without jumping or losing selection
  const analyzingRowBefore = rows[2];
  view.render(projectRecordingLibrary({
    items: makeItems(88, 6),
    activeSourceId: 'id-analyzing',
    sortOrder: 'newest-first',
  }));
  const rowsAfter = listContainer.querySelectorAll('.file.library-row');
  assert.equal(rowsAfter[2], analyzingRowBefore, 'Row DOM node must stay stable across progress/candidate updates');
  assert.equal(rowsAfter[2].querySelector('.library-status-badge').textContent, '分析中 88%');
  assert.equal(rowsAfter[2].querySelector('.library-summary-text').textContent, '6 处候选');
  assert.equal(rowsAfter[2].getAttribute('aria-selected'), 'true');
});

test('workspace preview helpers detect URL param and cover mixed, analyzing, coarse, and empty scenarios cleanly', () => {
  assert.equal(isWorkspacePreview('?workspacePreview=mixed'), true);
  assert.equal(isWorkspacePreview('?workspacePreview=coarse'), true);
  assert.equal(isWorkspacePreview('?workspacePreview=1'), true);
  assert.equal(isWorkspacePreview('?libraryPreview=mixed'), false);
  assert.equal(isWorkspacePreview(''), false);

  assert.equal(resolveWorkspacePreviewScenario('?workspacePreview=analyzing'), 'analyzing');
  assert.equal(resolveWorkspacePreviewScenario('?workspacePreview=coarse'), 'coarse');
  assert.equal(resolveWorkspacePreviewScenario('?workspacePreview=empty'), 'empty');
  assert.equal(resolveWorkspacePreviewScenario('?workspacePreview=1'), 'mixed');
  assert.equal(resolveWorkspacePreviewScenario('?workspacePreview=bogus'), 'mixed');

  assert.deepEqual(Object.keys(WORKSPACE_PREVIEW_SCENARIOS), ['mixed', 'analyzing', 'coarse', 'empty']);

  const mixed = createWorkspacePreviewSeeds('mixed');
  const projected = projectRecordingLibrary({
    items: mixed.recordings.map((rec) => ({
      id: rec.id,
      filename: rec.name,
      recordedAtMs: rec.lastModified,
      durationSeconds: rec.duration,
      sizeBytes: rec.size,
      status: rec.rawStatus,
      alignment: rec.alignment,
      processedUntil: rec.processedUntil,
      candidateCount: rec.candidates.length,
      exportedCount: rec.savedExports,
    })),
  });
  const statuses = new Set(projected.items.map((item) => item.status));
  assert.deepEqual([...statuses].sort(), ['analyzing', 'conformed-coarse', 'ready', 'unanalyzed']);
  assert.equal(projected.items.some((item) => item.exportedCount > 0), true);
  for (const item of projected.items) {
    assert.equal(item.filename.includes('/'), false);
    assert.equal(item.filename.includes('\\'), false);
  }

  assert.equal(createWorkspacePreviewSeeds('empty').recordings.length, 0);
  assert.equal(createWorkspacePreviewSeeds('analyzing').recordings[0].rawStatus, 'analyzing');
  assert.equal(createWorkspacePreviewSeeds('coarse').recordings[0].alignment?.confidence, 'coarse');
});

test('mountSplitWorkspacePreview seeds review workspace, supports interactive primary actions, and preserves manual review decisions', async () => {
  const doc = createFakeDocument();
  const main = doc.createElement('main');
  main.id = 'main';
  main.prepend = (...nodes) => {
    for (const node of [...nodes].reverse()) {
      node.parentNode = main;
      main.children.unshift(node);
    }
  };
  doc.querySelector = (sel) => (sel === '#main' ? main : null);

  let currentView = { sources: [], batches: [] };
  const workspace = createReviewWorkspace({ onChange(next) { currentView = next; } });
  const bindings = new Map();
  let activeId = null;
  const opened = [];
  const fakeApp = {
    workspace,
    bindings,
    async openReview(id) {
      activeId = id;
      opened.push(id);
    },
    get activeSourceId() { return activeId; },
    render() {},
  };

  const harness = await mountSplitWorkspacePreview(fakeApp, { scenario: 'mixed', doc });
  assert.equal(currentView.sources.length, 5);
  assert.ok(activeId);
  assert.equal(opened.length, 1);

  // Make a manual review decision on the coarse recording
  const coarseSource = currentView.sources.find((s) => bindings.get(s.id)?.alignment?.confidence === 'coarse');
  assert.ok(coarseSource);
  const manualClipId = workspace.addManual(coarseSource.id, { start: 12, end: 18 });
  assert.ok(workspace.getSource(coarseSource.id).decisions.length >= 1);

  // Trigger re-analyze on coarse recording -> clears coarse alignment, enters analyzing, preserves manual decisions!
  const reanalyzeResult = harness.runPreviewAction(coarseSource.id, 'reanalyze');
  assert.equal(reanalyzeResult, true);
  assert.equal(bindings.get(coarseSource.id).alignment, null);
  assert.equal(workspace.getSource(coarseSource.id).analysis.status, 'analyzing');
  assert.equal(
    workspace.getSource(coarseSource.id).clips.some((clip) => clip.id === manualClipId),
    true,
    'Re-analyzing must preserve manual review decisions (ADR 0004)',
  );

  // Stop analyzing -> transitions to stopped (projects to unanalyzed)
  assert.equal(harness.runPreviewAction(coarseSource.id, 'stop'), true);
  assert.equal(workspace.getSource(coarseSource.id).analysis.status, 'stopped');

  // Start analysis from unanalyzed -> transitions back to analyzing
  assert.equal(harness.runPreviewAction(coarseSource.id, 'analyze'), true);
  assert.equal(workspace.getSource(coarseSource.id).analysis.status, 'analyzing');

  harness.dispose();
});

test('index.html and i18n implement 2-tab Clip/Exports navigation, remove legacy review switchers, and avoid forbidden domain terms', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(testDir, '../../../site');
  const html = readFileSync(path.join(siteDir, 'index.html'), 'utf8');

  // Two-tab workspace navigation: #nav-analysis + #nav-exports; #nav-review removed
  assert.match(html, /id="nav-analysis"/);
  assert.match(html, /id="nav-exports"/);
  assert.equal(/id="nav-review"/.test(html), false, '#nav-review must be removed');

  // Legacy review page source dropdown and back button removed
  assert.equal(/id="source-select"/.test(html), false, '#source-select must be removed');
  assert.equal(/id="back-analysis"/.test(html), false, '#back-analysis must be removed');

  // Split-pane workspace container & review-header primary action present
  assert.match(html, /id="clipping-workspace"/);
  assert.match(html, /id="review-primary-action"/);
  assert.match(html, /id="review-source-title"/);

  // i18n labels match ADR 0010 & CONTEXT.md
  assert.equal(translations.zh.nav_analysis, '选片');
  assert.equal(translations.en.nav_analysis, 'Clip');
  assert.equal(translations.zh.nav_exports, '导出任务');
  assert.equal(translations.en.nav_exports, 'Exports');
  assert.equal(translations.zh.review_action_reanalyze_offline, '重新离线分析');
  assert.equal(translations.en.review_action_reanalyze_offline, 'Re-analyze Offline');
  assert.equal(translations.zh.library_action_analyze, '开始分析');
  assert.equal(translations.en.library_action_analyze, 'Start Analysis');
  assert.equal(translations.zh.library_action_stop, '停止');
  assert.equal(translations.en.library_action_stop, 'Stop');

  // Zero forbidden terms from CONTEXT.md across all active translations
  for (const [lang, dict] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(/分析队列|analysis queue|录像库页|复核页/i.test(value), false, `${lang}.${key} contains forbidden term: ${value}`);
    }
  }
});
