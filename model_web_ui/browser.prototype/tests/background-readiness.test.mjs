import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  WATCH_DIR_DB_NAME,
  WATCH_DIR_STORE_NAME,
  createWatchDirStore,
  restorePersistedWatchDirectory,
} from '../../../site/watch-dir-store.mjs';
import {
  buildFaviconSvgDataUrl,
  createReadyNotifier,
} from '../../../site/ready-notifier.mjs';
import {
  pickFirstReviewableCandidate,
  createBackgroundReadinessController,
} from '../../../site/background-readiness-controller.mjs';
import { createLibraryIntakeControls } from '../../../site/library-intake-controls.mjs';
import { translations } from '../../../site/i18n.js';
import { createReviewWorkspace } from '../../../site/review-workspace.mjs';
import { createWorkspaceUxController } from '../../../site/split-workspace-controller.mjs';
import { selectionWindow } from '../../../site/selection-timeline.mjs';
import { createDirectoryWatcher } from '../../../site/directory-watcher.mjs';
import { createWorkspaceEngineBridge } from '../../../site/workspace-engine-bridge.mjs';
import { createBrowserAnalysis } from '../../../site/browser-analysis.mjs';

function createFakeIndexedDB({ failOpen = false, failPut = false, failGet = false } = {}) {
  const databases = new Map();
  const openedNames = [];

  function asyncRequest(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }

  return {
    databases,
    openedNames,
    open(name, version = 1) {
      openedNames.push(name);
      return asyncRequest((req) => {
        if (failOpen) {
          req.error = new DOMException('IndexedDB blocked', 'SecurityError');
          req.onerror?.({ target: req });
          return;
        }
        let dbRecord = databases.get(name);
        const needsUpgrade = !dbRecord || dbRecord.version < version;
        if (!dbRecord) {
          dbRecord = { name, version, stores: new Map() };
          databases.set(name, dbRecord);
        } else if (needsUpgrade) {
          dbRecord.version = version;
        }
        const db = {
          name,
          version: dbRecord.version,
          objectStoreNames: {
            contains: (storeName) => dbRecord.stores.has(storeName),
          },
          createObjectStore(storeName) {
            if (!dbRecord.stores.has(storeName)) dbRecord.stores.set(storeName, new Map());
            return {};
          },
          transaction(storeName, _mode = 'readonly') {
            const store = dbRecord.stores.get(storeName);
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            const scheduleComplete = () => queueMicrotask(() => {
              if (!tx.error) tx.oncomplete?.({ target: tx });
            });
            return Object.assign(tx, {
              objectStore() {
                if (!store) throw new DOMException('Missing store', 'NotFoundError');
                return {
                  get(key) {
                    return asyncRequest((getReq) => {
                      if (failGet) {
                        getReq.error = new Error('read failed');
                        tx.error = getReq.error;
                        getReq.onerror?.({ target: getReq });
                        tx.onerror?.({ target: tx });
                        return;
                      }
                      getReq.result = store.has(key) ? store.get(key) : undefined;
                      getReq.onsuccess?.({ target: getReq });
                      scheduleComplete();
                    });
                  },
                  put(val, key) {
                    return asyncRequest((putReq) => {
                      if (failPut) {
                        putReq.error = new DOMException('Not cloneable', 'DataCloneError');
                        tx.error = putReq.error;
                        putReq.onerror?.({ target: putReq });
                        tx.onerror?.({ target: tx });
                        return;
                      }
                      store.set(key, val);
                      putReq.result = key;
                      putReq.onsuccess?.({ target: putReq });
                      scheduleComplete();
                    });
                  },
                  delete(key) {
                    return asyncRequest((delReq) => {
                      store.delete(key);
                      delReq.onsuccess?.({ target: delReq });
                      scheduleComplete();
                    });
                  },
                };
              },
            });
          },
          close() {},
        };
        req.result = db;
        if (needsUpgrade) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
    },
  };
}

function createFakeWatchHandle(name, { permission = 'granted', files = new Map(), onRequestPermission = null } = {}) {
  let currentPerm = permission;
  const queries = [];
  const requests = [];
  return {
    name,
    kind: 'directory',
    queries,
    requests,
    setPermission(next) { currentPerm = next; },
    async queryPermission(opts) {
      queries.push(opts);
      return currentPerm;
    },
    async requestPermission(opts) {
      requests.push(opts);
      if (typeof onRequestPermission === 'function') {
        currentPerm = await onRequestPermission(opts);
      }
      return currentPerm;
    },
    async *entries() {
      for (const [fileName, file] of files.entries()) {
        yield [fileName, { kind: 'file', async getFile() { return file; } }];
      }
    },
  };
}

function createMinimalBridge({ watchDirStore = null, showDirectoryPicker = null } = {}) {
  const fakeMB = { ALL_FORMATS: [], BlobSource: class {}, Input: class { dispose() {} } };
  const queue = createBrowserAnalysis({
    MB: fakeMB,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ classes: ['Gunshot, gunfire', 'Machine gun'] }) }),
  });
  const bridge = createWorkspaceEngineBridge({
    MB: fakeMB,
    queue,
    watchDirStore,
    isSecureContext: () => true,
    showDirectoryPicker,
    autoIntakeOptions: { pollIntervalMs: 60_000, stablePollsRequired: 2 },
  });
  return {
    bridge,
    async dispose() {
      await bridge.dispose();
      await queue.dispose();
    },
  };
}

test('Slice 1: watch-dir-store persists read-only handle in dedicated apex-watch-dir-v1 DB and handles blocked/missing IndexedDB safely', async () => {
  const fakeIdb = createFakeIndexedDB();
  const store = createWatchDirStore({ indexedDB: fakeIdb });
  const handle = createFakeWatchHandle('OBS Captures');

  assert.equal(await store.load(), null);
  assert.equal(await store.save(handle), true);
  assert.deepEqual(new Set(fakeIdb.openedNames), new Set([WATCH_DIR_DB_NAME]));
  assert.equal(fakeIdb.databases.has('apex-review-v1'), false, 'Must never touch legacy apex-review-v1 DB');
  assert.ok(fakeIdb.databases.get(WATCH_DIR_DB_NAME).stores.has(WATCH_DIR_STORE_NAME));

  const loaded = await store.load();
  assert.equal(loaded, handle);
  assert.equal(await store.clear(), true);
  assert.equal(await store.load(), null);

  // Gracefully handles missing or blocked IndexedDB without throwing
  const unavailable = createWatchDirStore({ indexedDB: null });
  assert.equal(await unavailable.load(), null);
  assert.equal(await unavailable.save(handle), false);
  assert.equal(await unavailable.clear(), false);

  const blocked = createWatchDirStore({ indexedDB: createFakeIndexedDB({ failOpen: true }) });
  assert.equal(await blocked.load(), null);
  assert.equal(await blocked.save(handle), false);

  const nonCloneable = createWatchDirStore({ indexedDB: createFakeIndexedDB({ failPut: true }) });
  assert.equal(await nonCloneable.save(handle), false);
});

