// Verifies Ticket #59: Recording Library pure view & mock preview across desktop (1440x900) and narrow (390x844) viewports.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const baseUrl = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8792/');
    const previewUrl = (scenario) => {
      const next = new URL(baseUrl.href);
      next.search = `?libraryPreview=${scenario}`;
      return next.href;
    };

    // 1. Desktop 1440x900: mixed scenario (English default -> toggle Chinese)
    await page.goto(previewUrl('mixed'));
    await page.locator('.library-preview-banner[data-ready="true"]').waitFor({ timeout: 10000 });

    assert.equal(await page.locator('#nav-analysis').textContent(), 'Clip');
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Recording Library');
    assert.equal(await page.locator('#queue .file.library-row').count(), 5);

    const enCheck = await page.evaluate(() => {
      const header = document.querySelector('.header-inner');
      const rows = [...document.querySelectorAll('#queue .file.library-row')].map((row) => ({
        status: row.dataset.status,
        badge: row.querySelector('.library-status-badge')?.textContent,
        filename: row.querySelector('.library-filename')?.textContent,
        meta: row.querySelector('.library-meta')?.textContent,
        summary: row.querySelector('.library-summary-text')?.textContent,
        actions: [...row.querySelectorAll('.library-row-actions button')]
          .filter((b) => !b.hidden)
          .map((b) => ({ action: b.dataset.action, text: b.textContent })),
        hasCanvas: row.querySelectorAll('canvas').length > 0,
        hasProgress: row.querySelectorAll('progress').length > 0,
        rowText: row.innerText,
      }));
      const topbarText = document.querySelector('#library-topbar-slots')?.innerText || '';
      const bodyText = document.body.innerText;
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        headerHeight: header.getBoundingClientRect().height,
        headerOverflow: header.scrollWidth > header.clientWidth,
        topbarText,
        rows,
        hasForbiddenQueueTerm: /analysis queue|分析队列/i.test(bodyText),
        hasPathLeakInTopbar: topbarText.includes('/Users/') || topbarText.includes('C:\\'),
      };
    });

    assert.equal(enCheck.overflow, false, 'Desktop 1440px should have zero horizontal overflow');
    assert.equal(enCheck.headerHeight, 54, 'Desktop header should stay strictly 54px');
    assert.equal(enCheck.headerOverflow, false);
    assert.equal(enCheck.hasForbiddenQueueTerm, false, 'Must not contain Analysis Queue / 分析队列');
    assert.equal(enCheck.hasPathLeakInTopbar, false, 'Watch folder topbar slot must show basename only');
    assert.match(enCheck.topbarText, /Apex Captures/);
    assert.match(enCheck.topbarText, /Live Monitor/);

    // Verify merged 4 statuses (both exact conform & offline complete map to 'ready' / 'Ready')
    const badgesEn = new Set(enCheck.rows.map((row) => row.status));
    assert.deepEqual([...badgesEn].sort(), ['analyzing', 'conformed-coarse', 'ready', 'unanalyzed']);
    assert.equal(enCheck.rows.filter((r) => r.status === 'ready').length, 2, 'Exact conform and offline complete both map to ready');

    for (const row of enCheck.rows) {
      assert.equal(row.hasCanvas, false, 'Rows must not include inline waveforms');
      assert.equal(row.hasProgress, false, 'Rows must not include progress bars');
      assert.equal(row.filename.includes('/'), false);
      assert.equal(row.filename.includes('\\'), false);
      assert.equal(row.rowText.includes('Apex Captures'), false, 'Directory name must never repeat in rows');
      assert.equal(/correlation|offset|\bms\b/i.test(row.rowText), false, 'Rows must not leak technical alignment metrics');
    }

    const readyRow = enCheck.rows.find((r) => r.status === 'ready');
    assert.equal(readyRow.badge, 'Ready');
    assert.deepEqual(readyRow.actions, [{ action: 'review', text: 'Review' }]);

    const coarseRow = enCheck.rows.find((r) => r.status === 'conformed-coarse');
    assert.equal(coarseRow.badge, 'Ready ⚠ Coarse');
    assert.deepEqual(coarseRow.actions, [
      { action: 'review', text: 'Review' },
      { action: 'reanalyze', text: 'Re-analyze' },
    ]);

    const analyzingRow = enCheck.rows.find((r) => r.status === 'analyzing');
    assert.equal(analyzingRow.badge, 'Analyzing 62%');
    assert.deepEqual(analyzingRow.actions, [{ action: 'stop', text: 'Stop' }]);

    const unanalyzedRow = enCheck.rows.find((r) => r.status === 'unanalyzed');
    assert.equal(unanalyzedRow.badge, 'Unanalyzed');
    assert.deepEqual(unanalyzedRow.actions, [{ action: 'analyze', text: 'Start Analysis' }]);

    // 2. Toggle Chinese and verify zh copy + exact 4 merged badges
    await page.locator('#lang-toggle').click();
    assert.equal(await page.locator('#nav-analysis').textContent(), '选片');
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '录像库');
    const zhBadges = await page.locator('#queue .library-status-badge').allTextContents();
    assert.deepEqual(zhBadges, ['已就绪', '已就绪 ⚠ 粗略', '分析中 62%', '未分析', '已就绪']);

    const zhSummaries = await page.locator('#queue .library-summary-text').allTextContents();
    assert.equal(zhSummaries[0], '7 处候选 · 已导出 2');
    assert.equal(zhSummaries[1], '5 处候选');
    assert.equal(zhSummaries[4], '9 处候选 · 已导出 4');

    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/library-desktop-1440-zh.png`, fullPage: true });
    }

    // 3. Interactive mock callbacks (zero backend engines)
    await page.locator('[data-action="toggle-live-monitor"]').click();
    assert.equal(await page.locator('[data-slot="live-monitor"]').getAttribute('data-live-status'), 'off');

    await page.locator('[data-action="choose-watch-directory"]').click();
    assert.match(await page.locator('[data-slot="watch-directory"] .library-slot-value').textContent(), /OBS Recordings/);

    await page.locator('#queue .file[data-status="unanalyzed"] [data-action="analyze"]').click();
    assert.equal(await page.locator('#queue .file[data-status="unanalyzed"]').count(), 0);
    await page.locator('#queue .file[data-status="analyzing"] [data-action="stop"]').first().click();
    assert.equal(await page.locator('#queue .file[data-status="unanalyzed"]').count(), 1);

    // 4. Narrow viewport (390x844) on mixed + long + empty scenarios
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(previewUrl('mixed'));
    await page.locator('.library-preview-banner[data-ready="true"]').waitFor({ timeout: 10000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'Narrow 390px mixed scenario should have zero horizontal overflow',
    );
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/library-narrow-390-zh.png`, fullPage: true });
    }

    await page.goto(previewUrl('long'));
    await page.locator('.library-preview-banner[data-ready="true"]').waitFor({ timeout: 10000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'Narrow 390px long-filename scenario should have zero horizontal overflow',
    );

    await page.goto(previewUrl('empty'));
    await page.locator('.library-preview-banner[data-ready="true"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#queue .empty').isVisible(), true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'Narrow 390px empty scenario should have zero horizontal overflow',
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('#queue .empty').isVisible(), true);
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/library-desktop-1440-empty.png`, fullPage: true });
    }

    assert.deepEqual(errors, [], `Expected zero page errors, got: ${errors.join('; ')}`);
    console.log('PASS: Recording Library pure view & mock preview verified at desktop (1440x900) and narrow (390x844)');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
