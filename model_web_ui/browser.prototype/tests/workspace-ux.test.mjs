import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  LIBRARY_SIDEBAR_COLLAPSED_KEY,
  NARROW_WORKSPACE_BREAKPOINT_PX,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  isNarrowWorkspaceViewport,
  createWorkspaceUxController,
  isEditableShortcutTarget,
  resolveRecordingShortcutTarget,
  resolveDrawerEscape,
  canAcceptWorkspaceDrop,
} from '../../../site/split-workspace-controller.mjs';
import { projectRecordingLibrary } from '../../../site/recording-library-projection.mjs';
import { createRecordingLibraryView } from '../../../site/recording-library-view.mjs';
import { createReviewWorkspace } from '../../../site/review-workspace.mjs';
import { mountSplitWorkspacePreview } from '../../../site/split-workspace-preview.mjs';
import { translations } from '../../../site/i18n.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    _map: map,
  };
}

test('sidebar collapse preference defaults to expanded, persists across reloads, and handles unavailable storage safely', () => {
  assert.equal(LIBRARY_SIDEBAR_COLLAPSED_KEY, 'apex_local_cut_library_collapsed');
  assert.equal(NARROW_WORKSPACE_BREAKPOINT_PX, 900);

  const storage = createMemoryStorage();
  assert.equal(loadSidebarCollapsed(storage), false, 'Desktop sidebar must be expanded by default');

  assert.equal(saveSidebarCollapsed(true, storage), true);
  assert.equal(storage.getItem(LIBRARY_SIDEBAR_COLLAPSED_KEY), '1');
  assert.equal(loadSidebarCollapsed(storage), true, 'Reload must remember collapsed choice');

  assert.equal(saveSidebarCollapsed(false, storage), true);
  assert.equal(storage.getItem(LIBRARY_SIDEBAR_COLLAPSED_KEY), '0');
  assert.equal(loadSidebarCollapsed(storage), false, 'Reload must remember expanded choice');

  // Legacy/truthy string compatibility & invalid value fallback
  assert.equal(loadSidebarCollapsed(createMemoryStorage({ [LIBRARY_SIDEBAR_COLLAPSED_KEY]: 'true' })), true);
  assert.equal(loadSidebarCollapsed(createMemoryStorage({ [LIBRARY_SIDEBAR_COLLAPSED_KEY]: 'bogus' })), false);

  // Failing storage (e.g. private browsing quota/security errors) must never throw
  const brokenStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.equal(loadSidebarCollapsed(brokenStorage), false);
  assert.equal(saveSidebarCollapsed(true, brokenStorage), false);
  assert.equal(loadSidebarCollapsed(null), false);

  // Breakpoint check (<= 900px is narrow drawer mode)
  assert.equal(isNarrowWorkspaceViewport(1440), false);
  assert.equal(isNarrowWorkspaceViewport(901), false);
  assert.equal(isNarrowWorkspaceViewport(900), true);
  assert.equal(isNarrowWorkspaceViewport(768), true);
  assert.equal(isNarrowWorkspaceViewport(390), true);
});