test('Slice 1: startup auto-restore silently starts watching on granted permission and surfaces one-click Restore Watch on prompt', async (t) => {
  const fakeIdb = createFakeIndexedDB();
  const store = createWatchDirStore({ indexedDB: fakeIdb });

  // 1. User picks a watch folder -> engineBridge persists handle automatically
  const pickedHandle = createFakeWatchHandle('/Users/player/Videos/Apex OBS/', { permission: 'granted' });
  const session1 = createMinimalBridge({
    watchDirStore: store,
    showDirectoryPicker: async () => pickedHandle,
  });
  t.after(() => session1.dispose());

  await session1.bridge.chooseWatchDirectory();
  assert.equal(session1.bridge.watchDirState.status, 'watching');
  assert.equal(await store.load(), pickedHandle, 'Choosing watch directory must persist handle');

  // 2. Reload with permission still 'granted' -> silent auto-restore with ZERO clicks
  const session2 = createMinimalBridge({ watchDirStore: store });
  t.after(() => session2.dispose());

  const silentResult = await restorePersistedWatchDirectory({ store, engineBridge: session2.bridge });
  assert.equal(silentResult.outcome, 'restored');
  assert.equal(session2.bridge.watchDirState.status, 'watching');
  assert.equal(session2.bridge.watchDirState.name, 'Apex OBS');
  assert.equal(session2.bridge.watchDirState.needsRestore, false);
  assert.deepEqual(pickedHandle.queries.at(-1), { mode: 'read' });
  assert.equal(pickedHandle.requests.length, 0, 'Silent granted restore must not prompt requestPermission');

  // 3. Reload when browser requires re-authorization ('prompt') -> topbar Restore Watch state
  pickedHandle.setPermission('prompt');
  let grantedOnClick = false;
  const promptHandle = createFakeWatchHandle('/Users/player/Videos/OBS Ranked/', {
    permission: 'prompt',
    onRequestPermission: async () => (grantedOnClick ? 'granted' : 'prompt'),
  });
  await store.save(promptHandle);

  const session3 = createMinimalBridge({ watchDirStore: store });
  t.after(() => session3.dispose());

  const promptResult = await restorePersistedWatchDirectory({ store, engineBridge: session3.bridge });
  assert.equal(promptResult.outcome, 'needs-permission');
  assert.equal(session3.bridge.watchDirState.status, 'needs-permission');
  assert.equal(session3.bridge.watchDirState.needsRestore, true);
  assert.equal(session3.bridge.watchDirState.name, 'OBS Ranked');
  assert.equal(promptHandle.requests.length, 0, 'Startup must NOT call requestPermission without user click');

  // Dismissing permission prompt keeps needs-permission restore CTA ready to retry
  await assert.rejects(() => session3.bridge.restoreWatchDirectory());
  assert.equal(session3.bridge.watchDirState.status, 'needs-permission');
  assert.equal(session3.bridge.watchDirState.needsRestore, true);

  // One-click Restore Watch approves read permission -> resumes watching immediately
  grantedOnClick = true;
  await session3.bridge.restoreWatchDirectory();
  assert.equal(session3.bridge.watchDirState.status, 'watching');
  assert.equal(session3.bridge.watchDirState.needsRestore, false);
  assert.deepEqual(promptHandle.requests.at(-1), { mode: 'read' });
});

