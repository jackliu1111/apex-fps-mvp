// ADR 0007: real browser controls and media export, with deterministic candidates.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
  const row = id => page.locator(`#clips [data-clip-id="${id}"]`);
  try {
    const url = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:18808/');
    await page.goto(url.href);
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      await reviewApp.importFiles([await createSyntheticFile()]);
    });
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.locator('#queue [data-action=review]').first().click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    await page.evaluate(() => reviewApp.workspace.publishCandidates(reviewApp.activeSourceId, [{ id: 'one', start: 2, end: 5 }, { id: 'two', start: 8, end: 10 }]));
    await page.locator('#overview-markers button').first().click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    await page.locator('.selection-details > summary').click();
    const initial = await state();
    const first = initial.clips[0].id, second = initial.clips[1].id;
    await page.evaluate(id => { window.originalRow = document.querySelector(`#clips [data-clip-id="${id}"]`); }, first);
    await row(first).locator('.clip-selected').uncheck();
    assert.equal(await page.locator('#clips .clip').count(), 2);
    assert.equal(await page.locator('#overview-markers button').count(), 2);
    assert.equal(await page.evaluate(() => originalRow.isConnected && document.activeElement === originalRow.querySelector('input')), true);
    assert.match(await row(first).getAttribute('class'), /unselected/);
    assert.match(await page.locator(`#overview-markers [data-clip-id="${first}"]`).getAttribute('class'), /unselected/);
    assert.deepEqual((await state()).decisions, []);
    assert.deepEqual((await state()).review, initial.review);

    await page.locator('#exclude-all').click();
    assert.equal(await page.locator('#clips .clip').count(), 2);
    assert.equal(await page.locator('#clips input:checked').count(), 0);
    assert.equal(await page.locator('#retain-all').isEnabled(), true);
    assert.equal(await page.locator('#exclude-all').isEnabled(), true);
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.locator('#retain-all').click();
    assert.equal(await page.locator('#clips input:checked').count(), 2);
    assert.equal(await page.locator('#export').isEnabled(), true);
    assert.deepEqual((await state()).decisions, []);

    // Trimming a deselected candidate must not silently add it back to export.
    await row(first).locator('.clip-selected').uncheck();
    await page.locator('.precise-editor > summary').click();
    await page.locator('#range-start').fill('2.25'); await page.locator('#range-start').press('Tab');
    const trimmed = (await state()).clips.find(clip => clip.manual);
    assert.equal(trimmed.selected, false);
    await row(trimmed.id).locator('.clip-exclude').click();
    assert.equal(await page.locator('#clips .clip').count(), 1);
    assert.equal(await page.locator('#overview-markers button').count(), 1);
    await page.locator('#show-excluded').check();
    assert.equal(await page.locator('#clips .clip.excluded').count(), 1);
    assert.equal(await page.locator('#overview-markers .excluded').count(), 1);
    assert.equal(await row(trimmed.id).locator('.clip-selected').isDisabled(), true);
    assert.equal(await row(trimmed.id).locator('.clip-exclude').textContent(), '恢复');
    assert.match(await row(trimmed.id).locator('.clip-title').evaluate(node => getComputedStyle(node).textDecorationLine), /line-through/);
    await page.locator('#retain-all').click();
    assert.equal((await state()).clips.find(clip => clip.id === trimmed.id).excluded, true);
    assert.equal(await page.locator('#clips input:checked').count(), 1);
    await page.locator('#show-excluded').uncheck();
    assert.equal(await page.locator('#clips .clip.excluded').count(), 0);
    assert.equal(await page.locator('#overview-markers .excluded').count(), 0);
    await page.locator('#show-excluded').check();
    await row(trimmed.id).locator('.clip-exclude').click();
    assert.equal((await state()).clips.find(clip => clip.id === trimmed.id).selected, true);
    assert.equal(await page.locator('#overview-markers .excluded').count(), 0);

    // Delete is an explicit exclusion. Repeating it cannot delete a neighbour.
    await row(trimmed.id).locator('.clip-jump').click();
    await page.locator('#prediction-workspace').focus();
    await page.keyboard.press('Delete');
    const excluded = await state();
    assert.equal(excluded.review.selectedClipId, null);
    await page.keyboard.press('Delete');
    assert.deepEqual((await state()).decisions, excluded.decisions);
    await page.locator('#undo-selection').click();
    assert.equal((await state()).clips.find(clip => clip.id === trimmed.id).excluded, false);
    await page.locator('#redo-selection').click();
    assert.equal(await page.locator('#clips .clip.excluded').count(), 1);
    await page.locator('#overview-markers .excluded').click();
    assert.equal(await page.locator('#clips .clip.excluded').count(), 0);
    await row(trimmed.id).locator('.clip-jump').click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    const beforeFit = await state();
    assert.equal(await page.locator('#exit-selection').textContent(), '全片视野');
    await page.locator('#exit-selection').click();
    const fitted = await state();
    assert.deepEqual(fitted.clips, beforeFit.clips);
    assert.deepEqual(fitted.decisions, beforeFit.decisions);
    assert.equal(fitted.review.selectedClipId, beforeFit.review.selectedClipId);
    assert.equal(fitted.review.position, beforeFit.review.position);
    assert.equal(fitted.review.zoomStart, 0); assert.equal(fitted.review.zoomEnd, fitted.duration);
    assert.equal(await page.locator('button').evaluateAll(nodes => nodes.some(node => node.textContent.includes('↗'))), false);

    // Even an entirely excluded source remains recoverable from both surfaces.
    await row(trimmed.id).locator('.clip-exclude').click();
    await row(second).locator('.clip-exclude').click();
    await page.locator('#show-excluded').uncheck();
    assert.equal(await page.locator('#clips .clip').count(), 0);
    assert.equal(await page.locator('#retain-all').isEnabled(), true);
    await page.locator('#retain-all').click();
    assert.equal((await state()).clips.every(clip => clip.excluded && !clip.selected), true);
    await page.locator('#show-excluded').check();
    assert.equal(await page.locator('#clips .clip.excluded').count(), 2);
    await page.locator('#clips .clip.excluded .clip-exclude').first().click();
    await page.locator('#overview-markers .excluded').click();
    assert.equal(await page.locator('#clips input:checked').count(), 2);

    // The native picker is substituted with a real, temporary browser directory.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      window.selectionTestDirectory = await root.getDirectoryHandle('adr7-selection', { create: true });
      window.showDirectoryPicker = () => new Promise(resolve => { window.releaseDirectory = () => resolve(selectionTestDirectory); });
    });
    await page.locator('#export-format').selectOption('webm');
    await page.locator('#export').click();
    await page.waitForFunction(() => window.releaseDirectory);
    const submitted = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.equal(submitted.clips.length, 2);
    await page.evaluate(() => {
      const id = reviewApp.activeSourceId;
      reviewApp.workspace.chooseAll(id, false);
      const clip = reviewApp.workspace.getSource(id).clips[0];
      reviewApp.workspace.trim(id, clip.id, { start: clip.start + .1, end: clip.end - .1 });
      releaseDirectory();
    });
    await page.waitForFunction(() => reviewApp.workspace.view().batches[0]?.status === 'completed', null, { timeout: 60000 });
    const finished = await page.evaluate(async () => {
      const batch = reviewApp.workspace.view().batches[0];
      const sizes = await Promise.all(batch.outputs.map(async output => (await (await selectionTestDirectory.getFileHandle(output.name)).getFile()).size));
      return { batch, sizes };
    });
    assert.deepEqual(finished.batch.clips, submitted.clips);
    assert.equal(finished.batch.outputs.every(output => output.saved), true);
    assert.equal(finished.sizes.every(bytes => bytes > 1000), true);
    assert.equal((await state()).clips.every(clip => !clip.selected), true);
    await page.locator('.batch-review').first().click();
    await page.locator('#clips .clip-exclude').first().click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.REVIEW_SCREENSHOT_DIR) await page.locator('.review-list').screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/adr7-${width}.png`, animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checkboxIdentityAndFocus: 'passed', deselectReselectAll: 'passed', sharedExclusionVisibility: 'passed', listAndTimelineRestore: 'passed', deleteUndoRedo: 'passed', fitPreservesSelection: 'passed', frozenDirectoryExport: 'passed', savedBytes: finished.sizes, responsiveWidths: [1440, 768, 390], pageErrors: errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
