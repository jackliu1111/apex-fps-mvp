const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const url = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8794/');
    url.searchParams.set('reviewPreview', 'default');
    await page.goto(url.href);
    await page.locator('.review-preview-banner[data-ready="true"]').waitFor();

    for (const fullscreen of [false, true]) {
      await page.locator('#quick-fit-clip').click();
      if (fullscreen) {
        await page.locator('#player-fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'player-frame');
      }
      const bar = await page.locator('#player-overview-bar').boundingBox();
      const duration = await page.locator('#overview').evaluate(node => Number(node.max));
      const initial = await page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).review);
      assert.ok(initial.zoomEnd < duration * 0.95, 'Final drag target starts outside the local window');
      const y = bar.y + bar.height / 2;
      const move = ratio => page.mouse.move(bar.x + ratio * bar.width, y);
      const frame = () => page.locator('#source-canvas').evaluate(canvas => canvas.toDataURL());
      const waitForFrame = ratio => page.waitForFunction(target => {
        const state = reviewApp.player.state;
        return state.status === 'paused' && Math.abs(state.actual - target) < 0.12;
      }, duration * ratio, { timeout: 4000 });

      await move(0.2);
      await page.mouse.down();
      await move(0.4);
      await waitForFrame(0.4);
      const firstPreview = await frame();
      await move(0.7);
      await waitForFrame(0.7);
      assert.notEqual(await frame(), firstPreview, 'Decoded canvas must change while still holding the pointer');

      for (const ratio of [0.1, 0.8, 0.35, 0.95]) await move(ratio);
      await page.mouse.up();
      await waitForFrame(0.95);
      const final = await page.evaluate(() => {
        const source = reviewApp.workspace.getSource(reviewApp.activeSourceId);
        return { review: source.review, frame: reviewApp.player.state.actual,
          needle: Number(document.querySelector('#overview').value), readout: document.querySelector('#overview-position').textContent };
      });
      assert.ok(Math.abs(final.needle - duration * 0.95) < 0.02);
      assert.ok(Math.abs(final.needle - final.frame) < 0.12);
      const [minutes, seconds] = final.readout.split('/')[0].trim().split(':').map(Number);
      assert.ok(Math.abs(minutes * 60 + seconds - final.needle) < 0.1);
      assert.ok(final.review.zoomStart <= final.needle && final.needle <= final.review.zoomEnd);
      assert.ok(Math.abs((final.review.zoomEnd - final.review.zoomStart) - (initial.zoomEnd - initial.zoomStart)) < 0.01);
      console.log(`PASS ${fullscreen ? 'fullscreen' : 'normal'} pointer preview and final frame at ${final.frame.toFixed(2)}s`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
