const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8794/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const w = reviewApp.workspace;
      const id = w.addSource({ id: 'source-under-analysis', name: 'analyzing.webm', duration: 15 });
      w.updateAnalysis(id, { status: 'analyzing', processedUntil: 7 });
      w.publishCandidates(id, [
        { id: 'pending-first', start: 1.95, end: 2, provisional: true },
        { id: 'stable-a', start: 2, end: 3.1 },
        { id: 'pending-middle', start: 3.1, end: 3.11, provisional: true },
        { id: 'stable-b', start: 3.11, end: 4.2 },
        { id: 'pending-only', start: 7, end: 7.5, provisional: true },
        { id: 'pending-only-next', start: 7.5, end: 8, provisional: true },
      ]);
      w.addManual(id, { start: 12, end: 13 });
      w.choose(id, 'auto:stable-b', false);
      await reviewApp.openReview(id);
    });

    const snapshot = () => page.evaluate(() => {
      const source = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      return { selected: source.review.selectedClipId, decisions: source.decisions,
        choices: source.clips.map(clip => [clip.id, clip.selected]) };
    });
    const before = await snapshot();
    const markers = page.locator('#overview-markers');
    const pending = markers.locator('[data-clip-id="auto:pending-only"]');
    assert.equal(await pending.getAttribute('data-merged'), 'true');
    assert.equal(await pending.isDisabled(), true);

    for (const expected of ['auto:stable-a', 'auto:stable-b', 'auto:stable-a']) {
      const mixed = markers.locator('[data-merged="true"]:enabled').first();
      const box = await mixed.boundingBox();
      await mixed.click({ position: { x: Math.floor(box.width * 0.35), y: 3 } });
      const state = await snapshot();
      assert.equal(state.selected, expected, 'The mixed group cycles through stable candidates only');
      await page.locator('#selection-left').waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#selection-right').waitFor({ state: 'visible', timeout: 2000 });
      assert.deepEqual(state.decisions, before.decisions);
      assert.deepEqual(state.choices, before.choices);
    }
    console.log('PASS mixed candidate group selects each stable member and wraps; trim handles, manual decisions and export choices preserved');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
