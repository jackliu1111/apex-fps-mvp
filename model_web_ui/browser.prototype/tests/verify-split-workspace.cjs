// Verifies Ticket #64 (ADR 0010): Split-pane Local Clipping Workspace at 1440x900 and 1280x800
// with zero vertical & horizontal scroll, flat sidebar rows, 4 merged statuses, single review-header CTA,
// 2-tab navigation, selection stability, and end-to-end local import + offline analysis control.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function assertZeroScroll(page, width, height, label) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('.header-inner');
    const navButtons = [...document.querySelectorAll('#offline-nav button')];
    const wrapped = navButtons.filter((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return new Set([...range.getClientRects()].map((rect) => rect.top)).size > 1;
    }).map((item) => item.textContent);
    const panel = document.querySelector('#analysis-page .queue-panel');
    const importBtn = document.querySelector('#import-files');
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    const importRect = importBtn ? importBtn.getBoundingClientRect() : null;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      headerHeight: header ? header.getBoundingClientRect().height : 0,
      headerOverflow: header ? header.scrollWidth > header.clientWidth : false,
      wrapped,
      importClipped: Boolean(panelRect && importRect && importRect.width > 0 && importRect.right > panelRect.right + 1),
    };
  });
  assert.ok(
    metrics.scrollWidth <= metrics.innerWidth,
    `${label} (${width}x${height}) horizontal overflow: ${metrics.scrollWidth} > ${metrics.innerWidth}`,
  );
  assert.ok(
    metrics.scrollHeight <= metrics.innerHeight,
    `${label} (${width}x${height}) vertical overflow: ${metrics.scrollHeight} > ${metrics.innerHeight}`,
  );
  assert.equal(metrics.headerHeight, 54, `${label} (${width}x${height}) header height must be 54px`);
  assert.equal(metrics.headerOverflow, false, `${label} (${width}x${height}) header must not overflow`);
  assert.deepEqual(metrics.wrapped, [], `${label} (${width}x${height}) nav buttons must not wrap`);
  assert.equal(metrics.importClipped, false, `${label} (${width}x${height}) sidebar import button must not clip`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const baseUrl = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8792/');
    const previewUrl = (scenario) => {
      const next = new URL(baseUrl.href);
      next.search = `?workspacePreview=${scenario}`;
      return next.href;
    };

    // 1. Mock preview (?workspacePreview=mixed): English + Chinese, 1440x900 & 1280x800
    await page.goto(previewUrl('mixed'));
    await page.locator('#workspace-preview-banner[data-ready="true"]').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#clipping-workspace')?.dataset.layout === 'split');

    // Verify 2-tab nav and removal of legacy review controls
    assert.equal(await page.locator('#offline-nav button').count(), 2);
    assert.equal(await page.locator('#nav-analysis').textContent(), 'Clip');
    assert.equal(await page.locator('#nav-exports').textContent(), 'Exports');
    assert.equal(await page.locator('#nav-review').count(), 0);
    assert.equal(await page.locator('#source-select').count(), 0);
    assert.equal(await page.locator('#back-analysis').count(), 0);

    await assertZeroScroll(page, 1440, 900, 'workspacePreview-mixed-en');
    await assertZeroScroll(page, 1280, 800, 'workspacePreview-mixed-en');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/split-workspace-1280-en.png` });
    }

    // Toggle to Chinese and verify zero scroll & ADR 0010 labels
    await page.locator('#lang-toggle').click();
    assert.equal(await page.locator('#nav-analysis').textContent(), '选片');
    assert.equal(await page.locator('#nav-exports').textContent(), '导出任务');

    await assertZeroScroll(page, 1440, 900, 'workspacePreview-mixed-zh');
    await assertZeroScroll(page, 1280, 800, 'workspacePreview-mixed-zh');

    // Verify flat sidebar rows (4 merged statuses, zero file size/path, zero inline buttons, tooltip full basename)
    const sidebarCheck = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#queue .file.library-row')].map((row) => ({
        id: row.dataset.sourceId,
        status: row.dataset.status,
        selected: row.dataset.selected === 'true',
        filename: row.querySelector('.library-filename')?.textContent,
        title: row.querySelector('.library-filename')?.title,
        meta: row.querySelector('.library-meta')?.textContent,
        badge: row.querySelector('.library-status-badge')?.textContent,
        summary: row.querySelector('.library-summary-text')?.textContent,
        buttonCount: row.querySelectorAll('button').length,
        innerText: row.innerText,
      }));
      return {
        rows,
        hasForbiddenTerms: /分析队列|录像库页|复核页/.test(document.body.innerText),
      };
    });

    assert.equal(sidebarCheck.hasForbiddenTerms, false, 'Must not contain forbidden domain terms');
    assert.equal(sidebarCheck.rows.length, 5);
    assert.deepEqual(
      sidebarCheck.rows.map((r) => r.badge),
      ['已就绪', '已就绪 ⚠ 粗略', '分析中 62%', '未分析', '已就绪'],
    );
    for (const row of sidebarCheck.rows) {
      assert.equal(row.buttonCount, 0, 'Sidebar rows must not contain inline action buttons');
      assert.equal(/\b(?:GB|MB|KB)\b/.test(row.innerText), false, 'Sidebar rows must not show file size');
      assert.equal(row.filename.includes('/') || row.filename.includes('\\'), false, 'Sidebar filename must be basename only');
      assert.equal(row.title, row.filename, 'Hover tooltip must expose full basename');
    }

    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/split-workspace-1440-zh.png` });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/split-workspace-1280-zh.png` });
    }

    // Verify clicking ANY row across all 4 statuses opens it & resolves the single review-header primary CTA
    // 1. First row (ready) -> primary CTA hidden
    assert.equal(await page.locator('#review-primary-action').isHidden(), true);

    // 2. Coarse row -> 重新离线分析 -> click -> transitions to analyzing (停止) while staying selected
    await page.locator('#queue .file[data-status="conformed-coarse"]').click();
    assert.equal(await page.locator('#review-primary-action').isVisible(), true);
    assert.equal(await page.locator('#review-primary-action').textContent(), '重新离线分析');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/split-workspace-1440-coarse-zh.png` });
    }
    const coarseId = await page.evaluate(() => window.reviewApp.activeSourceId);
    await page.locator('#review-primary-action').click();
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), coarseId, 'Primary CTA must preserve active selection');
    assert.equal(await page.locator('#review-primary-action').textContent(), '停止');

    // 3. Stop -> transitions to unanalyzed (开始分析) while staying selected
    await page.locator('#review-primary-action').click();
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), coarseId);
    assert.equal(await page.locator('#review-primary-action').textContent(), '开始分析');

    // 4. Start analysis -> transitions back to analyzing (停止)
    await page.locator('#review-primary-action').click();
    assert.equal(await page.locator('#review-primary-action').textContent(), '停止');

    // 5. Switch to Exports and back to Clip (选片) -> preserves active selection
    await page.locator('#nav-exports').click();
    assert.equal(await page.locator('#exports-section').isVisible(), true);
    assert.equal(await page.locator('#clipping-workspace').isHidden(), true);
    await page.locator('#nav-analysis').click();
    assert.equal(await page.locator('#clipping-workspace').isVisible(), true);
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), coarseId);

    // 2. Empty scenario (?workspacePreview=empty)
    await page.goto(previewUrl('empty'));
    await page.locator('#workspace-preview-banner[data-ready="true"]').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-layout'), 'empty');
    assert.equal(await page.locator('#review-page').isHidden(), true);
    assert.equal(await page.locator('#queue .empty').isVisible(), true);

    // 3. End-to-end real synthetic recording import (without preview param): empty -> split -> zero scroll -> stability
    await page.goto(baseUrl.href);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-layout'), 'empty');

    const mediaBytes = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const file = await createSyntheticFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    });

    await page.locator('#files').setInputFiles({
      name: 'match-alpha.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from(mediaBytes),
    });
    await page.waitForFunction(
      () => document.querySelector('#clipping-workspace')?.dataset.layout === 'split'
        && Boolean(window.reviewApp.activeSourceId)
        && !window.reviewApp.activeSourceId.startsWith('runtime:'),
      null,
      { timeout: 60000 },
    );

    await assertZeroScroll(page, 1440, 900, 'real-split-1440');
    await assertZeroScroll(page, 1280, 800, 'real-split-1280');

    // Add a manual review clip on match-alpha, then import a 2nd distinct file -> selection must stay on match-alpha!
    const alphaId = await page.evaluate(() => {
      const id = window.reviewApp.activeSourceId;
      window.reviewApp.workspace.addManual(id, { start: 1, end: 3 });
      return id;
    });

    const mediaBytes2 = Buffer.from(mediaBytes);
    mediaBytes2[mediaBytes2.length - 1] = (mediaBytes2[mediaBytes2.length - 1] + 1) & 0xff;
    await page.locator('#files').setInputFiles({
      name: 'match-beta.mp4',
      mimeType: 'video/mp4',
      buffer: mediaBytes2,
    });
    await page.waitForFunction(() => document.querySelectorAll('#queue .file.library-row').length >= 2, null, { timeout: 60000 });
    assert.equal(
      await page.evaluate(() => window.reviewApp.activeSourceId),
      alphaId,
      'Importing a second recording must not jump active selection away from currently reviewed recording',
    );
    assert.equal(
      await page.evaluate((id) => window.reviewApp.workspace.getSource(id).decisions.length >= 1, alphaId),
      true,
      'Manual review decisions must remain preserved',
    );

    assert.deepEqual(errors, [], `Expected zero page errors, got: ${errors.join('; ')}`);
    console.log('PASS: split-pane Local Clipping Workspace verified at 1440x900 & 1280x800 with zero scroll');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