test('createWorkspaceUxController manages collapse persistence, narrow drawer auto-close, new badges, and import-without-switching rules', () => {
  const storage = createMemoryStorage();
  const changes = [];
  const ux = createWorkspaceUxController({
    storage,
    onChange(snap) { changes.push(snap); },
  });

  assert.equal(ux.snapshot().sidebarCollapsed, false);
  assert.equal(ux.snapshot().drawerOpen, false);
  assert.equal(ux.snapshot().newCount, 0);

  // Toggle collapse persists to storage and survives reload in a fresh controller
  assert.equal(ux.toggleSidebarCollapsed(), true);
  assert.equal(ux.snapshot().sidebarCollapsed, true);
  const reloaded = createWorkspaceUxController({ storage });
  assert.equal(reloaded.snapshot().sidebarCollapsed, true);

  // Narrow drawer opens, toggles, and closes on recording selection, resize > 900, or leaving split
  ux.openDrawer();
  assert.equal(ux.snapshot().drawerOpen, true);
  ux.onRecordingOpened('src-1');
  assert.equal(ux.snapshot().drawerOpen, false, 'Selecting a recording must auto-close narrow drawer');

  ux.toggleDrawer();
  assert.equal(ux.snapshot().drawerOpen, true);
  ux.handleViewportResize(768);
  assert.equal(ux.snapshot().drawerOpen, true, 'Drawer stays open on narrow viewport resize');
  ux.handleViewportResize(1024);
  assert.equal(ux.snapshot().drawerOpen, false, 'Drawer auto-closes when viewport widens past 900px');

  ux.openDrawer();
  ux.handleLayoutChange('exports');
  assert.equal(ux.snapshot().drawerOpen, false, 'Drawer auto-closes when leaving split clipping layout');

  // Empty library import: 1st recording auto-selected & NOT marked new; extra files marked new
  const emptyOutcome = ux.recordAddedRecordings({
    wasEmpty: true,
    addedIds: ['src-a', 'src-b'],
    activeSourceId: null,
  });
  assert.equal(emptyOutcome.shouldSwitch, true);
  assert.equal(emptyOutcome.nextActiveSourceId, 'src-a');
  assert.equal(ux.isRecordingNew('src-a'), false, 'Auto-selected first recording must not keep New badge');
  assert.equal(ux.isRecordingNew('src-b'), true, 'Secondary recording dropped together receives New badge');
  assert.equal(ux.snapshot().newCount, 1);

  // Non-empty library drop/import: MUST NOT switch active recording, marks newly added recordings as New
  const nonEmptyOutcome = ux.recordAddedRecordings({
    wasEmpty: false,
    addedIds: ['src-c', 'src-d'],
    activeSourceId: 'src-a',
  });
  assert.equal(nonEmptyOutcome.shouldSwitch, false);
  assert.equal(nonEmptyOutcome.nextActiveSourceId, 'src-a');
  assert.equal(ux.isRecordingNew('src-c'), true);
  assert.equal(ux.isRecordingNew('src-d'), true);
  assert.deepEqual(ux.getNewRecordingIds().sort(), ['src-b', 'src-c', 'src-d']);

  // Opening a recording clears its New badge
  ux.onRecordingOpened('src-c');
  assert.equal(ux.isRecordingNew('src-c'), false);
  assert.deepEqual(ux.getNewRecordingIds().sort(), ['src-b', 'src-d']);

  // Runtime -> source ID promotion preserves New badge for non-active, clears if active
  ux.markRecordingNew('runtime:rec-9', { activeSourceId: 'src-c' });
  assert.equal(ux.isRecordingNew('runtime:rec-9'), true);
  ux.promoteRecordingNew('runtime:rec-9', 'src-9', { activeSourceId: 'src-c' });
  assert.equal(ux.isRecordingNew('runtime:rec-9'), false);
  assert.equal(ux.isRecordingNew('src-9'), true);

  ux.markRecordingNew('runtime:rec-10', { activeSourceId: 'src-c' });
  ux.promoteRecordingNew('runtime:rec-10', 'src-c', { activeSourceId: 'src-c' });
  assert.equal(ux.isRecordingNew('src-c'), false);

  // Explicit mark/clear hooks (used by #61/#62)
  assert.equal(ux.markRecordingNew('src-c', { activeSourceId: 'src-c' }), false, 'Active recording is not marked new by default');
  assert.equal(ux.markRecordingNew('src-e', { activeSourceId: 'src-c' }), true);
  assert.equal(ux.isRecordingNew('src-e'), true);
  assert.equal(ux.clearRecordingNew('src-e'), true);
  assert.equal(ux.isRecordingNew('src-e'), false);

  // Pruning stale IDs
  ux.pruneNewIds(['src-b', 'src-9']);
  assert.deepEqual(ux.getNewRecordingIds().sort(), ['src-9', 'src-b']);
  assert.ok(changes.length > 0);
});

