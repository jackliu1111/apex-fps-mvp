const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:18796');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(() => reviewApp.ready);
    const button = page.locator('#import-files');
    assert.equal(await button.isEnabled(), true, 'Import must be enabled once the workspace is ready');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    assert.equal(chooser.isMultiple(), true);
    const bytes = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      return [...new Uint8Array(await (await createSyntheticFile({ duration: 1 })).arrayBuffer())];
    });
    await chooser.setFiles({ name: 'import-button.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
    await page.waitForFunction(() => reviewApp.workspace.view().sources.length === 1);
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().sources[0].identity.name), 'import-button.webm');
    assert.equal(await button.isEnabled(), true, 'Import must remain available after queue updates');
    await page.locator('#nav-exports').click();
    await page.locator('#nav-analysis').click();
    assert.equal(await button.isEnabled(), true, 'Returning to analysis must preserve import availability');
    const [nextChooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    await nextChooser.setFiles([]);
    assert.deepEqual(errors, []);
    console.log('PASS: ready → click → file chooser → video imported → navigation → click again');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
