const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function verify(browser, autoAnalyze) {
  const page = await browser.newPage();
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.watchDirRestoreReady);
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('watch', { create: true });
      const { createSyntheticFile } = await import('/tests/synthetic-media.mjs');
      window.recording = await createSyntheticFile({ duration: 6 });
      const history = await dir.getFileHandle('historical.webm', { create: true });
      const writer = await history.createWritable();
      await writer.write(await createSyntheticFile({ duration: 3 }));
      await writer.close();
      window.showDirectoryPicker = async () => dir;
      window.writeArrival = async (blob) => {
        const handle = await dir.getFileHandle('arrival.webm', { create: true });
        const writer = await handle.createWritable();
        await writer.write(blob);
        await writer.close();
      };
    });
    await page.locator('#sidebar-watch-btn').click();
    await page.locator('#sidebar-watch-dir[data-watch-status="watching"]').waitFor();
    await page.locator('#sidebar-intake-settings-btn').click();
    const toggle = page.locator('#sidebar-auto-analyze');
    assert.equal(await toggle.isChecked(), false);
    if (autoAnalyze) await toggle.check();
    await page.locator('#sidebar-intake-settings-btn').click();

    const before = await page.evaluate(async () => {
      await window.writeArrival(window.recording.slice(0, 16));
      let state;
      // More scans than the stability threshold: the incomplete container fails probing.
      for (let i = 0; i < 4; i++) state = await reviewApp.engineBridge.pollWatchDirectory();
      return { tracked: state.tracked, count: state.intakeCount };
    });
    assert.equal(before.count, 0);
    assert.deepEqual(before.tracked.map(entry => [entry.name, entry.size]), [['arrival.webm', 16]]);
    assert.notEqual(before.tracked[0].state, 'ready');
    assert.equal(await page.locator('#queue .file').count(), 0);

    const readyToAnalyze = autoAnalyze ? 'queued' : 'unanalyzed';
    if (autoAnalyze) await page.evaluate(() => reviewApp.queue.pause());
    await page.evaluate(async () => {
      await window.writeArrival(window.recording);
      for (let i = 0; i < 5; i++) await reviewApp.engineBridge.pollWatchDirectory();
    });
    const row = page.locator('#queue .file[title="arrival.webm"]');
    const badge = autoAnalyze ? '[data-phase="queued"]' : '[data-status="unanalyzed"]';
    await row.locator('.library-status-badge' + badge).waitFor();
    if (autoAnalyze) {
      await page.evaluate(() => reviewApp.queue.resume());
    } else {
      await row.click();
      await page.locator('#review-primary-action').click();
    }
    await row.locator('.library-status-badge[data-status="ready"]').waitFor({ timeout: 90000 });
    const totals = await page.evaluate(async () => {
      const state = await reviewApp.engineBridge.pollWatchDirectory();
      await reviewApp.queue.whenIdle();
      return { accepted: state.intakeCount, records: reviewApp.queue.records.map(r => [r.file.name, r.status]) };
    });
    assert.deepEqual(totals, { accepted: 1, records: [['arrival.webm', 'complete']] });
    assert.deepEqual(await page.locator('#queue .file').evaluateAll(rows => rows.map(r => r.title)), ['arrival.webm']);
    console.log(JSON.stringify({ autoAnalyze, readyToAnalyze, totals }));
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    console.log(browser.version());
    await verify(browser, false);
    await verify(browser, true);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
