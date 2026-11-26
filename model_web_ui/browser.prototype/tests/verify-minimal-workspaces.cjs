// Verifies Ticket 01: minimal analysis queue & export workspaces without debug/guide drawers.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8792/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.ready);

    assert.equal(await page.locator('#analysis-page .settings-panel').count(), 0);
    assert.equal(await page.locator('#analysis-page .workflow-guide').count(), 0);
    assert.equal(await page.locator('#exports-section .export-settings').count(), 0);
    assert.equal(await page.locator('#demo, .empty-demo-btn').count(), 0);
    assert.equal(await page.locator('#import-files').isVisible(), true);

    await page.locator('#nav-exports').click();
    await page.waitForFunction(() => !document.querySelector('#exports-section').hidden);
    assert.equal(await page.locator('#choose-directory').isVisible(), true);
    assert.equal(await page.locator('#export-batches').isVisible(), true);

    await page.locator('#nav-analysis').click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }

    // Import a local recording through the normal file input.
    const mediaBytes = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const file = await createSyntheticFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    });
    await page.locator('#files').setInputFiles({
      name: 'local-recording.mp4', mimeType: 'video/mp4', buffer: Buffer.from(mediaBytes),
    });
    await page.waitForFunction(() => document.querySelectorAll('#queue .file').length >= 1, null, { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#clipping-workspace')?.dataset.layout === 'split' && !document.querySelector('#review-page').hidden, null, { timeout: 120000 });
    assert.equal(await page.locator('#nav-review').count(), 0);
    assert.equal(await page.locator('#source-select').count(), 0);
    assert.equal(await page.locator('#back-analysis').count(), 0);

    assert.deepEqual(errors, []);
    console.log('PASS: minimal split clipping & export workspace layout');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
