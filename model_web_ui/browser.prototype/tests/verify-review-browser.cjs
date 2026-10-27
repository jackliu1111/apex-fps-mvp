// Run against the static prototype host. Browser and model are real; no media upload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-review-browser-'));
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
    await page.locator('#seek-time').fill('7.5'); await page.locator('#seek-time').press('Tab');
    await page.waitForFunction(() => reviewApp.workspace.view().save.status === 'saved' && reviewApp.player.state.status === 'paused');
    if (process.env.REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT, fullPage: true });
    const fixture = await page.evaluate(async () => {
      const file = reviewApp.queue.records[0].file;
      return { name: file.name, lastModified: file.lastModified, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
    });
    const fixturePath = path.join(fixtureDirectory, fixture.name);
    fs.writeFileSync(fixturePath, Buffer.from(fixture.bytes));
    fs.utimesSync(fixturePath, fixture.lastModified / 1000, fixture.lastModified / 1000);
    await page.reload();
    await page.waitForFunction(() => !!window.reviewApp);
    await page.evaluate(() => reviewApp.ready);
    await page.locator('#review-page').waitFor();
    assert.equal(await page.locator('#missing-source').isVisible(), true);
    assert.equal(await page.locator('#range-start').inputValue(), '1.70');
    assert.equal(await page.locator('#range-end').inputValue(), '4.25');
    assert.equal(await page.locator('#seek-time').inputValue(), '7.50');
    assert.equal(await page.evaluate(() => reviewApp.bindings.size), 0, 'Reload restores metadata, never a stale runtime File');
    assert.equal(await page.locator('#play-pause').isDisabled(), true);
    const [wrongChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#relink-current').click()]);
    await wrongChooser.setFiles({ name: 'browser-synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from('wrong source') });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('身份不一致'));
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().sources.length), 1);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#relink-current').click()]);
    await chooser.setFiles(fixturePath);
    await page.waitForFunction(() => reviewApp.bindings.size === 1 && reviewApp.player.state.status === 'paused');
    assert.equal(await page.locator('#missing-source').isVisible(), false);
    assert.equal(await page.locator('#range-start').inputValue(), '1.70');
    assert.equal(await page.locator('#range-end').inputValue(), '4.25');
    assert.equal(await page.evaluate(() => reviewApp.workspace.view().sources.length), 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ automaticImportAndReview: 'passed', trimAndRefresh: 'passed', navigation: 'passed', identityDedup: 'passed', earlyFixedExport: 'passed', focusedEdit: 'passed', relinkIdentity: 'passed', ...result }));
  } finally { await browser.close(); fs.rmSync(fixtureDirectory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
