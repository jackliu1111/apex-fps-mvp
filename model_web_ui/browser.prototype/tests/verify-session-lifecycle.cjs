const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Spec-mandated non-session preference/handle stores only (ADR 0009, ADR 0010, #62, #65).
// Review state, clips, waveforms, and export batches MUST stay strictly in-memory for the current session.
const ALLOWED_LOCAL_STORAGE_KEYS = new Set([
  'apex_local_cut_lang',
  'apex_local_cut_library_collapsed',
  'apex_local_cut_ready_notifications',
  'apex_local_cut_auto_analyze_uncovered',
]);
const ALLOWED_IDB_DATABASES = new Set([
  'apex-watch-dir-v1',
]);

function assertAllowedStorageTouches(touches, phase) {
  for (const touch of touches) {
    if (touch.kind === 'storage') {
      assert.notEqual(touch.op, 'clear', `[${phase}] Unexpected Storage.clear()`);
      assert.equal(
        ALLOWED_LOCAL_STORAGE_KEYS.has(touch.key),
        true,
        `[${phase}] Disallowed Web Storage access: ${JSON.stringify(touch)}`,
      );
    } else if (touch.kind === 'idb') {
      assert.equal(touch.op, 'open', `[${phase}] Disallowed IndexedDB operation: ${JSON.stringify(touch)}`);
      assert.equal(
        ALLOWED_IDB_DATABASES.has(touch.key),
        true,
        `[${phase}] Disallowed IndexedDB database access: ${JSON.stringify(touch)}`,
      );
    } else {
      assert.fail(`[${phase}] Unknown storage touch: ${JSON.stringify(touch)}`);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:18796');
    await page.waitForFunction(() => window.reviewApp);
    // Seed old records in an isolated test context: the new app must neither read nor erase them.
    await page.evaluate(async () => {
      localStorage.setItem('apex-review-navigation-v1', 'legacy-navigation');
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('apex-review-v1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('workspaces');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('workspaces', 'readwrite');
          tx.objectStore('workspaces').put({ legacy: true }, 'workspace');
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.addInitScript(() => {
      window.storageTouches = [];
      for (const name of ['open', 'deleteDatabase']) {
        const original = IDBFactory.prototype[name];
        IDBFactory.prototype[name] = function (...args) {
          window.storageTouches.push({ kind: 'idb', op: name, key: args[0] ?? null });
          return original.apply(this, args);
        };
      }
      for (const name of ['getItem', 'setItem', 'removeItem', 'clear']) {
        const original = Storage.prototype[name];
        Storage.prototype[name] = function (...args) {
          window.storageTouches.push({ kind: 'storage', op: name, key: args[0] ?? null });
          return original.apply(this, args);
        };
      }
    });
    await page.reload(); await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.watchDirRestoreReady);
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('session-watch-test', { create: true });
      window.showDirectoryPicker = async () => dir;
    });
    await page.locator('#sidebar-watch-btn').click();
    await page.locator('#sidebar-watch-dir[data-watch-status="watching"]').waitFor();
    // Replace only the system picker; use genuine browser-managed directory/file streams.
    await page.evaluate(async () => {
      window.testDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle('session-export-test', { create: true });
      window.pickerCalls = 0;
      window.showDirectoryPicker = async () => { window.pickerCalls++; return window.testDirectory; };
    });
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false);
    const mediaPath = process.env.MEDIA_PATH || '/Users/jackliu/.codex/artifacts/apex-fps-mvp/real-combat-sample-20261028/apex-combat-60s.mp4';
    await page.locator('#files').setInputFiles(mediaPath);
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.evaluate(async () => {
      const id = reviewApp.workspace.view().sources[0].id;
      await reviewApp.openReview(id);
      reviewApp.workspace.chooseAll(id, false);
    });
    await page.locator('#quick-manual').click();
    const target = await page.evaluate(() => {
      const id = reviewApp.activeSourceId;
      const source = reviewApp.workspace.getSource(id);
      return { id, clip: source.review.selectedClipId };
    });
    assert.ok(target.clip?.startsWith('manual:'));
    const dialogEvent = page.waitForEvent('dialog');
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    const dialog = await dialogEvent;
    assert.equal(dialog.type(), 'beforeunload');
    await dialog.dismiss();
    const focusedDecision = () => page.evaluate(() => {
      const id = reviewApp.activeSourceId;
      const source = reviewApp.workspace.getSource(id);
      const clip = source.review.selectedClipId;
      return { id, clip, selected: source.clips.find(item => item.id === clip)?.selected };
    });
    await page.locator('#toggle-current-clip').click();
    assert.deepEqual(await focusedDecision(), { ...target, selected: false });
    await page.locator('#toggle-current-clip').click();
    assert.deepEqual(await focusedDecision(), { ...target, selected: true });
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true);
    await page.locator('#export').click();
    await page.waitForFunction(() => { const batch = reviewApp.workspace.view().batches[0]; return ['completed', 'failed'].includes(batch?.status) || (batch?.status === 'awaiting-destination' && batch.error); }, null, { timeout: 120000 });
    const batch = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.equal(batch.status, 'completed', JSON.stringify(batch));
    assert.ok(batch.outputs[0].bytes > 0);
    assert.equal(await page.evaluate(() => pickerCalls), 1, 'Every export needs a directory, including a small clip');
    assert.equal(batch.outputs[0].saved, true);
    assert.equal(await page.locator('#export-batches a[download]').count(), 0);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false, 'Completed saved files do not warn on leave');
    const digest = async (fileName) => page.evaluate(async name => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('session-export-test');
      const file = await (await directory.getFileHandle(name)).getFile();
      const bytes = await file.arrayBuffer();
      return { length: bytes.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) };
    }, fileName);
    const saved = await digest(batch.outputs[0].name);
    assert.equal(saved.length, batch.outputs[0].bytes);
    const beforeSaveReloadTouches = await page.evaluate(() => window.storageTouches);
    assertAllowedStorageTouches(beforeSaveReloadTouches, 'through export');
    assert.equal(beforeSaveReloadTouches.some(t => t.kind === 'storage' && t.op === 'setItem'), false);
    const cleanDialogs = [];
    const onCleanDialog = async dialog => { cleanDialogs.push(dialog.type()); await dialog.accept(); };
    page.on('dialog', onCleanDialog);
    await page.reload();
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.watchDirRestoreReady);
    page.off('dialog', onCleanDialog);
    assert.deepEqual(cleanDialogs, []);
    assert.deepEqual(await digest(batch.outputs[0].name), saved);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().sources), []);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().batches), []);
    assert.equal(await page.locator('#sidebar-watch-value').innerText(), 'session-watch-test');
    await page.locator('#files').setInputFiles(mediaPath);
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.locator('#queue .file').first().click();
    await page.evaluate(() => {
      const id = reviewApp.activeSourceId;
      const duration = reviewApp.workspace.getSource(id).duration;
      const range = duration >= 18 ? { start: 15, end: 17 } : { start: Math.max(0.5, duration - 3), end: Math.max(1.5, duration - 1) };
      reviewApp.workspace.addManual(id, range);
    });
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true, 'Unsubmitted manual decisions still warn on leave');
    const preReloadTouches = await page.evaluate(() => window.storageTouches);
    assertAllowedStorageTouches(preReloadTouches, 'pre-reload');
    assert.equal(
      preReloadTouches.some((t) => t.kind === 'storage' && t.op === 'setItem'),
      false,
      'Importing, reviewing, and exporting must not write any session state to Web Storage',
    );
    let warned = false;
    page.on('dialog', async dialog => { warned = dialog.type() === 'beforeunload'; await dialog.accept(); });
    await page.reload(); await page.waitForFunction(() => window.reviewApp);
    assert.equal(warned, true);
    await page.evaluate(() => reviewApp.watchDirRestoreReady);
    assert.equal(await page.locator('#sidebar-watch-dir').getAttribute('data-watch-status'), 'watching');
    assert.deepEqual(await digest(batch.outputs[0].name), saved);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().sources), []);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().batches), []);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false);
    const postReloadTouches = await page.evaluate(() => window.storageTouches);
    assertAllowedStorageTouches(postReloadTouches, 'post-reload');
    const storedKeys = await page.evaluate(() => Object.keys(localStorage));
    for (const key of storedKeys) {
      assert.equal(
        key === 'apex-review-navigation-v1' || ALLOWED_LOCAL_STORAGE_KEYS.has(key),
        true,
        `Unexpected persisted localStorage key after reload: ${key}`,
      );
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('apex-review-navigation-v1')), 'legacy-navigation');
    assert.deepEqual(await page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('apex-review-v1');
      open.onsuccess = () => {
        const db = open.result, get = db.transaction('workspaces').objectStore('workspaces').get('workspace');
        get.onsuccess = () => { db.close(); resolve(get.result); };
      };
    })), { legacy: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realMediaAnalysisAndExport: 'passed', directoryWriteReadback: 'OPFS passed (picker substituted)', bytes: saved.length, sha256: Buffer.from(saved.sha256).toString('hex'), browser: browser.version(), leaveWarning: 'passed', refreshEmpty: 'passed', oldStorageUntouched: 'passed', storageBoundary: 'passed' }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