test('Slice 1 regression: denied/failed restore still allows switching Watch Folder via topbar button & onboarding, and NotFoundError clears stale handle cleanly', async (t) => {
  const fakeIdb = createFakeIndexedDB();
  const store = createWatchDirStore({ indexedDB: fakeIdb });

  // 1) Denied persisted handle leaves status in needs-permission after restore fails
  const deniedHandle = createFakeWatchHandle('Old OBS Folder', {
    permission: 'prompt',
    onRequestPermission: async () => 'denied',
  });
  const freshHandle = createFakeWatchHandle('New OBS Folder', { permission: 'granted' });
  await store.save(deniedHandle);

  let pickerCalls = 0;
  const sessionA = createMinimalBridge({
    watchDirStore: store,
    showDirectoryPicker: async () => {
      pickerCalls++;
      return freshHandle;
    },
  });
  t.after(() => sessionA.dispose());

  const startupA = await restorePersistedWatchDirectory({ store, engineBridge: sessionA.bridge });
  assert.equal(startupA.outcome, 'needs-permission');
  assert.equal(sessionA.bridge.watchDirState.status, 'needs-permission');

  // Wire global topbar controls with separate choose vs restore handlers (matching app.js)
  const byId = new Map();
  const makeBtn = (tag, id) => {
    const node = {
      tagName: tag.toUpperCase(),
      id,
      textContent: '',
      title: '',
      hidden: false,
      disabled: false,
      dataset: {},
      attributes: {},
      onclick: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null; },
      click() { if (!this.disabled && typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {} }); },
    };
    byId.set(id, node);
    return node;
  };
  makeBtn('div', 'sidebar-watch-dir');
  makeBtn('button', 'sidebar-watch-btn');
  makeBtn('span', 'sidebar-watch-value');
  makeBtn('button', 'sidebar-watch-restore-cta');

  let restoreClicks = 0;
  let chooseClicks = 0;
  const controls = createLibraryIntakeControls({
    doc: {
      getElementById: (id) => byId.get(id) || null,
      addEventListener() {},
      removeEventListener() {},
    },
    onChooseWatchDir: () => { chooseClicks++; },
    onRestoreWatchDir: () => { restoreClicks++; },
  });
  t.after(() => controls.dispose());
  controls.render(sessionA.bridge.getState());

  // Clicking #sidebar-watch-restore-cta triggers restore; clicking #sidebar-watch-btn triggers choose!
  byId.get('sidebar-watch-restore-cta').click();
  assert.equal(restoreClicks, 1, 'Restore CTA must route to restoreWatchDirectory');
  assert.equal(chooseClicks, 0);

  byId.get('sidebar-watch-btn').click();
  assert.equal(chooseClicks, 1, 'Main watch button must route to chooseWatchDirectory even during needs-permission');
  assert.equal(restoreClicks, 1);

  // Restore fails when permission is denied
  await assert.rejects(() => sessionA.bridge.restoreWatchDirectory());
  assert.equal(sessionA.bridge.watchDirState.status, 'needs-permission');

  // Choosing a new folder via chooseWatchDirectory (used by #topbar-watch-btn and #onboarding-choose-watch-dir)
  // MUST break out of needs-permission, start watching the new folder, and persist the new handle!
  await sessionA.bridge.chooseWatchDirectory();
  assert.equal(pickerCalls, 1);
  assert.equal(sessionA.bridge.watchDirState.status, 'watching');
  assert.equal(sessionA.bridge.watchDirState.needsRestore, false);
  assert.equal(sessionA.bridge.watchDirState.name, 'New OBS Folder');
  assert.equal(await store.load(), freshHandle);

  // 2) Deleted/unmounted folder throwing NotFoundError during restoreWatchDirectory clears stale handle & pending flag
  const deletedHandle = createFakeWatchHandle('Deleted Drive Folder', {
    permission: 'prompt',
    onRequestPermission: async () => {
      throw new DOMException('Directory not found', 'NotFoundError');
    },
  });
  await store.save(deletedHandle);
  const sessionB = createMinimalBridge({ watchDirStore: store });
  t.after(() => sessionB.dispose());

  await restorePersistedWatchDirectory({ store, engineBridge: sessionB.bridge });
  assert.equal(sessionB.bridge.watchDirState.status, 'needs-permission');

  await assert.rejects(() => sessionB.bridge.restoreWatchDirectory(), (err) => err?.name === 'NotFoundError');
  assert.equal(sessionB.bridge.watchDirState.status, 'unset', 'NotFoundError must clear needs-permission loop');
  assert.equal(sessionB.bridge.watchDirState.needsRestore, false);
  assert.equal(sessionB.bridge.watchDirState.name, null);
  assert.equal(await store.load(), null, 'NotFoundError must purge stale handle from watch-dir store');

  // 3) Deleted/unmounted folder throwing NotFoundError during startup silent auto-restore also clears stale handle cleanly
  const vanishedGrantedHandle = {
    name: 'Unmounted USB',
    kind: 'directory',
    async queryPermission() { return 'granted'; },
    async *entries() {
      throw new DOMException('A requested file or directory could not be found', 'NotFoundError');
    },
  };
  await store.save(vanishedGrantedHandle);
  const sessionC = createMinimalBridge({ watchDirStore: store });
  t.after(() => sessionC.dispose());

  const startupC = await restorePersistedWatchDirectory({ store, engineBridge: sessionC.bridge });
  assert.equal(startupC.outcome, 'empty', 'Startup NotFoundError must not leave needs-permission loop');
  assert.equal(sessionC.bridge.watchDirState.status, 'unset');
  assert.equal(sessionC.bridge.watchDirState.needsRestore, false);
  assert.equal(await store.load(), null, 'Startup NotFoundError must purge stale persisted handle');
});

function createFakeNotifierEnv({ initialIconHref = 'data:image/svg+xml,base-icon', permission = 'default', onRequestPermission = null } = {}) {
  const iconLink = initialIconHref !== null ? {
    tagName: 'LINK',
    rel: 'icon',
    type: 'image/svg+xml',
    href: initialIconHref,
    attributes: { rel: 'icon', href: initialIconHref },
    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'href') this.href = String(val);
      if (name === 'rel') this.rel = String(val);
      if (name === 'type') this.type = String(val);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
  } : null;

  const headChildren = iconLink ? [iconLink] : [];
  const doc = {
    title: 'Apex Local Cut · Local Video Clipping Workspace',
    head: {
      children: headChildren,
      appendChild(node) { headChildren.push(node); return node; },
      append(...nodes) { headChildren.push(...nodes); },
    },
    querySelector(sel) {
      if (sel.includes('icon')) {
        return headChildren.find((n) => n.rel?.includes('icon')) || null;
      }
      return null;
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        rel: '',
        type: '',
        href: '',
        attributes: {},
        setAttribute(name, val) {
          this.attributes[name] = String(val);
          if (name === 'href') this.href = String(val);
          if (name === 'rel') this.rel = String(val);
          if (name === 'type') this.type = String(val);
        },
        getAttribute(name) { return this.attributes[name] ?? null; },
      };
    },
  };

  let currentPermission = permission;
  const permissionRequests = [];
  const sentNotifications = [];
  let focusCalls = 0;

  class FakeNotification {
    static get permission() { return currentPermission; }
    static async requestPermission() {
      permissionRequests.push(Date.now());
      if (typeof onRequestPermission === 'function') {
        currentPermission = await onRequestPermission();
      }
      return currentPermission;
    }
    constructor(title, options = {}) {
      this.title = title;
      this.options = options;
      this.onclick = null;
      this.closed = false;
      sentNotifications.push(this);
    }
    close() { this.closed = true; }
  }

  const storageMap = new Map();
  const storage = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
  };

  const win = {
    focus() { focusCalls++; },
  };

  return {
    doc,
    win,
    storage,
    storageMap,
    Notification: FakeNotification,
    permissionRequests,
    sentNotifications,
    getFocusCalls: () => focusCalls,
    setPermission(next) { currentPermission = next; },
  };
}

