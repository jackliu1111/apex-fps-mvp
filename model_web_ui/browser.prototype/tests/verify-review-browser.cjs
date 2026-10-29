// Run against the static prototype host. Browser and model are real; no media upload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const seekToTestPosition = async () => {
    if (await page.locator('#source-fit').isEnabled()) await page.locator('#source-fit').click();
    await page.locator('#selection-player-axis').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  };
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-review-browser-'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8797/');
    await page.locator('#analysis-page').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      await reviewApp.importFiles([await createSyntheticFile()]);
    });
    await page.waitForFunction(() => window.reviewApp?.queue.records.some((record) => record.status === 'complete'), null, { timeout: 120000 });
    const result = await page.evaluate(() => {
      const record = reviewApp.queue.records[0];
      return { status: record.status, windows: record.windows, selected: record.selected, sourceCount: reviewApp.workspace.view().sources.length };
    });
    assert.equal(result.status, 'complete'); assert.equal(result.windows, 2); assert.equal(result.sourceCount, 1);
    assert.equal(await page.locator('#queue select').count(), 0, 'No track-confirmation gate');
    await page.locator('#queue [data-action="review"]').first().click();
    await page.locator('#review-page').waitFor();
    await page.locator('.precise-editor > summary').click();
    await page.locator('.selection-details > summary').click();
    await page.waitForFunction(() => window.reviewApp.player.state.status === 'paused');
    assert.ok(Math.abs(Number(await page.locator('#source-head').getAttribute('aria-valuemax')) - 12) < 0.02, 'Timeline covers the full 12-second source including codec timestamp rounding');
    // The same selected file cannot create a second analysis or a second source.
    await page.evaluate(() => reviewApp.importFiles([reviewApp.queue.records[0].file]));
    assert.equal(await page.evaluate(() => reviewApp.queue.records.length), 1);
    await page.locator('#manual').click();
    await page.locator('#range-start').fill('1.25'); await page.locator('#range-start').press('Tab');
    await page.locator('#range-end').fill('4.75'); await page.locator('#range-end').press('Tab');
    await seekToTestPosition();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    const before = await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    assert.deepEqual(before.clips.filter((clip) => clip.manual).map(({start,end}) => [start,end]), [[1.25,4.75]]);
    assert.equal(before.review.position, 7.5);
    // Retrying uses the real decoder/model; submitting in the same user-workspace
    // turn proves the editor is not locked behind the running analysis task.
    const early = await page.evaluate(async () => {
      void reviewApp.queue.retry(reviewApp.queue.records[0].id);
      document.querySelector('#export').click();
      await Promise.resolve(); await Promise.resolve();
      return { analysis: reviewApp.queue.records[0].status, batch: reviewApp.workspace.view().batches[0] };
    });
    assert.ok(['preparing', 'queued', 'analyzing'].includes(early.analysis));
    assert.equal(early.batch.status, 'queued');
    await page.locator('#range-start').fill('1.5'); await page.locator('#range-start').press('Tab');
    await page.locator('#range-end').fill('4.25'); await page.locator('#range-end').press('Tab');
    await page.waitForFunction(() => reviewApp.workspace.view().batches[0]?.status === 'completed');
    const batch = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.deepEqual(batch.clips.map(({start,end}) => [start,end]), [[1.25,4.75]]);
    assert.equal(batch.outputs[0].saved, false, 'A downloadable Blob is not a saved disk file');
    assert.ok(batch.outputs[0].measuredDuration > 3.4 && batch.outputs[0].measuredDuration < 3.7);
    assert.equal(await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).hasUnexportedChanges), true);
    await page.locator('#range-start').fill('1.7');
    await page.evaluate(() => reviewApp.queue.recompute(reviewApp.queue.records[0].id, 0.01));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'range-start');
    assert.equal(await page.locator('#range-start').inputValue(), '1.7', 'New candidates cannot replace an uncommitted focused edit');
    assert.equal(await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).review.position), 7.5);
    await page.locator('#range-start').press('Tab');
    // Playback leaving the page pauses only the player; returning starts paused.
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => reviewApp.player.state.playing);
    await page.locator('#back-analysis').click();
    assert.equal(await page.evaluate(() => reviewApp.player.state.playing), false);
    await page.locator('#nav-review').click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    await seekToTestPosition();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    if (process.env.REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT, fullPage: true });
    page.on('dialog', dialog => dialog.accept());
    await page.reload(); await page.waitForFunction(() => !!window.reviewApp);
    await page.evaluate(() => reviewApp.ready);
    assert.equal(await page.locator('#analysis-page').isVisible(), true);
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().sources.length), 0);
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().batches.length), 0);
    assert.equal(await page.evaluate(() => reviewApp.bindings.size), 0);
    assert.equal(await page.locator('#relink-current').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ automaticImportAndReview: 'passed', trimAndSessionReset: 'passed', navigation: 'passed', identityDedup: 'passed', earlyFixedExport: 'passed', focusedEdit: 'passed', ...result }));
  } finally { await browser.close(); fs.rmSync(fixtureDirectory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
