// Fail the second file after its writer has accepted bytes; exercise both recovery buttons.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function scenario(browser, action) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ranges = [[0, 0.5], [1, 1.75], [2, 3]];
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:18806');
    await page.waitForFunction(() => window.reviewApp);
    if (await page.locator('html').getAttribute('lang') !== 'zh-CN') await page.locator('#lang-toggle').click();
    await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      await reviewApp.importFiles([await createSyntheticFile({ sourceLabel: 'B', duration: 4 })]);
    });
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete');
    await page.locator('#queue .file').click();
    await page.evaluate(async ({ ranges, action }) => {
      reviewApp.workspace.publishCandidates(reviewApp.activeSourceId,
        ranges.map(([start, end], index) => ({ id: 'clip-' + index, start, end })));
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('original', { create: true });
      window.retryDir = await root.getDirectoryHandle('reselected', { create: true });
      window.originalDir = dir;
      window.opened = [];
      window.closedFiles = [];
      window.pickerCalls = 0;
      const failure = Promise.withResolvers();
      window.injectFailure = failure.resolve;
      const originalFile = dir.getFileHandle.bind(dir);
      dir.getFileHandle = async (...args) => {
        const file = await originalFile(...args);
        if (!args[1]?.create) return file;
        opened.push(file.name);
        const second = opened.length === 2;
        const open = file.createWritable.bind(file);
        file.createWritable = async () => {
          const writer = await open();
          const write = writer.write.bind(writer), close = writer.close.bind(writer);
          writer.close = async () => { await close(); closedFiles.push(file.name); };
          if (second) writer.write = async chunk => {
            await write(chunk);
            window.failedFile = file.name;
            await failure.promise;
            throw new DOMException('second-write-denied', 'NotAllowedError');
          };
          return writer;
        };
        return file;
      };
      if (action === 'resume') dir.removeEntry = async () => { throw new Error('cleanup-denied'); };
      window.showDirectoryPicker = async () => ++pickerCalls === 1 ? dir : retryDir;
    }, { ranges, action });
    await page.locator('#export-format').selectOption('webm');
    await page.locator('#export').click();
    await page.waitForFunction(() => window.failedFile || reviewApp.workspace.view().batches[0]?.error);
    assert.ok(await page.evaluate(() => !!window.failedFile), await page.locator('.batch-state').innerText());
    assert.equal(await page.evaluate(() => closedFiles.length), 1);
    assert.match(await page.locator('.batch-summary').innerText(), /已完成 1 \/ 3/);
    const snapshot = await page.evaluate(() => reviewApp.workspace.view().batches[0].clips);
    assert.deepEqual(snapshot.map(c => [c.start, c.end]), ranges);
    await page.locator('.batch-review').click();
    await page.locator('#overview-markers button').last().click();
    await page.locator('#toggle-current-clip').click();
    assert.equal(await page.locator('#overview-markers .unselected').count(), 1);
    await page.locator('#nav-exports').click();
    await page.evaluate(() => injectFailure());
    await page.locator('.export-batch[data-status="awaiting-destination"]').waitFor();
    assert.match(await page.locator('.batch-summary').innerText(), /已完成 1 \/ 3.*等待选择输出目录/);
    const firstDigest = () => page.evaluate(async () => {
      const file = await (await originalDir.getFileHandle(closedFiles[0])).getFile();
      if (!file.size) throw Error('First output is empty');
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())));
    });
    const digest = await firstDigest();
    const partial = await page.evaluate(() => failedFile);
    if (action === 'resume') {
      const warning = await page.locator('.batch-attention').innerText();
      for (const text of ['second-write-denied', 'cleanup-denied', 'original/' + partial]) assert.ok(warning.includes(text), warning);
    }
    await page.locator(action === 'resume' ? '.batch-start' : '.batch-cancel').click();
    const status = action === 'resume' ? 'completed' : 'cancelled';
    await page.locator('.export-batch[data-status="' + status + '"]').waitFor();
    const result = await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { readSyntheticFrame } = await import('./tests/synthetic-media.mjs');
      const batch = reviewApp.workspace.view().batches[0];
      const outputs = [];
      for (const out of batch.outputs) {
        const directory = out.destination.name === 'original' ? originalDir : retryDir;
        const file = await (await directory.getFileHandle(out.name)).getFile();
        const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
        try {
          const video = await input.getPrimaryVideoTrack();
          const { canvas } = await new MB.CanvasSink(video).getCanvas(0.25);
          outputs.push({ name: file.name, frame: readSyntheticFrame(canvas), duration: await input.computeDuration() });
        } finally { input.dispose(); }
      }
      return { outputs, original: await Array.fromAsync(originalDir.keys()), retry: await Array.fromAsync(retryDir.keys()),
        clips: batch.clips, opened, closedFiles, pickerCalls };
    });
    assert.deepEqual(result.clips, snapshot);
    assert.deepEqual(await firstDigest(), digest);
    assert.equal(result.opened.length, 2);
    assert.deepEqual(result.closedFiles, [result.outputs[0].name]);
    const count = action === 'resume' ? 3 : 1;
    assert.equal(result.pickerCalls, action === 'resume' ? 2 : 1);
    assert.equal(result.outputs.length, count);
    assert.equal(await page.locator('.output-item').count(), count);
    assert.match(await page.locator('.batch-summary').innerText(), new RegExp('已完成 ' + count + ' / 3'));
    assert.deepEqual(result.original.sort(), [result.outputs[0].name, ...(action === 'resume' ? [partial] : [])].sort());
    assert.deepEqual(result.retry.sort(), result.outputs.slice(1).map(o => o.name).sort());
    for (const [i, output] of result.outputs.entries()) {
      assert.equal(output.frame.source, 'B');
      assert.ok(Math.abs(output.frame.frame - (ranges[i][0] + 0.25) * 12) <= 1, JSON.stringify(output));
      assert.ok(Math.abs(output.duration - (ranges[i][1] - ranges[i][0])) <= 1 / 12, JSON.stringify(output));
    }
    assert.deepEqual(errors, []);
    console.log('PASS', action, JSON.stringify(result.outputs));
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    for (const action of ['cancel', 'resume']) await scenario(browser, action);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