test('Slice 2: ready-notifier updates title prefix (N), dynamic SVG favicon badge, and restores originals on clear/seen', () => {
  const env = createFakeNotifierEnv({ initialIconHref: 'data:image/svg+xml,original-brand-icon' });
  let baseTitle = 'Apex Local Cut · Local Video Clipping Workspace';

  const notifier = createReadyNotifier({
    doc: env.doc,
    Notification: env.Notification,
    storage: env.storage,
    getBaseTitle: () => baseTitle,
  });

  // Never auto-prompts Notification permission on load
  assert.equal(env.permissionRequests.length, 0);
  assert.equal(notifier.unseenCount, 0);

  // First ready recording -> title "(1) ..." + dynamic SVG favicon badge
  notifier.markReady({ sourceId: 'src-1', name: 'Match_01.mp4', candidateCount: 3 });
  assert.equal(notifier.unseenCount, 1);
  assert.equal(env.doc.title, `(1) ${baseTitle}`);
  const iconAfter1 = env.doc.querySelector('link[rel="icon"]').href;
  assert.match(iconAfter1, /^data:image\/svg\+xml,/);
  assert.notEqual(iconAfter1, 'data:image/svg+xml,original-brand-icon');
  assert.match(decodeURIComponent(iconAfter1), />1</);

  // Duplicate markReady for same sourceId is idempotent
  notifier.markReady({ sourceId: 'src-1', name: 'Match_01.mp4', candidateCount: 3 });
  assert.equal(notifier.unseenCount, 1);
  assert.equal(env.doc.title, `(1) ${baseTitle}`);

  // Second ready recording -> title "(2) ..." + count badge updates to 2
  notifier.markReady({ sourceId: 'src-2', name: 'Match_02.mp4', candidateCount: 5, isCoarse: true });
  assert.equal(notifier.unseenCount, 2);
  assert.equal(env.doc.title, `(2) ${baseTitle}`);
  assert.match(decodeURIComponent(env.doc.querySelector('link[rel="icon"]').href), />2</);

  // Language switch re-syncs title while preserving unseen count prefix
  baseTitle = 'Apex Local Cut · 本地选片工作区';
  env.doc.title = baseTitle;
  notifier.syncTitle();
  assert.equal(env.doc.title, '(2) Apex Local Cut · 本地选片工作区');

  // Marking one recording seen decrements count to (1)
  notifier.markSeen('src-1');
  assert.equal(notifier.unseenCount, 1);
  assert.equal(env.doc.title, '(1) Apex Local Cut · 本地选片工作区');

  // Marking last recording seen restores clean base title & original favicon
  notifier.markSeen('src-2');
  assert.equal(notifier.unseenCount, 0);
  assert.equal(env.doc.title, 'Apex Local Cut · 本地选片工作区');
  assert.equal(env.doc.querySelector('link[rel="icon"]').href, 'data:image/svg+xml,original-brand-icon');
  assert.equal(env.getFocusCalls(), 0, 'Silent notifications must never steal window focus');

  // Counts >= 10 cap cleanly at 9+ in favicon badge
  assert.match(decodeURIComponent(buildFaviconSvgDataUrl(12)), />9\+</);
});

test('Slice 2: ready-notifier optional browser Notification requests permission only on explicit user opt-in and emits silent alerts without stealing focus', async () => {
  let grantOnRequest = true;
  const env = createFakeNotifierEnv({
    permission: 'default',
    onRequestPermission: async () => (grantOnRequest ? 'granted' : 'denied'),
  });

  const notifier = createReadyNotifier({
    doc: env.doc,
    Notification: env.Notification,
    storage: env.storage,
    getBaseTitle: () => 'Apex Local Cut',
  });

  // Marking ready before user opts in MUST NOT request permission or emit Notification
  notifier.markReady({ sourceId: 'src-a', name: 'BeforeOptIn.mp4', candidateCount: 2 });
  assert.equal(env.permissionRequests.length, 0);
  assert.equal(env.sentNotifications.length, 0);

  // Explicit user click to enable requests permission once
  const res = await notifier.setNotificationsEnabled(true);
  assert.deepEqual(res, { enabled: true, permission: 'granted' });
  assert.equal(env.permissionRequests.length, 1);
  assert.equal(notifier.notificationsEnabled, true);

  // New ready recording emits silent system notification without stealing focus
  notifier.markReady({ sourceId: 'src-b', name: 'AfterOptIn.mp4', candidateCount: 4 });
  assert.equal(env.sentNotifications.length, 1);
  assert.equal(env.sentNotifications[0].options.silent, true);
  assert.match(env.sentNotifications[0].options.body, /AfterOptIn\.mp4/);
  assert.equal(env.getFocusCalls(), 0);

  // Disabling suppresses subsequent notifications
  await notifier.setNotificationsEnabled(false);
  notifier.markReady({ sourceId: 'src-c', name: 'MutedAlert.mp4', candidateCount: 1 });
  assert.equal(env.sentNotifications.length, 1);

  // Denied permission refuses enabling gracefully
  grantOnRequest = false;
  const deniedEnv = createFakeNotifierEnv({
    permission: 'default',
    onRequestPermission: async () => 'denied',
  });
  const deniedNotifier = createReadyNotifier({
    doc: deniedEnv.doc,
    Notification: deniedEnv.Notification,
    storage: deniedEnv.storage,
  });
  const deniedRes = await deniedNotifier.setNotificationsEnabled(true);
  assert.deepEqual(deniedRes, { enabled: false, permission: 'denied' });
  assert.equal(deniedNotifier.notificationsEnabled, false);
});

