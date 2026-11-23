const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8794/');
    url.searchParams.set('reviewPreview', 'default');
    await page.goto(url.href);
    await page.locator('.review-preview-banner[data-ready=true]').waitFor();

    const before = await page.evaluate(() => {
      const { workspace, activeSourceId: id } = reviewApp;
      workspace.publishCandidates(id, [{ id: 'second', start: 3.08, end: 4 }]);
      const first = workspace.addManual(id, { start: 2, end: 3 });
      workspace.setReview(id, { selectedClipId: first, position: 2, zoomStart: 0, zoomEnd: 12 });
      return workspace.getSource(id).decisions;
    });
    const merged = page.locator('#overview-markers [data-merged=true]');
    const selectedRanges = () => page.evaluate(() => {
      const { workspace, activeSourceId } = reviewApp;
      return workspace.submitBatch(activeSourceId).clips.map(({ start, end }) => [start, end]);
    });

    assert.match(await merged.innerText(), /☑/);
    assert.match(await merged.getAttribute('aria-label'), /2 of 2 eligible clips selected for export/i);
    assert.deepEqual(await selectedRanges(), [[2, 3], [3.08, 4]]);

    await page.locator('#toggle-current-clip').click();
    assert.match(await merged.innerText(), /1\/2/);
    assert.match(await merged.getAttribute('aria-label'), /1 of 2 eligible clips selected for export/i);
    assert.deepEqual(await selectedRanges(), [[3.08, 4]]);

    await page.locator('#prediction-zoom').click();
    await page.locator('#overview-markers button').nth(1).waitFor({ timeout: 4000 });
    assert.equal(await page.locator('#overview-markers button').count(), 2);
    assert.deepEqual(await selectedRanges(), [[3.08, 4]]);
    await page.locator('#source-fit').click();
    assert.match(await merged.innerText(), /1\/2/);
    assert.deepEqual(await selectedRanges(), [[3.08, 4]]);

    await page.locator('#next-candidate').click();
    await page.locator('#toggle-current-clip').click();
    await page.locator('#source-fit').click();
    assert.match(await merged.innerText(), /☐/);
    assert.match(await merged.getAttribute('aria-label'), /0 of 2 eligible clips selected for export/i);
    assert.equal(await page.locator('#export').isDisabled(), true);
    const after = await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).decisions);
    assert.deepEqual(after, before);
    console.log('PASS: all, partial and zero export selections, zoom regrouping and preserved manual decision');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
