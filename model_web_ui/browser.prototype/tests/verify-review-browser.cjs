// Run against the static prototype host. Browser and model are real; no media upload.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8797/');
    await page.locator('#analysis-page').waitFor({ timeout: 5000 });
    await page.locator('#demo').click();
    await page.waitForFunction(() => window.reviewApp?.queue.records.some((record) => record.status === 'complete'), null, { timeout: 120000 });
    const result = await page.evaluate(() => {
      const record = reviewApp.queue.records[0];
      return { status: record.status, windows: record.windows, selected: record.selected, sourceCount: reviewApp.workspace.view().sources.length };
    });
    assert.equal(result.status, 'complete'); assert.equal(result.windows, 2); assert.equal(result.sourceCount, 1);
    assert.equal(await page.locator('#queue select').count(), 0, 'No track-confirmation gate');
    await page.locator('#queue [data-action="review"]').first().click();
    await page.locator('#review-page').waitFor();
    await page.waitForFunction(() => window.reviewApp.player.state.status === 'paused');
    assert.ok(Math.abs(Number(await page.locator('#overview').getAttribute('max')) - 12) < 0.02, 'Timeline covers the full 12-second source including codec timestamp rounding');
    // The same selected file cannot create a second analysis or a second source.
    await page.evaluate(() => reviewApp.importFiles([reviewApp.queue.records[0].file]));
    assert.equal(await page.evaluate(() => reviewApp.queue.records.length), 1);
    await page.locator('#manual').click();
    await page.locator('#range-start').fill('1.25'); await page.locator('#range-start').press('Tab');
    await page.locator('#range-end').fill('4.75'); await page.locator('#range-end').press('Tab');
    await page.locator('#seek-time').fill('7.5'); await page.locator('#seek-time').press('Tab');
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused' && reviewApp.workspace.view().save.status === 'saved');
    const before = await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    assert.deepEqual(before.clips.filter((clip) => clip.manual).map(({start,end}) => [start,end]), [[1.25,4.75]]);
    assert.equal(before.review.position, 7.5);
    // Playback leaving the page pauses only the player; returning starts paused.
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => reviewApp.player.state.playing);
    await page.locator('#back-analysis').click();
    assert.equal(await page.evaluate(() => reviewApp.player.state.playing), false);
    await page.locator('#nav-review').click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    await page.locator('#seek-time').fill('7.5'); await page.locator('#seek-time').press('Tab');
    await page.waitForFunction(() => reviewApp.workspace.view().save.status === 'saved' && reviewApp.player.state.status === 'paused');
    await page.reload();
    await page.waitForFunction(() => !!window.reviewApp);
    await page.evaluate(() => reviewApp.ready);
    await page.locator('#review-page').waitFor();
    assert.equal(await page.locator('#missing-source').isVisible(), true);
    assert.equal(await page.locator('#range-start').inputValue(), '1.25');
    assert.equal(await page.locator('#range-end').inputValue(), '4.75');
    assert.equal(await page.locator('#seek-time').inputValue(), '7.50');
    assert.equal(await page.evaluate(() => reviewApp.bindings.size), 0, 'Reload restores metadata, never a stale runtime File');
    assert.equal(await page.locator('#play-pause').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ automaticImportAndReview: 'passed', trimAndRefresh: 'passed', navigation: 'passed', identityDedup: 'passed', ...result }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