test('Slice 3: visibility-return switches to latest background-ready recording, focuses its first candidate, clears badge/count, and preserves prior manual decisions', async () => {
  const env = createFakeNotifierEnv({ permission: 'granted' });
  const workspace = createReviewWorkspace();
  const uxController = createWorkspaceUxController({ storage: null });
  const readyNotifier = createReadyNotifier({
    doc: env.doc,
    Notification: env.Notification,
    storage: env.storage,
    getBaseTitle: () => 'Apex Local Cut',
  });

  // Seed recording A with manual review decisions (ADR 0004)
  const idA = workspace.addSource({ id: 'source:A', name: 'Match_A.mp4', size: 100, lastModified: 1000, fingerprint: 'a', fingerprintVersion: 'v1', duration: 60 });
  workspace.publishCandidates(idA, [
    { start: 8, end: 14, peakScore: 0.9, provisional: false },
    { start: 30, end: 36, peakScore: 0.85, provisional: false },
  ]);
  const clipA0 = workspace.getSource(idA).clips[0];
  const clipA1 = workspace.getSource(idA).clips[1];
  const trimmedIdA = workspace.trim(idA, clipA0.id, { start: 9.5, end: 13.0 });
  const excludedIdA = workspace.exclude(idA, clipA1.id);
  const manualIdA = workspace.addManual(idA, { start: 42, end: 47 });
  const decisionsBeforeSwitch = structuredClone(workspace.getSource(idA).decisions);

  // Seed recordings B and C
  const idB = workspace.addSource({ id: 'source:B', name: 'Match_B.mp4', size: 100, lastModified: 2000, fingerprint: 'b', fingerprintVersion: 'v1', duration: 60 });
  workspace.publishCandidates(idB, [{ start: 12, end: 18, peakScore: 0.88, provisional: false }]);

  const idC = workspace.addSource({ id: 'source:C', name: 'Match_C.mp4', size: 100, lastModified: 3000, fingerprint: 'c', fingerprintVersion: 'v1', duration: 90 });
  workspace.publishCandidates(idC, [
    { start: 5, end: 9, peakScore: 0.7, provisional: true },   // provisional -> skip
    { start: 18, end: 25, peakScore: 0.92, provisional: false }, // earliest reviewable -> pick!
    { start: 40, end: 48, peakScore: 0.86, provisional: false },
  ]);

  let visibilityState = 'hidden';
  let activeSourceId = idA;
  let pollCalls = 0;
  const seeks = [];
  const toastHistory = [];

  const controller = createBackgroundReadinessController({
    getVisibilityState: () => visibilityState,
    getActiveSourceId: () => activeSourceId,
    getCurrentPage: () => 'clipping',
    hasRecording: (id) => Boolean(workspace.getSource(id)),
    readyNotifier,
    uxController,
    onPollWatchDirectory: async () => { pollCalls++; },
    onToastChange: (toast) => { toastHistory.push(toast); },
    openRecording: async (id, { focusFirstCandidate = false } = {}) => {
      activeSourceId = id;
      uxController.onRecordingOpened(id);
      if (focusFirstCandidate) {
        const saved = workspace.getSource(id);
        const first = pickFirstReviewableCandidate(saved);
        if (first) {
          workspace.setReview(id, {
            selectedClipId: first.id,
            ...selectionWindow(saved.duration, first),
            position: first.start,
          });
          seeks.push({ sourceId: id, clipId: first.id, position: first.start });
        }
      }
    },
  });

  // B and C become ready while page is hidden -> queued in background, title shows (2), no switch yet
  const rB = controller.onRecordingReady({ sourceId: idB, name: 'Match_B.mp4', candidateCount: 1, isCoarse: false });
  const rC = controller.onRecordingReady({ sourceId: idC, name: 'Match_C.mp4', candidateCount: 2, isCoarse: false });
  assert.equal(rB.action, 'queued-background');
  assert.equal(rC.action, 'queued-background');
  assert.equal(activeSourceId, idA, 'Must not switch while page is hidden');
  assert.equal(readyNotifier.unseenCount, 2);
  assert.equal(env.doc.title, '(2) Apex Local Cut');
  assert.equal(uxController.isRecordingNew(idB), true);
  assert.equal(uxController.isRecordingNew(idC), true);
  assert.equal(toastHistory.length, 0, 'Hidden arrivals must not show foreground toast');

  // Player tabs back to browser -> immediate poll + switch to latest ready C + focus first candidate!
  visibilityState = 'visible';
  const visResult = await controller.handleVisibilityChange('visible');
  assert.equal(visResult.switched, true);
  assert.equal(visResult.targetId, idC);
  assert.equal(pollCalls, 1, 'Visibility return must trigger immediate watch-directory poll');
  assert.equal(activeSourceId, idC);
  assert.equal(uxController.isRecordingNew(idC), false, 'Auto-opened latest recording clears its New badge');
  assert.equal(uxController.isRecordingNew(idB), true, 'Earlier unvisited background recording retains New badge');
  assert.equal(readyNotifier.unseenCount, 0, 'Visibility return resets unseen title/favicon count');
  assert.equal(env.doc.title, 'Apex Local Cut');

  // Verify first non-provisional candidate (18..25) was selected and seeked
  const savedC = workspace.getSource(idC);
  assert.equal(seeks.length, 1);
  assert.equal(seeks[0].sourceId, idC);
  assert.equal(seeks[0].position, 18);
  assert.equal(savedC.review.position, 18);
  assert.equal(savedC.review.selectedClipId, seeks[0].clipId);

  // Verify recording A's manual decisions remain completely untouched (ADR 0004)
  const savedA = workspace.getSource(idA);
  assert.deepEqual(savedA.decisions, decisionsBeforeSwitch);
  assert.equal(savedA.clips.some((c) => c.id === manualIdA), true);
  assert.equal(savedA.clips.find((c) => c.id === trimmedIdA).start, 9.5);
  assert.equal(savedA.clips.find((c) => c.id === excludedIdA).excluded, true);
});

