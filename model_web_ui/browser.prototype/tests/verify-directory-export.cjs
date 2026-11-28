const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.REVIEW_URL || 'http://127.0.0.1:18806';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.waitForFunction(() => window.reviewApp);
    if ((await page.locator('html').getAttribute('lang')) !== 'zh-CN') await page.locator('#lang-toggle').click();
    await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      await reviewApp.importFiles([await createSyntheticFile({ duration: 1 })]);
    });
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.evaluate(async () => {
      const id = reviewApp.workspace.view().sources[0].id;
      reviewApp.workspace.chooseAll(id, false);
      reviewApp.workspace.addManual(id, { start: 0, end: 0.5 });
      await reviewApp.openReview(id);
      window.showDirectoryPicker = undefined;
    });
    await page.locator('#export-format').selectOption('webm');
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches.length === 1);
    await page.evaluate(() => reviewApp.exportQueue.whenIdle());
    const batch = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.equal(batch.status, 'awaiting-destination', 'Even a small batch must await a directory');
    assert.match(batch.error, /Chrome.*Edge/);
    await page.locator('#nav-exports').click();
    assert.equal(await page.locator('.batch-outputs a[download]').count(), 0);
    assert.equal(await page.locator('#clear-directory').count(), 0);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      window.testDirectory = await root.getDirectoryHandle('directory-export-test', { create: true });
      window.pickerMode = 'cancel'; window.pickerCalls = 0; window.pickerActivations = [];
      window.permission = 'granted';
      const originalQuery = testDirectory.queryPermission.bind(testDirectory);
      testDirectory.queryPermission = options => permission === 'granted' ? originalQuery(options) : Promise.resolve(permission);
      window.showDirectoryPicker = async () => {
        pickerCalls++; pickerActivations.push(navigator.userActivation.isActive);
        if (pickerMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
        window.permission = 'granted';
        return testDirectory;
      };
    });
    await page.locator('.batch-start').click();
    await page.waitForFunction(() => /尚未选择/.test(reviewApp.workspace.view().batches[0].error));
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true);
    await page.evaluate(() => {
      pickerMode = 'select';
      const gate = Promise.withResolvers();
      window.releaseClose = gate.resolve;
      const original = testDirectory.getFileHandle.bind(testDirectory);
      testDirectory.getFileHandle = async (...args) => {
        const file = await original(...args);
        if (!args[1]?.create) return file;
        const createWritable = file.createWritable.bind(file);
        file.createWritable = async () => {
          const writer = await createWritable();
          const close = writer.close.bind(writer);
          writer.close = async () => {
            window.closingFile = file.name;
            await gate.promise;
            return close();
          };
          return writer;
        };
        return file;
      };
      window.publishedCounts = [];
      const summary = document.querySelector('.batch-summary');
      window.summaryObserver = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) publishedCounts.push(node.textContent);
        }
      });
      summaryObserver.observe(summary, { childList: true });
    });
    await page.locator('.batch-start').click();
    await page.waitForFunction(() => window.closingFile);
    assert.match(await page.locator('.batch-summary').innerText(), /已完成 0 \/ 1/);
    assert.equal(await page.locator('.output-item').count(), 0);
    const published = await page.evaluate(() => {
      summaryObserver.disconnect();
      releaseClose();
      return publishedCounts;
    });
    assert.ok(published.every(text => !/已完成 1 \/ 1/.test(text)), JSON.stringify(published));
    await page.waitForFunction(() => reviewApp.workspace.view().batches[0].status === 'completed');
    assert.match(await page.locator('.batch-summary').innerText(), /已完成 1 \/ 1/);
    const decoded = await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const names = Array.fromAsync(testDirectory.keys());
      const file = await (await testDirectory.getFileHandle(closingFile)).getFile();
      const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        const frame = await new MB.CanvasSink(track).getCanvas(0.25);
        return { names: await names, name: file.name, duration: await input.computeDuration(), width: frame?.canvas.width };
      } finally { input.dispose(); }
    });
    assert.deepEqual(decoded.names, [decoded.name]);
    assert.ok((await page.locator('.output-item').textContent()).includes(decoded.name));
    assert.equal(decoded.width, 640);
    assert.ok(Math.abs(decoded.duration - 0.5) <= 1 / 12, JSON.stringify(decoded));
    console.log('PASS close gate and independent OPFS decode:', decoded);
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().batches[0].outputs[0].saved), true);
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false);
    // Subsequent submissions reuse the selected directory without another picker.
    await page.locator('.batch-review').first().click();
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches[1]?.status === 'completed');
    assert.equal(await page.evaluate(() => pickerCalls), 2);
    // Permission can expire between batches. Retrying must let the user choose again.
    await page.evaluate(() => { permission = 'denied'; });
    await page.locator('.batch-review').first().click();
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches[2]?.status === 'awaiting-destination');
    await page.locator('.batch-start:visible').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches[2].status === 'completed', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => pickerCalls), 3);
    assert.ok(await page.evaluate(() => pickerActivations.every(Boolean)), 'Pickers are triggered by user clicks');
    assert.match(await page.locator('.batch-state').first().textContent(), /已保存/);
    // Recovery warnings remain visible even after the retried clip is saved.
    await page.evaluate(() => {
      const batch = reviewApp.workspace.view().batches[0];
      const clipResults = batch.clipResults.map(clip => ({ ...clip, cleanupWarnings: ['编码失败；清理失败；遗留文件：旧目录/partial.mp4'] }));
      reviewApp.workspace.updateBatch(batch.id, { clipResults });
    });
    assert.match(await page.locator('.batch-attention').first().textContent(), /旧目录\/partial.mp4/);
    assert.equal(await page.locator('.batch-attention').first().isVisible(), true);
    // Finished history must not prompt; unsent human edits must still prompt.
    await page.evaluate(() => {
      const batch = reviewApp.workspace.view().batches[2];
      reviewApp.workspace.updateBatch(batch.id, { status: 'failed', error: 'historical failure' });
    });
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false, 'Failed history alone must not warn');
    await page.evaluate(() => reviewApp.workspace.updateBatch(reviewApp.workspace.view().batches[2].id, { status: 'cancelled' }));
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), false, 'Cancelled history alone must not warn');
    await page.evaluate(() => reviewApp.workspace.addManual(reviewApp.workspace.view().sources[0].id, { start: 0.6, end: 0.9 }));
    assert.equal(await page.evaluate(() => reviewApp.shouldWarnOnLeave()), true, 'Unsubmitted human selections remain protected');
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: unsupported capability, picker cancel/retry, save, reuse, revoked permission/reselect; no download fallback');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
