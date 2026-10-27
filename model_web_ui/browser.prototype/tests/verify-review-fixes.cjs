const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8797/');
    await page.waitForFunction(() => !!window.reviewApp);
    await page.evaluate(async () => { await reviewApp.ready; await reviewApp.demo(); await reviewApp.queue.whenIdle(); });
    const imported = await page.evaluate(async () => {
      const base = reviewApp.queue.records[0].file;
      const good = new File([base], 'healthy-after-error.webm', { lastModified: 1 });
      const bad = { name: 'unreadable.webm', size: 1, lastModified: 1, slice() { return { arrayBuffer: async () => { throw new DOMException('test unreadable', 'NotReadableError'); } }; } };
      const before = reviewApp.queue.records.length;
      let error;
      try { await reviewApp.importFiles([good, bad]); } catch (failure) { error = failure.message; }
      const after = reviewApp.queue.records.length;
      await reviewApp.importFiles([good]);
      await reviewApp.queue.whenIdle();
      return { before, after, retry: reviewApp.queue.records.length, error, message: document.querySelector('#status').textContent };
    });
    assert.equal(imported.after, imported.before + 1, 'A fingerprint read failure must not block another ready file');
    assert.equal(imported.retry, imported.after, 'Retrying the healthy file must not duplicate its queue record');
    assert.match(imported.message, /unreadable.webm|已在当前工作区/, 'The failed file or later duplicate is identified');
    await page.evaluate(() => {
      const base = reviewApp.queue.records[0].file;
      let release; const gate = new Promise((resolve) => { release = resolve; });
      window.releaseSlowFingerprint = release;
      const slow = { name: 'slow-readable.webm', size: base.size, lastModified: 2, slice(start, end) { return { arrayBuffer: async () => { await gate; return base.slice(start, end).arrayBuffer(); } }; } };
      const healthy = new File([base], 'healthy-before-slow.webm', { lastModified: 2 });
      window.slowImport = reviewApp.importFiles([slow, healthy]);
    });
    await page.waitForFunction(() => reviewApp.queue.records.some((record) => record.file.name === 'healthy-before-slow.webm' && record.sourceId), null, { timeout: 10000 });
    await page.evaluate(async () => { releaseSlowFingerprint(); await slowImport; await reviewApp.queue.whenIdle(); });
    await page.evaluate(async () => {
      const id = reviewApp.queue.records[0].sourceId;
      await reviewApp.openReview(id);
      reviewApp.workspace.resetDecisions(id);
      for (let index = 0; index < 20; index++) reviewApp.workspace.addManual(id, { start: index / 100, end: 12 });
      window.pickerSeen = false;
      window.showDirectoryPicker = () => new Promise((resolve, reject) => { window.pickerSeen = true; window.cancelPicker = () => reject(new DOMException('User cancelled', 'AbortError')); });
      window.expectedSubmission = reviewApp.workspace.getSource(id).clips.filter((clip) => clip.selected && !clip.provisional).map(({ start, end }) => [start, end]);
    });
    await page.locator('#export').click();
    await page.waitForFunction(() => pickerSeen);
    const frozen = await page.evaluate(() => reviewApp.workspace.view().batches.at(-1)?.clips.map(({ start, end }) => [start, end]));
    assert.deepEqual(frozen, await page.evaluate(() => expectedSubmission), 'Submission freezes the batch before awaiting a directory picker');
    await page.evaluate(() => {
      const id = reviewApp.activeSourceId, clip = reviewApp.workspace.getSource(id).clips.find((item) => item.manual);
      reviewApp.workspace.trim(id, clip.id, { start: 1, end: 2 });
      cancelPicker();
    });
    await page.waitForFunction(() => reviewApp.workspace.view().batches.at(-1)?.status === 'cancelled');
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().batches.at(-1).clips.map(({ start, end }) => [start, end])), frozen);
    assert.equal(await page.evaluate(() => reviewApp.exportQueue.list().length), 0, 'Cancelling the destination must never start conversion');
    await page.evaluate(() => {
      const id = reviewApp.activeSourceId, ws = reviewApp.workspace;
      ws.resetDecisions(id); ws.addManual(id, { start: 0, end: 0.5 });
      ws.publishCandidates(id, [{ key: 'excluded', start: 1, end: 2 }, { key: 'normal', start: 5, end: 6 }, { key: 'pending', start: 9, end: 10, provisional: true }]);
      ws.choose(id, 'auto:excluded', false);
      ws.publishCandidates(id, [{ key: 'overlap', start: 0.8, end: 2.2 }, { key: 'normal', start: 5, end: 6 }, { key: 'pending', start: 9, end: 10, provisional: true }]);
    });
    await page.locator('#retain-all').click({ timeout: 3000 });
    await page.locator('#retain-all').click();
    const bulk = await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    assert.deepEqual(bulk.clips.filter((clip) => clip.manual).map(({ start, end }) => [start, end]), [[0, 0.5], [0.8, 2.2], [5, 6]]);
    assert.equal(bulk.decisions.some((item) => item.range.start === 9), false);
    assert.ok(bulk.decisions.some((item) => item.kind === 'exclude' && item.range.start === 1));
    await page.locator('#exclude-all').click();
    assert.match(await page.locator('#selection-summary').textContent(), /已选 0 段/);
    await page.evaluate(async () => {
      const id = reviewApp.activeSourceId, ws = reviewApp.workspace;
      ws.resetDecisions(id); ws.publishCandidates(id, []);
      for (const start of [0.1, 1, 3]) ws.addManual(id, { start, end: start + 0.5 });
      window.reviewFixDirectoryName = `review-fixes-${crypto.randomUUID()}`;
      const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle(reviewFixDirectoryName, { create: true });
      let created = 0;
      window.showDirectoryPicker = async () => ({
        name: directory.name,
        getFileHandle(name, options) {
          if (options?.create && ++created === 2) throw new DOMException('test directory full', 'QuotaExceededError');
          return directory.getFileHandle(name, options);
        },
        removeEntry: (name) => directory.removeEntry(name),
      });
    });
    await page.locator('#choose-directory').click();
    await page.waitForFunction(() => document.querySelector('#output-directory').textContent.includes('review-fixes-'));
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches.at(-1).status === 'failed');
    const partial = await page.evaluate(() => reviewApp.workspace.view().batches.at(-1));
    assert.deepEqual(partial.clipResults.map((clip) => clip.status), ['completed', 'failed', 'not-started']);
    const row = page.locator(`[data-batch-id="${partial.id}"]`);
    assert.equal(await row.locator('.clip-outcome').count(), 3);
    assert.match(await row.locator('.clip-outcome').nth(0).textContent(), /已完成/);
    assert.match(await row.locator('.clip-outcome').nth(1).textContent(), /失败/);
    assert.match(await row.locator('.clip-outcome').nth(2).textContent(), /未开始/);
    const temporaryDirectory = await page.evaluate(async () => { await reviewApp.workspace.flush(); return reviewFixDirectoryName; });
    await page.reload(); await page.waitForFunction(() => !!window.reviewApp); await page.evaluate(() => reviewApp.ready);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().batches.at(-1).clipResults.map((clip) => clip.status)), ['completed', 'failed', 'not-started']);
    assert.equal(await row.locator('.clip-outcome').count(), 3);
    await page.evaluate(async (name) => (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }), temporaryDirectory);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ isolatedImportFailures: 'passed', readyImportIndependence: 'passed', frozenBeforePicker: 'passed', bulkSelection: 'passed', partialExportAndRestore: 'passed' }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