test('Slice 3: foreground ready recording never interrupts active review, keeps New badge, shows clickable toast jumping to first candidate, and respects dismiss/active no-op', async () => {
  const env = createFakeNotifierEnv();
  const workspace = createReviewWorkspace();
  const uxController = createWorkspaceUxController({ storage: null });
  const readyNotifier = createReadyNotifier({
    doc: env.doc,
    Notification: env.Notification,
    storage: env.storage,
    getBaseTitle: () => 'Apex Local Cut',
  });

  const idA = workspace.addSource({ id: 'source:A', name: 'Match_A.mp4', size: 100, lastModified: 1000, fingerprint: 'a', fingerprintVersion: 'v1', duration: 60 });
  const manualIdA = workspace.addManual(idA, { start: 10, end: 15 });
  const idD = workspace.addSource({ id: 'source:D', name: 'Match_D.mp4', size: 100, lastModified: 4000, fingerprint: 'd', fingerprintVersion: 'v1', duration: 60 });
  workspace.publishCandidates(idD, [{ start: 22, end: 28, peakScore: 0.91, provisional: false }]);
  const idE = workspace.addSource({ id: 'source:E', name: 'Match_E.mp4', size: 100, lastModified: 5000, fingerprint: 'e', fingerprintVersion: 'v1', duration: 60 });

  let activeSourceId = idA;
  let latestToast = null;
  const opened = [];

  const controller = createBackgroundReadinessController({
    getVisibilityState: () => 'visible',
    getActiveSourceId: () => activeSourceId,
    getCurrentPage: () => 'clipping',
    hasRecording: (id) => Boolean(workspace.getSource(id)),
    readyNotifier,
    uxController,
    onToastChange: (toast) => { latestToast = toast; },
    openRecording: async (id, opts) => {
      activeSourceId = id;
      uxController.onRecordingOpened(id);
      const saved = workspace.getSource(id);
      const first = opts?.focusFirstCandidate ? pickFirstReviewableCandidate(saved) : null;
      if (first) {
        workspace.setReview(id, { selectedClipId: first.id, ...selectionWindow(saved.duration, first), position: first.start });
      }
      opened.push({ id, firstStart: first?.start ?? null });
    },
  });

  // Active recording finishing while visible on clipping view -> no toast, no unseen count
  const noopRes = controller.onRecordingReady({ sourceId: idA, name: 'Match_A.mp4', candidateCount: 1 });
  assert.equal(noopRes.action, 'noop-active');
  assert.equal(latestToast, null);
  assert.equal(readyNotifier.unseenCount, 0);

  // Another recording D becomes ready while visible -> NO switch, New badge stays, clickable toast shown
  const fgRes = controller.onRecordingReady({ sourceId: idD, name: 'Match_D.mp4', candidateCount: 1, isCoarse: true });
  assert.equal(fgRes.action, 'foreground-toast');
  assert.equal(activeSourceId, idA, 'Foreground ready recording MUST NOT interrupt current review');
  assert.equal(uxController.isRecordingNew(idD), true);
  assert.equal(readyNotifier.unseenCount, 1);
  assert.equal(env.doc.title, '(1) Apex Local Cut');
  assert.deepEqual(latestToast, { sourceId: idD, name: 'Match_D.mp4', candidateCount: 1, isCoarse: true });

  // Clicking "Open now" in toast switches to D, focuses first candidate (22s), clears New badge & toast & count
  assert.equal(await controller.openToastTarget(), true);
  assert.equal(activeSourceId, idD);
  assert.deepEqual(opened, [{ id: idD, firstStart: 22 }]);
  assert.equal(workspace.getSource(idD).review.position, 22);
  assert.equal(uxController.isRecordingNew(idD), false);
  assert.equal(latestToast, null);
  assert.equal(readyNotifier.unseenCount, 0);
  assert.equal(workspace.getSource(idA).clips.some((c) => c.id === manualIdA), true);

  // Dismissing toast hides toast & clears unseen title count without switching or clearing New badge
  controller.onRecordingReady({ sourceId: idE, name: 'Match_E.mp4', candidateCount: 0, isCoarse: false });
  assert.equal(latestToast?.sourceId, idE);
  assert.equal(controller.dismissToast(), true);
  assert.equal(latestToast, null);
  assert.equal(activeSourceId, idD, 'Dismiss must not switch recordings');
  assert.equal(uxController.isRecordingNew(idE), true, 'Dismissing toast keeps New badge in sidebar until opened');
  assert.equal(readyNotifier.unseenCount, 0);
});

test('Slice 4: directory-watcher wall-clock stableDurationMs fallback stabilizes on second throttled background poll while still blocking growing files', async (t) => {
  let clock = 10_000;
  const files = new Map();
  const ready = [];
  let probeCalls = 0;

  const watcher = createDirectoryWatcher({
    pollIntervalMs: 2000,
    stablePollsRequired: 2,
    now: () => clock,
    async probeFile(file) {
      probeCalls++;
      return { duration: 30, name: file.name };
    },
    onReady(item) { ready.push(item.name); },
  });
  t.after(() => watcher.stop());

  const dir = {
    name: 'OBS',
    async *entries() {
      for (const [name, meta] of files.entries()) {
        yield [name, { kind: 'file', async getFile() { return { name, ...meta }; } }];
      }
    },
  };
  await watcher.start(dir);

  // New recording arrives after watch start
  files.set('bg-throttled.mp4', { size: 4_000_000, lastModified: 10_500 });
  clock = 11_000;
  await watcher.pollNow();
  assert.equal(watcher.state.tracked[0].state, 'discovered');
  assert.equal(probeCalls, 0);

  // Background timer is throttled by Chrome for 15 seconds (>> stableDurationMs = 4000ms)
  // File stays unchanged across the 15s gap -> probes & becomes ready immediately on poll #2!
  clock = 26_000;
  await watcher.pollNow();
  assert.equal(probeCalls, 1, 'Wall-clock fallback must probe without waiting an extra 15-60s throttled poll');
  assert.deepEqual(ready, ['bg-throttled.mp4']);

  // Growing file resets stableSince and must NOT probe prematurely 1s after growth
  files.set('still-writing.mp4', { size: 1_000_000, lastModified: 27_000 });
  clock = 27_000;
  await watcher.pollNow(); // discovered
  files.set('still-writing.mp4', { size: 2_000_000, lastModified: 35_000 });
  clock = 35_000;
  await watcher.pollNow(); // growing -> resets stableSince to 35_000
  assert.equal(watcher.state.tracked.find((e) => e.name === 'still-writing.mp4').state, 'growing');

  clock = 36_000; // only 1s unchanged (< 4s) and stableCount = 1 (< 2)
  await watcher.pollNow();
  assert.equal(watcher.state.tracked.find((e) => e.name === 'still-writing.mp4').state, 'stabilizing');
  assert.deepEqual(ready, ['bg-throttled.mp4']);

  // Another throttled 6s gap unchanged -> probes & becomes ready
  clock = 42_000;
  await watcher.pollNow();
  assert.deepEqual(ready, ['bg-throttled.mp4', 'still-writing.mp4']);
});

