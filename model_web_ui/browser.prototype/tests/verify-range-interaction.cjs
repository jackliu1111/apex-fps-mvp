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
    await page.locator('.precise-editor > summary').click();
    assert.equal(await page.locator('.local-range, #range-start-handle, #range-end-handle').count(), 0,
      'Duplicate dual-range sliders are removed in favor of the primary timeline handles');
    const field = key => page.locator(`#range-${key}`);
    const handle = key => page.locator(`#selection-${key === 'start' ? 'left' : 'right'}`);
    const axis = await page.locator('#source-axis').boundingBox();
    assert.ok(axis.width > 0);
    // Dragging the start handle past the end boundary clamps to end - 0.1s
    const leftBox = await handle('start').boundingBox();
    await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(axis.x + (75 - 20) / 60 * axis.width, leftBox.y + 20, { steps: 8 });
    await page.mouse.up();
    assert.equal(await field('start').inputValue(), '59.90', 'Crossing clamps instead of rejecting the drag');
    assert.equal(await field('end').inputValue(), '60.00');
    await page.evaluate(() => reviewApp.workspace.setReview('range-test', { position: 45 }));
    await page.locator('#range-start-current').click();
    assert.equal(await field('start').inputValue(), '45.00');
    await handle('start').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await field('start').inputValue(), '44.90');

    const draggedLeft = await handle('start').boundingBox();
    await page.mouse.move(draggedLeft.x + draggedLeft.width / 2, draggedLeft.y + 20);
    await page.mouse.down();
    await page.mouse.move(axis.x + 0.3 * axis.width, draggedLeft.y + 20, { steps: 8 });
    await page.mouse.up();
    assert.ok(Math.abs(Number(await field('start').inputValue()) - 38) < 0.3, 'Pointer dragging follows the time scale');
    const rightBox = await handle('end').boundingBox();
    await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(axis.x, rightBox.y + 20, { steps: 8 });
    await page.mouse.up();
    assert.ok(Math.abs(Number(await field('end').inputValue()) - Number(await field('start').inputValue()) - 0.1) < 0.01);
    await page.evaluate(() => reviewApp.workspace.setReview('range-test', { position: 45 }));
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