test('Alt+ArrowUp / Alt+ArrowDown navigates sidebar recordings cleanly, respects editable/dialog/layout guards, and handles Escape drawer close', () => {
  const items = [
    { id: 'rec-newest' },
    { id: 'rec-middle' },
    { id: 'rec-oldest' },
  ];

  // Alt+ArrowDown steps down (to older recording); Alt+ArrowUp steps up (to newer recording)
  assert.deepEqual(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false },
      items,
      activeSourceId: 'rec-newest',
      layout: 'split',
    }),
    { handled: true, direction: 1, targetId: 'rec-middle' },
  );
  assert.deepEqual(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true },
      items,
      activeSourceId: 'rec-middle',
      layout: 'split',
    }),
    { handled: true, direction: 1, targetId: 'rec-oldest' },
  );
  assert.deepEqual(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowUp', altKey: true },
      items,
      activeSourceId: 'rec-oldest',
      layout: 'split',
    }),
    { handled: true, direction: -1, targetId: 'rec-middle' },
  );

  // Clamps cleanly at top and bottom boundaries without wrapping
  assert.deepEqual(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowUp', altKey: true },
      items,
      activeSourceId: 'rec-newest',
      layout: 'split',
    }),
    { handled: true, direction: -1, targetId: null },
  );
  assert.deepEqual(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true },
      items,
      activeSourceId: 'rec-oldest',
      layout: 'split',
    }),
    { handled: true, direction: 1, targetId: null },
  );

  // Never conflicts with non-Alt arrows, extra modifiers, or candidate shortcuts
  for (const ev of [
    { key: 'ArrowDown', altKey: false },
    { key: 'ArrowUp', altKey: false },
    { key: 'ArrowLeft', altKey: true },
    { key: 'ArrowDown', altKey: true, ctrlKey: true },
    { key: 'ArrowDown', altKey: true, metaKey: true },
    { key: 'ArrowDown', altKey: true, shiftKey: true },
    { key: '[', altKey: false },
    { key: ']', altKey: false },
    { key: 'ArrowDown', altKey: true, defaultPrevented: true },
    { key: 'ArrowDown', altKey: true, isComposing: true },
  ]) {
    assert.equal(
      resolveRecordingShortcutTarget({ event: ev, items, activeSourceId: 'rec-middle', layout: 'split' }).handled,
      false,
    );
  }

  // Must NOT trigger when focus is inside input, textarea, select, contenteditable, or open dialog
  const makeTarget = (tagName, attrs = {}) => ({
    tagName: tagName.toUpperCase(),
    isContentEditable: Boolean(attrs.contentEditable),
    closest(selector) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) && selector.includes(this.tagName.toLowerCase())) return this;
      if (attrs.insideEditable && selector.includes('contenteditable')) return this;
      return null;
    },
  });

  assert.equal(isEditableShortcutTarget(makeTarget('input')), true);
  assert.equal(isEditableShortcutTarget(makeTarget('textarea')), true);
  assert.equal(isEditableShortcutTarget(makeTarget('select')), true);
  assert.equal(isEditableShortcutTarget(makeTarget('div', { contentEditable: true })), true);
  assert.equal(isEditableShortcutTarget(makeTarget('span', { insideEditable: true })), true);
  assert.equal(isEditableShortcutTarget(makeTarget('button'), true), true, 'Open dialog blocks shortcuts');
  assert.equal(isEditableShortcutTarget(makeTarget('button'), false), false);
  assert.equal(isEditableShortcutTarget(null, false), false);

  assert.equal(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true, target: makeTarget('input') },
      items,
      activeSourceId: 'rec-newest',
      layout: 'split',
    }).handled,
    false,
  );
  assert.equal(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true, target: makeTarget('button') },
      items,
      activeSourceId: 'rec-newest',
      layout: 'split',
      hasOpenDialog: true,
    }).handled,
    false,
  );

  // Must NOT trigger on Exports page, Live mode, or empty library
  for (const layout of ['exports', 'live', 'empty', 'standalone-library']) {
    assert.equal(
      resolveRecordingShortcutTarget({
        event: { key: 'ArrowDown', altKey: true },
        items,
        activeSourceId: 'rec-newest',
        layout,
      }).handled,
      false,
    );
  }
  assert.equal(
    resolveRecordingShortcutTarget({
      event: { key: 'ArrowDown', altKey: true },
      items: [],
      activeSourceId: null,
      layout: 'split',
    }).handled,
    false,
  );

  // Escape closes narrow drawer when open (and does not intercept when closed)
  assert.deepEqual(
    resolveDrawerEscape({ event: { key: 'Escape' }, drawerOpen: true, layout: 'split' }),
    { handled: true, shouldClose: true },
  );
  assert.deepEqual(
    resolveDrawerEscape({ event: { key: 'Escape' }, drawerOpen: false, layout: 'split' }),
    { handled: false, shouldClose: false },
  );
  assert.deepEqual(
    resolveDrawerEscape({ event: { key: 'Escape', defaultPrevented: true }, drawerOpen: true, layout: 'split' }),
    { handled: false, shouldClose: false },
  );
  assert.deepEqual(
    resolveDrawerEscape({ event: { key: 'Escape' }, drawerOpen: true, layout: 'split', hasOpenDialog: true }),
    { handled: false, shouldClose: false },
  );

  // Whole-workspace file drop guard
  assert.equal(canAcceptWorkspaceDrop({ page: 'clipping', hasFiles: true }), true);
  assert.equal(canAcceptWorkspaceDrop({ page: 'clipping', hasFiles: false }), false);
  assert.equal(canAcceptWorkspaceDrop({ page: 'exports', hasFiles: true }), false);
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
      querySelectorAll(selector) {
        const matches = [];
        const matchOne = (node) => {
          if (selector.startsWith('.')) {
            const needed = selector.slice(1).split('.').filter(Boolean);
            const classes = node.className.split(/\s+/);
            return needed.every((cls) => classes.includes(cls));
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

test('sidebar library rows render collapsed rail cell (HH:MM + status dot + New dot), row basename tooltip, and live New badge updates', () => {
  const doc = createFakeDocument();
  const listContainer = doc.createElement('div');

  const view = createRecordingLibraryView({
    listContainer,
    doc,
    showActions: false,
    showSize: false,
    translate: makeTranslate('zh'),
  });

  const rawItems = [
    {
      id: 'id-1',
      filename: '/Users/player/Videos/2026-11-26_15-08_Olympus.mkv',
      recordedAtMs: new Date(2026, 10, 26, 15, 8).getTime(),
      durationSeconds: 1120,
      status: 'ready',
      candidateCount: 7,
    },
    {
      id: 'id-2',
      filename: 'C:\\OBS\\2026-11-26_14-36_WorldsEdge.mp4',
      recordedAtMs: new Date(2026, 10, 26, 14, 36).getTime(),
      durationSeconds: 855,
      status: 'conformed-coarse',
      candidateCount: 5,
    },
  ];

  view.render(projectRecordingLibrary({
    items: rawItems,
    activeSourceId: 'id-1',
    newIds: new Set(['id-2']),
  }));

  const rows = listContainer.querySelectorAll('.file.library-row');
  assert.equal(rows.length, 2);

  // Row 0: active, NOT new
  assert.equal(rows[0].title, '2026-11-26_15-08_Olympus.mkv', 'Collapsed rail hover tooltip must preserve full basename');
  assert.equal(rows[0].dataset.new, 'false');
  assert.equal(rows[0].querySelector('.library-new-badge').hidden, true);
  const rail0 = rows[0].querySelector('.library-rail-cell');
  assert.ok(rail0, 'Sidebar row must include compact rail cell');
  assert.equal(rail0.querySelector('.library-rail-time').textContent, '15:08');
  assert.equal(rail0.querySelector('.library-rail-dot').dataset.status, 'ready');
  assert.equal(rail0.querySelector('.library-rail-new-dot').hidden, true);

  // Row 1: coarse + New badge + New rail dot
  assert.equal(rows[1].title, '2026-11-26_14-36_WorldsEdge.mp4');
  assert.equal(rows[1].dataset.new, 'true');
  assert.equal(rows[1].querySelector('.library-new-badge').hidden, false);
  assert.equal(rows[1].querySelector('.library-new-badge').textContent, '新');
  const rail1 = rows[1].querySelector('.library-rail-cell');
  assert.equal(rail1.querySelector('.library-rail-time').textContent, '14:36');
  assert.equal(rail1.querySelector('.library-rail-dot').dataset.status, 'conformed-coarse');
  assert.equal(rail1.querySelector('.library-rail-new-dot').hidden, false);

  // Opening row 1 clears its New badge & New rail dot
  view.render(projectRecordingLibrary({
    items: rawItems,
    activeSourceId: 'id-2',
    newIds: new Set(),
  }));
  assert.equal(rows[1].dataset.new, 'false');
  assert.equal(rows[1].querySelector('.library-new-badge').hidden, true);
  assert.equal(rows[1].querySelector('.library-rail-new-dot').hidden, true);
});

test('index.html and i18n provide collapsible sidebar, narrow drawer, whole-workspace drop cue, and 2-step empty onboarding without forbidden terms', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(testDir, '../../../site');
  const html = readFileSync(path.join(siteDir, 'index.html'), 'utf8');

  assert.match(html, /id="sidebar-collapse-toggle"/);
  assert.match(html, /id="library-drawer-toggle"/);
  assert.match(html, /id="library-drawer-backdrop"/);
  assert.match(html, /id="library-drawer-close"/);
  assert.match(html, /id="workspace-drop-overlay"/);
  assert.match(html, /id="empty-onboarding"/);
  assert.match(html, /id="onboarding-choose-watch-dir"/);
  assert.match(html, /id="onboarding-toggle-monitoring"/);
  assert.match(html, /data-onboarding-action="choose-watch-dir"/);
  assert.match(html, /data-onboarding-action="toggle-monitoring"/);
  assert.equal(/class="[^"]*\bworkflow-guide\b/.test(html), false, 'Must not introduce legacy .workflow-guide class');

  // Verify bilingual copy matches Ticket #65 & ADR 0010 terminology
  assert.equal(translations.zh.import_files, '导入视频');
  assert.equal(translations.en.import_files, 'Import Videos');
  assert.equal(translations.zh.onboarding_step1_cta, '选择录像监听目录');
  assert.equal(translations.en.onboarding_step1_cta, 'Choose Watch Folder');
  assert.equal(translations.zh.onboarding_step2_cta, '开启对局监听');
  assert.equal(translations.en.onboarding_step2_cta, 'Start Live Monitoring');
  assert.ok(translations.zh.sidebar_collapse_title);
  assert.ok(translations.en.sidebar_collapse_title);
  assert.ok(translations.zh.sidebar_expand_title);
  assert.ok(translations.en.sidebar_expand_title);
  assert.ok(translations.zh.drawer_open_label);
  assert.ok(translations.en.drawer_open_label);
  assert.ok(translations.zh.workspace_drop_hint);
  assert.ok(translations.en.workspace_drop_hint);

  for (const [lang, dict] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(
        /分析队列|analysis queue|录像库页|复核页|实时伴随模式|实时伴随代理|内置录屏器|已确认高光|击杀片段/i.test(value),
        false,
        `${lang}.${key} contains forbidden domain term: ${value}`,
      );
    }
  }
});