test('Slice 4: liveMonitor AudioWorklet envelope heartbeat drives unthrottled watch-directory discovery while background timers are throttled', async (t) => {
  let clock = 1_700_000_000_000;
  const watchFiles = new Map();
  const watchDir = createFakeWatchHandle('OBS Captures', { permission: 'granted', files: watchFiles });
  let pollExecutions = 0;
  const originalEntries = watchDir.entries.bind(watchDir);
  watchDir.entries = async function* () {
    pollExecutions++;
    yield* originalEntries();
  };

  const workletNodes = [];
  const fakeMediaDevices = {
    async getDisplayMedia() {
      const audioTrack = { kind: 'audio', label: 'System Audio', addEventListener() {}, removeEventListener() {}, stop() {} };
      return {
        getTracks() { return [audioTrack]; },
        getVideoTracks() { return []; },
        getAudioTracks() { return [audioTrack]; },
        removeTrack() {},
      };
    },
    async enumerateDevices() { return []; },
  };
  class FakeAudioContext {
    constructor() { this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {}
    emitEnvelope() {
      this.port.onmessage?.({ data: { type: 'envelope', buckets: new Float32Array([0.2, 0.1, 0.2, 0.1]), silentSeconds: 0 } });
    }
  }

  const fakeMB = { ALL_FORMATS: [], BlobSource: class {}, Input: class { dispose() {} } };
  const queue = createBrowserAnalysis({
    MB: fakeMB,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ classes: ['Gunshot, gunfire', 'Machine gun'] }) }),
  });

  const bridge = createWorkspaceEngineBridge({
    MB: fakeMB,
    queue,
    now: () => clock,
    isSecureContext: () => true,
    heartbeatPollIntervalMs: 2000,
    liveMonitorOptions: {
      mediaDevices: fakeMediaDevices,
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeWorkletNode,
      now: () => clock,
    },
    autoIntakeOptions: {
      pollIntervalMs: 600_000, // simulate heavily throttled 10-min background timer
      stablePollsRequired: 2,
      stableDurationMs: 4000,
    },
  });
  t.after(async () => {
    await bridge.dispose();
    await queue.dispose();
  });

  await bridge.activateWatchDirectory(watchDir);
  await bridge.startLiveMonitor();
  const baselineEntriesCalls = pollExecutions;
  const worklet = workletNodes[0];
  assert.ok(worklet);

  // Worklet frames within 500ms do NOT spam directory polling
  clock += 500;
  worklet.emitEnvelope();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pollExecutions, baselineEntriesCalls, 'Heartbeat poll must respect heartbeatPollIntervalMs');

  // After 2000ms of audio-thread heartbeat, directory poll triggers automatically despite throttled setInterval!
  clock += 2000;
  worklet.emitEnvelope();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pollExecutions, baselineEntriesCalls + 1, 'Unthrottled AudioWorklet heartbeat must trigger background directory poll');

  // Next heartbeat 2000ms later triggers another poll cleanly
  clock += 2000;
  worklet.emitEnvelope();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pollExecutions, baselineEntriesCalls + 2);
});

test('Slice 4 regression: AudioWorklet heartbeat continues polling after 60-min ring buffer saturates at maxBuckets', async (t) => {
  let clock = 1_700_000_000_000;
  const watchFiles = new Map();
  const watchDir = createFakeWatchHandle('OBS Captures', { permission: 'granted', files: watchFiles });
  let pollExecutions = 0;
  const originalEntries = watchDir.entries.bind(watchDir);
  watchDir.entries = async function* () {
    pollExecutions++;
    yield* originalEntries();
  };

  const workletNodes = [];
  const fakeMediaDevices = {
    async getDisplayMedia() {
      const audioTrack = { kind: 'audio', label: 'System Audio', addEventListener() {}, removeEventListener() {}, stop() {} };
      return {
        getTracks() { return [audioTrack]; },
        getVideoTracks() { return []; },
        getAudioTracks() { return [audioTrack]; },
        removeTrack() {},
      };
    },
    async enumerateDevices() { return []; },
  };
  class FakeAudioContext {
    constructor() { this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {}
    emitBuckets(bucketCount) {
      this.port.onmessage?.({
        data: {
          type: 'envelope',
          buckets: new Float32Array(bucketCount * 2).fill(0.25),
          silentSeconds: 0,
        },
      });
    }
  }

  const fakeMB = { ALL_FORMATS: [], BlobSource: class {}, Input: class { dispose() {} } };
  const queue = createBrowserAnalysis({
    MB: fakeMB,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ classes: ['Gunshot, gunfire', 'Machine gun'] }) }),
  });

  // Use a 1-second rolling ring cap (50 buckets) to reach saturation deterministically.
  const bridge = createWorkspaceEngineBridge({
    MB: fakeMB,
    queue,
    now: () => clock,
    isSecureContext: () => true,
    heartbeatPollIntervalMs: 2000,
    liveMonitorOptions: {
      maxHistorySeconds: 1,
      mediaDevices: fakeMediaDevices,
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeWorkletNode,
      now: () => clock,
    },
    autoIntakeOptions: {
      pollIntervalMs: 600_000,
      stablePollsRequired: 2,
      stableDurationMs: 4000,
    },
  });
  t.after(async () => {
    await bridge.dispose();
    await queue.dispose();
  });

  await bridge.activateWatchDirectory(watchDir);
  await bridge.startLiveMonitor();
  const worklet = workletNodes[0];

  // Fill ring buffer past its 50-bucket cap so envelopeBucketCount stays pinned at 50.
  clock += 2000;
  worklet.emitBuckets(60);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bridge.liveMonitor.getState().envelopeBucketCount, 50);
  const pollsAtCap = pollExecutions;

  // Subsequent AudioWorklet frames leave envelopeBucketCount pinned at 50,
  // yet heartbeat polling MUST keep advancing past saturation!
  clock += 2000;
  worklet.emitBuckets(4);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bridge.liveMonitor.getState().envelopeBucketCount, 50);
  assert.equal(pollExecutions, pollsAtCap + 1, 'Heartbeat must keep polling after ring-buffer cap is reached');

  clock += 2000;
  worklet.emitBuckets(4);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bridge.liveMonitor.getState().envelopeBucketCount, 50);
  assert.equal(pollExecutions, pollsAtCap + 2, 'Heartbeat must continue polling indefinitely at cap');
});

