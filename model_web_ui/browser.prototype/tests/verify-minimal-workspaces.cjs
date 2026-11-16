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
    assert.equal(await page.locator('#analysis-page .queue-panel .panel-heading #demo').isVisible(), true);
    assert.equal(await page.locator('#queue .empty .empty-demo-btn').isVisible(), true);

    await page.locator('#nav-exports').click();
    await page.waitForFunction(() => !document.querySelector('#exports-section').hidden);
    assert.equal(await page.locator('#choose-directory').isVisible(), true);
    assert.equal(await page.locator('#export-batches').isVisible(), true);

    await page.locator('#nav-analysis').click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }

    // Trigger inline 1-minute sample button from empty state (falling back to synthetic /demo route when offline).
    const hasDemo = await page.evaluate(async () => (await fetch('/demo/manifest.json').catch(() => null))?.ok || false);
    if (!hasDemo) {
      const demoBytes = await page.evaluate(async () => {
        const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
        const file = await createSyntheticFile();
        return Array.from(new Uint8Array(await file.arrayBuffer()));
      });
      await page.route('**/demo/manifest.json', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: 'demo-combat.mp4', bytes: demoBytes.length, lastModified: 1700000000000 }),
      }));
      await page.route('**/demo/recording.mp4', (route) => route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        body: Buffer.from(demoBytes),
      }));
    }
    await page.locator('#queue .empty .empty-demo-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#queue .file').length >= 1, null, { timeout: 120000 });
    assert.equal(await page.locator('#nav-review').isEnabled(), true);

    assert.deepEqual(errors, []);
    console.log('PASS: minimal analysis queue & export workspace layout');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
