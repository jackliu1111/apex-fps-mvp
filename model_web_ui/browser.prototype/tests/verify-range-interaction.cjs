// Run against serve.py with PLAYWRIGHT_MODULE and CHROME_EXECUTABLE, as for the other browser checks.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8798');
    await page.waitForFunction(() => window.reviewApp);
    // An isolated browser context and a restored-style source exercise the real editor without inference.
    await page.evaluate(async () => {
      await reviewApp.ready;
      const workspace = reviewApp.workspace;
      workspace.addSource({ id: 'range-test', name: 'range-test.webm', size: 1, lastModified: 1, duration: 120 });
      const id = workspace.addManual('range-test', { start: 30, end: 60 });
      workspace.setReview('range-test', { selectedClipId: id, position: 45, zoomStart: 20, zoomEnd: 80 });
      await reviewApp.openReview('range-test');
    });
    const field = key => page.locator(`#range-${key}`);
    const handle = key => page.locator(`#range-${key}-handle`);
    const input = async (key, value) => {
      await handle(key).evaluate((el, next) => {
        el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    };
    const boxes = await Promise.all(['start', 'end'].map(key => handle(key).boundingBox()));
    assert.ok(Math.abs(boxes[0].x - boxes[1].x) < 1 && Math.abs(boxes[0].width - boxes[1].width) < 1,
      'Both boundaries use the same horizontal time scale');
    await input('start', 75);
    assert.equal(await field('start').inputValue(), '59.99', 'Crossing clamps instead of rejecting the drag');
    assert.equal(await field('end').inputValue(), '60.00');
    assert.equal(await page.evaluate(() => reviewApp.workspace.getSource('range-test').review.position), 45);
    await page.locator('#range-start-current').click();
    assert.equal(await field('start').inputValue(), '45.00');
    await handle('start').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await field('start').inputValue(), '44.99');

    const track = await page.locator('.range-track').evaluate(el => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, fill: el.querySelector('.range-fill').getBoundingClientRect().width };
    });
    assert.ok(track.fill > 0, 'The selected interval is visibly filled');
    await page.mouse.move(track.x + (44.99 - 20) / 60 * track.width, track.y + 22);
    await page.mouse.down();
    await page.mouse.move(track.x + 0.3 * track.width, track.y + 22, { steps: 8 });
    await page.mouse.up();
    assert.ok(Math.abs(Number(await field('start').inputValue()) - 38) < 0.3, 'Pointer dragging follows the time scale');
    await input('end', 20);
    assert.ok(Math.abs(Number(await field('end').inputValue()) - Number(await field('start').inputValue()) - 0.01) < 0.001);
    await page.locator('#range-end-current').click();
    assert.equal(await field('end').inputValue(), '45.00');
    const validStart = await field('start').inputValue();
    await field('start').fill('');
    await field('start').press('Tab');
    assert.equal(Number(await field('start').inputValue()), Number(validStart), 'Blank input cannot silently become zero');
    await page.locator('#range-heading').click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.RANGE_SCREENSHOT_PREFIX) {
        await page.locator('#range-editor').screenshot({ path: `${process.env.RANGE_SCREENSHOT_PREFIX}-${width}.png` });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: shared scale, clamped boundaries, pointer and keyboard edits, current-position actions, fixed playhead, blank input, three widths');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
