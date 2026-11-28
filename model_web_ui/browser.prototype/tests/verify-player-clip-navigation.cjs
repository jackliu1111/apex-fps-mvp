// Player controls and full-recording overlay, using a decoded 12-second preview.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const url = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    url.searchParams.set('reviewPreview', 'default');
    await page.goto(url.href);
    await page.locator('.review-preview-banner[data-ready="true"]').waitFor();

    await page.locator('#next-candidate').click();
    await page.evaluate(() => reviewApp.player.seek(9));
    await page.locator('#prev-candidate').click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    const selected = await page.evaluate(() => ({
      id: reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId,
      time: reviewApp.player.state.position,
    }));
    assert.equal(selected.id, 'auto:first');
    assert.ok(Math.abs(selected.time - 2) < 0.05);
    assert.ok(await page.locator('#prev-candidate').isDisabled());

    await page.evaluate(() => {
      const id = reviewApp.activeSourceId;
      const scores = new Float32Array(300 * 4);
      scores[201 * 4] = 0.95; // Gunshot at 8.04s inside a developing candidate.
      reviewApp.bindings.get(id).scoreTimeline = { groupScores: scores, groupScoreFrames: 300 };
      reviewApp.workspace.publishCandidates(id, [{ id: 'tail', start: 8, end: 8.06, provisional: true }]);
    });
    const markers = page.locator('#player-overview-markers > span');
    assert.equal(await markers.count(), 1);
    const canvas = page.locator('#player-overview-distribution');
    for (const fullscreen of [false, true]) {
      if (fullscreen) {
        await page.locator('#player-fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'player-frame');
      }
      const track = await canvas.boundingBox();
      const marker = await markers.boundingBox();
      assert.ok(Math.abs(marker.y - track.y) < 1 && Math.abs(marker.height - track.height) < 1);
      assert.ok(Math.abs(marker.x - (track.x + track.width * 8 / 12)) < 1);
      assert.ok(Math.abs(marker.width - track.width * 0.06 / 12) < 1);
      const redX = await canvas.evaluate(el => {
        const x = Math.floor(el.width * 8.05 / 12);
        const pixels = el.getContext('2d').getImageData(x - 2, el.height - 1, 5, 1).data;
        return [0, 1, 2, 3, 4].some(i => pixels[i * 4] > pixels[i * 4 + 1] * 2 && pixels[i * 4 + 3]);
      });
      assert.ok(redX, 'Gunshot at 8.05s must remain visible beneath its interval');
    }
    console.log('PASS previous clip selection and position, overview interval and gunshot geometry in normal and fullscreen');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
