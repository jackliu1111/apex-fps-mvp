const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.watchDirRestoreReady);
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings', { create: true });
      const { createSyntheticFile } = await import('/tests/synthetic-media.mjs');
      const history = await dir.getFileHandle('historical.webm', { create: true });
      const writer = await history.createWritable();
      await writer.write(await createSyntheticFile({ duration: 3 }));
      await writer.close();
      window.showDirectoryPicker = async () => dir;
    });
    await page.locator('#sidebar-watch-btn').click();
    const watching = page.locator('#sidebar-watch-dir[data-watch-status="watching"]');
    await watching.waitFor();
    // Reload the persisted native OPFS handle. Control only browser permission answers.
    await page.addInitScript(() => {
      let permission = 'prompt';
      window.restoreRequests = [];
      FileSystemDirectoryHandle.prototype.queryPermission = async () => permission;
      FileSystemDirectoryHandle.prototype.requestPermission = async ({ mode }) => {
        window.restoreRequests.push(mode);
        permission = window.restoreRequests.length === 1 ? 'denied' : 'granted';
        return permission;
      };
    });
    await page.reload();
    const restore = page.locator('#sidebar-watch-restore-cta');
    await restore.waitFor();
    await restore.click();
    await page.waitForFunction(() => window.restoreRequests.length === 1 && reviewApp.watchDirState.error);
    assert.equal(await restore.isVisible(), true);
    await page.locator('#sidebar-intake-settings-btn').click();
    assert.equal(await page.locator('#sidebar-live-toggle').isDisabled(), true);
    await page.locator('#sidebar-popover-watch-restore').click();
    await watching.waitFor();
    assert.deepEqual(await page.evaluate(() => window.restoreRequests), ['read', 'read']);
    assert.equal(await page.locator('#sidebar-watch-value').innerText(), 'recordings');

    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings');
      const { createSyntheticFile } = await import('/tests/synthetic-media.mjs');
      const arrival = await dir.getFileHandle('arrival.webm', { create: true });
      const writer = await arrival.createWritable();
      await writer.write(await createSyntheticFile({ duration: 4 }));
      await writer.close();
    });
    await page.locator('#queue .file[title="arrival.webm"] .library-status-badge[data-status="unanalyzed"]').waitFor();
    assert.deepEqual(await page.locator('#queue .file').evaluateAll(rows => rows.map(row => row.title)), ['arrival.webm']);
    console.log(JSON.stringify({ browser: browser.version(), permissions: ['denied', 'granted'], rows: ['arrival.webm'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