test('Slice 5: sidebar intake controls expose one-click Restore Watch CTA and opt-in ready notification checkbox inside live popover', async () => {
  const byId = new Map();
  function makeNode(tag, id = null) {
    const node = {
      tagName: tag.toUpperCase(),
      id,
      textContent: '',
      title: '',
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      dataset: {},
      attributes: {},
      children: [],
      onclick: null,
      onchange: null,
      setAttribute(name, val) { this.attributes[name] = String(val); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      replaceChildren(...nodes) { this.children = nodes; },
      contains(target) { return target === this || this.children.some((c) => c.contains?.(target)); },
      click() { if (!this.disabled && typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {} }); },
    };
    if (id) byId.set(id, node);
    return node;
  }

  for (const [tag, id] of [
    ['div', 'sidebar-intake-controls'],
    ['div', 'sidebar-watch-dir'],
    ['button', 'sidebar-watch-btn'],
    ['span', 'sidebar-watch-label'],
    ['span', 'sidebar-watch-value'],
    ['span', 'sidebar-live-pill'],
    ['span', 'sidebar-live-alert'],
    ['button', 'sidebar-watch-restore-cta'],
    ['button', 'sidebar-intake-settings-btn'],
    ['div', 'sidebar-intake-popover'],
    ['span', 'sidebar-popover-watch-status'],
    ['span', 'sidebar-popover-watch-name'],
    ['button', 'sidebar-popover-watch-choose'],
    ['button', 'sidebar-popover-watch-restore'],
    ['button', 'sidebar-popover-watch-stop'],
    ['input', 'sidebar-auto-analyze'],
    ['div', 'sidebar-live-section'],
    ['span', 'sidebar-popover-live-status'],
    ['p', 'sidebar-popover-notice'],
    ['button', 'sidebar-live-toggle'],
    ['p', 'sidebar-live-hint'],
    ['input', 'sidebar-ready-notify'],
    ['small', 'sidebar-ready-notify-hint'],
  ]) {
    makeNode(tag, id);
  }
  byId.get('sidebar-watch-restore-cta').hidden = true;
  byId.get('sidebar-ready-notify-hint').hidden = true;

  const doc = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  let activateCalls = 0;
  const notifyToggles = [];
  const translate = (key, params = {}) => {
    let text = translations.zh[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };

  const controls = createLibraryIntakeControls({
    doc,
    translate,
    onActivateWatchDir: () => { activateCalls++; },
    onToggleReadyNotifications: (val) => { notifyToggles.push(val); },
  });

  controls.render({
    liveMonitor: { status: 'off', active: false, canToggle: true },
    watchDirectory: { status: 'needs-permission', name: 'OBS Captures', canChoose: true },
    readyNotifications: { enabled: false, permission: 'default' },
  });

  assert.equal(byId.get('sidebar-watch-dir').dataset.watchStatus, 'needs-permission');
  assert.equal(byId.get('sidebar-watch-value').textContent, 'OBS Captures');
  assert.equal(byId.get('sidebar-watch-restore-cta').hidden, false);
  assert.equal(byId.get('sidebar-watch-restore-cta').textContent, '恢复监听');

  byId.get('sidebar-watch-btn').click();
  assert.equal(activateCalls, 1);

  // Restored watching state hides Restore Watch CTA
  controls.render({
    liveMonitor: { status: 'off', active: false, canToggle: true },
    watchDirectory: { status: 'watching', name: 'OBS Captures', canChoose: true },
    readyNotifications: { enabled: true, permission: 'granted' },
  });
  assert.equal(byId.get('sidebar-watch-restore-cta').hidden, true);
  assert.equal(byId.get('sidebar-ready-notify').checked, true);
  assert.equal(byId.get('sidebar-ready-notify-hint').hidden, true);

  // Toggling opt-in ready notification checkbox fires callback cleanly
  byId.get('sidebar-ready-notify').checked = false;
  byId.get('sidebar-ready-notify').onchange();
  assert.deepEqual(notifyToggles, [false]);

  // Denied permission displays hint inside popover
  controls.render({
    liveMonitor: { status: 'off', active: false, canToggle: true },
    watchDirectory: { status: 'watching', name: 'OBS Captures', canChoose: true },
    readyNotifications: { enabled: false, permission: 'denied' },
  });
  assert.equal(byId.get('sidebar-ready-notify-hint').hidden, false);
  assert.ok(byId.get('sidebar-ready-notify-hint').textContent.length > 0);
  controls.dispose();
});

test('Slice 5: index.html and i18n wire #62 restore CTA, ready toast, favicon, and opt-in notification controls with CONTEXT.md terminology', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(testDir, '../../../site');
  const html = readFileSync(path.join(siteDir, 'index.html'), 'utf8');

  assert.match(html, /id="app-favicon"/);
  assert.match(html, /id="sidebar-watch-restore-cta"/);
  assert.match(html, /id="sidebar-ready-notify"/);
  assert.match(html, /id="ready-toast"/);
  assert.match(html, /id="ready-toast-open"/);
  assert.match(html, /id="ready-toast-dismiss"/);

  for (const key of [
    'topbar_watch_restore_cta',
    'ready_notify_toggle_label',
    'ready_toast_open',
    'ready_toast_dismiss_aria',
    'ready_notification_title',
    'note_watch_dir_restored',
    'note_visibility_switched',
  ]) {
    assert.ok(translations.en[key], `Missing EN translation: ${key}`);
    assert.ok(translations.zh[key], `Missing ZH translation: ${key}`);
  }
});

test('Slice 5 E2E: visibility-return handles 0-candidate ready recording cleanly and notification click opens target with first candidate', async () => {
  const env = createFakeNotifierEnv({ permission: 'granted' });
  const workspace = createReviewWorkspace();
  const uxController = createWorkspaceUxController({ storage: null });
  const clickedTargets = [];

  const readyNotifier = createReadyNotifier({
    doc: env.doc,
    Notification: env.Notification,
    storage: env.storage,
    getBaseTitle: () => 'Apex Local Cut',
    onNotificationClick: ({ sourceId }) => clickedTargets.push(sourceId),
  });
  await readyNotifier.setNotificationsEnabled(true);

  const idZero = workspace.addSource({
    id: 'source:zero',
    name: 'Quiet_Match.mp4',
    size: 100,
    lastModified: 1000,
    fingerprint: 'z',
    fingerprintVersion: 'v1',
    duration: 45,
  });
  let visibility = 'hidden';
  let activeId = null;
  let openCalls = [];

  const controller = createBackgroundReadinessController({
    getVisibilityState: () => visibility,
    getActiveSourceId: () => activeId,
    hasRecording: (id) => Boolean(workspace.getSource(id)),
    readyNotifier,
    uxController,
    openRecording: async (id, opts) => {
      activeId = id;
      uxController.onRecordingOpened(id);
      const first = opts?.focusFirstCandidate ? pickFirstReviewableCandidate(workspace.getSource(id)) : null;
      openCalls.push({ id, first });
    },
  });

  controller.onRecordingReady({ sourceId: idZero, name: 'Quiet_Match.mp4', candidateCount: 0, isCoarse: false });
  assert.equal(env.sentNotifications.length, 1);
  assert.equal(env.sentNotifications[0].options.silent, true);
  env.sentNotifications[0].onclick?.();
  assert.deepEqual(clickedTargets, [idZero]);

  visibility = 'visible';
  const res = await controller.handleVisibilityChange('visible');
  assert.equal(res.switched, true);
  assert.equal(res.targetId, idZero);
  assert.deepEqual(openCalls, [{ id: idZero, first: null }]);
  assert.equal(readyNotifier.unseenCount, 0);
  assert.equal(env.doc.title, 'Apex Local Cut');
});





