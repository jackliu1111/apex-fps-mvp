const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
        IDBFactory.prototype[name] = function (...args) { storageTouches.push(`idb:${name}`); return original.apply(this, args); };
      }
      for (const name of ['getItem', 'setItem', 'removeItem', 'clear']) {
        const original = Storage.prototype[name];
        Storage.prototype[name] = function (...args) { storageTouches.push(`storage:${name}`); return original.apply(this, args); };
      }
    });
    await page.reload(); await page.waitForFunction(() => window.reviewApp);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false);
    await page.locator('#files').setInputFiles(process.env.MEDIA_PATH || '/Users/jackliu/.codex/artifacts/apex-fps-mvp/real-combat-sample-20261028/apex-combat-60s.mp4');
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.evaluate(async () => {
      const id = reviewApp.workspace.view().sources[0].id;
      await reviewApp.openReview(id);
      reviewApp.workspace.chooseAll(id, false);
      reviewApp.workspace.addManual(id, { start: 5, end: 10 });
    });
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true);
    await page.evaluate(async () => { await reviewApp.submitExport(); await reviewApp.exportQueue.whenIdle(); });
    const batch = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.equal(batch.status, 'completed');
    assert.ok(batch.outputs[0].bytes > 0);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true, 'A download URL alone is not a confirmed saved file');
    assert.deepEqual(await page.evaluate(() => storageTouches), []);
    let warned = false;
    page.on('dialog', async dialog => { warned = dialog.type() === 'beforeunload'; await dialog.accept(); });
    await page.reload(); await page.waitForFunction(() => window.reviewApp);
    assert.equal(warned, true);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().sources), []);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().batches), []);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false);
    assert.deepEqual(await page.evaluate(() => storageTouches), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('apex-review-navigation-v1')), 'legacy-navigation');
    assert.deepEqual(await page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('apex-review-v1');
      open.onsuccess = () => {
        const db = open.result, get = db.transaction('workspaces').objectStore('workspaces').get('workspace');
        get.onsuccess = () => { db.close(); resolve(get.result); };
      };
    })), { legacy: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realMediaAnalysisAndExport: 'passed', bytes: batch.outputs[0].bytes, leaveWarning: 'passed', refreshEmpty: 'passed', oldStorageUntouched: 'passed' }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
