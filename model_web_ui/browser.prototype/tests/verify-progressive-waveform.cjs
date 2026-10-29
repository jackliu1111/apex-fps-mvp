const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8792');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      await reviewApp.importFiles([await createSyntheticFile({ duration: 135, frameRate: 4 })]);
    });
    await page.waitForFunction(() => reviewApp.queue.records[0]?.waveform?.decodedUntil > 0);
    await page.locator('#queue [data-action=review]').first().click();
    await page.waitForFunction(() => document.querySelector('#prediction-wave')?.dataset.decodedUntil > 0);
    const partial = await page.evaluate(() => {
      const record = reviewApp.queue.records[0];
      return { until: record.waveform.decodedUntil, duration: record.duration, status: record.status, blank: record.waveform.peaks.filter(v => v === null).length };
    });
    assert.equal(partial.status, 'analyzing');
    assert.ok(partial.until < partial.duration && partial.blank > 0);
    if (process.env.REVIEW_SCREENSHOT_DIR) await page.locator('#prediction-workspace').screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/progressive.png` });
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    const complete = await page.evaluate(async () => {
      const r = reviewApp.queue.records[0];
      const canvas = document.querySelector('#prediction-wave');
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return { until: r.waveform.decodedUntil, duration: r.duration, passes: r.timings.decoderPasses, painted: bytes.some((v, i) => i % 4 === 3 && v > 0), peaks: r.waveform.peaks };
    });
    assert.ok(complete.until > 134.9 && complete.painted);
    assert.equal(complete.passes, 1);
    await page.locator('#prediction-zoom').click();
    await page.locator('#prediction-fit').click();
    page.on('dialog', dialog => dialog.accept());
    await page.reload(); await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.ready);
    assert.deepEqual(await page.evaluate(() => reviewApp.workspace.view().sources), []);
    assert.equal(await page.locator('#analysis-page').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ partial, complete: { ...complete, peaks: `${complete.peaks.length} buckets` }, refresh: 'passed', errors }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
