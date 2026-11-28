const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const getSource = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
  try {
    const url = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    url.searchParams.set('reviewPreview', 'analyzing');
    await page.goto(url.href);
    await page.locator('.review-preview-banner[data-ready="true"]').waitFor();
    // Hold the next same-source publication; release only after the pointer-up commits the trim.
    await page.evaluate(() => {
      const source = reviewApp.activeSourceId;
      window.nextPublication = new Promise(resolve => { window.releasePublication = resolve; }).then(() => {
        reviewApp.workspace.publishCandidates(source, [
          { id: 'expanded', start: 1.8, end: 5.2 }, { id: 'second', start: 8, end: 10 },
        ]);
      });
      window.showDirectoryPicker = async () => { throw new DOMException('Cancel', 'AbortError'); };
    });
    // Leave a distinct unchecked decision on the second clip.
    await page.locator('#next-candidate').click();
    await page.locator('#toggle-current-clip').click();
    await page.locator('#prev-candidate').click();
    await page.waitForFunction(() => !document.querySelector('#selection-player-axis').dataset.transitioning &&
      reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId === 'auto:first');
    const handle = page.locator('#selection-left');
    const box = await handle.boundingBox();
    assert.ok(box && box.width && box.height, 'visible left trim handle');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 45, y, { steps: 8 });
    await page.mouse.up();
    const before = await getSource();
    const trimmed = before.clips.find(c => c.manual);
    assert.ok(trimmed?.start > 2 && trimmed.start < 5 && trimmed.end === 5, 'drag committed a new left edge');
    assert.equal(before.review.selectedClipId, trimmed.id);
    assert.equal(trimmed.selected, true);
    assert.equal(before.clips.find(c => c.id === 'auto:second').selected, false);
    await page.evaluate(async () => { window.releasePublication(); await window.nextPublication; });
    const after = await getSource();
    assert.equal(after.review.selectedClipId, trimmed.id);
    assert.deepEqual(after.clips.find(c => c.id === trimmed.id), trimmed);
    assert.equal(after.clips.find(c => c.id === 'auto:second').selected, false);
    assert.equal(after.clips.find(c => c.id === 'auto:expanded').supplemental, true);
    assert.equal(after.clips.find(c => c.id === 'auto:expanded').selected, false);
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches.length === 1);
    const batch = await page.evaluate(() => reviewApp.workspace.view().batches[0]);
    assert.equal(batch.sourceId, before.id);
    assert.deepEqual(batch.clips, [{ id: trimmed.id, start: trimmed.start, end: trimmed.end }]);
    console.log('PASS R3', browser.version(), batch.sourceId, batch.clips);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