test('mountSplitWorkspacePreview marks non-active recordings as New, supports simulating new drops without switching, and wires empty onboarding slots', async () => {
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
  const ux = createWorkspaceUxController({ storage: createMemoryStorage() });
  let activeId = null;
  let onboardingHandlers = null;
  let onboardingState = null;

  const fakeApp = {
    workspace,
    bindings,
    async openReview(id) {
      activeId = id;
      ux.onRecordingOpened(id);
    },
    markRecordingNew(id) {
      return ux.markRecordingNew(id, { activeSourceId: activeId });
    },
    clearRecordingNew(id) {
      return ux.clearRecordingNew(id);
    },
    setSidebarCollapsed(val) {
      return ux.setSidebarCollapsed(val);
    },
    openLibraryDrawer() {
      return ux.openDrawer();
    },
    setOnboardingHandlers(handlers) {
      onboardingHandlers = handlers;
    },
    setOnboardingState(state) {
      onboardingState = state;
    },
    get activeSourceId() { return activeId; },
    render() {},
  };

  // Mixed scenario marks secondary items as New and supports simulating a new recording drop without switching
  const mixedHarness = await mountSplitWorkspacePreview(fakeApp, {
    scenario: 'mixed',
    search: '?workspacePreview=mixed&sidebar=collapsed',
    doc,
  });
  assert.equal(ux.sidebarCollapsed, true, 'URL modifier &sidebar=collapsed collapses sidebar in preview');
  assert.ok(activeId);
  assert.equal(ux.isRecordingNew(activeId), false, 'Initially opened recording must not keep New badge');
  assert.ok(ux.newCount >= 1, 'Mixed preview must showcase New badge on non-active recording(s)');

  const activeBeforeDrop = activeId;
  const countBeforeDrop = currentView.sources.length;
  const droppedId = mixedHarness.simulateNewRecording();
  assert.ok(droppedId);
  assert.equal(currentView.sources.length, countBeforeDrop + 1);
  assert.equal(activeId, activeBeforeDrop, 'Simulating a new recording drop must NOT switch active recording');
  assert.equal(ux.isRecordingNew(droppedId), true, 'Newly added recording receives New badge');
  mixedHarness.dispose();

  // Empty scenario wires interactive mock onboarding handlers for Step 1 & Step 2
  const emptyWorkspace = createReviewWorkspace();
  onboardingHandlers = null;
  onboardingState = null;
  const emptyApp = {
    ...fakeApp,
    workspace: emptyWorkspace,
    bindings: new Map(),
  };
  const emptyHarness = await mountSplitWorkspacePreview(emptyApp, {
    scenario: 'empty',
    search: '?workspacePreview=empty',
    doc,
  });
  assert.equal(typeof onboardingHandlers?.onChooseWatchDir, 'function');
  assert.equal(typeof onboardingHandlers?.onToggleMonitoring, 'function');
  onboardingHandlers.onChooseWatchDir();
  assert.equal(onboardingState?.watchDirectory?.status, 'watching');
  assert.ok(onboardingState?.watchDirectory?.name);
  onboardingHandlers.onToggleMonitoring();
  assert.equal(onboardingState?.liveMonitor?.status, 'listening');
  emptyHarness.dispose();
});
