// Verifies Ticket #65 (ADR 0010): Collapsible desktop library sidebar with reload persistence,
// narrow-viewport slide-out drawer (768x900 & 390x844), Alt+ArrowUp/Alt+ArrowDown shortcuts
// with focus/dialog guards, whole-workspace drag-and-drop with New badge (no auto-switch when
// non-empty, auto-select first when empty), and full-page 2-step empty onboarding.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function settleFrames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function assertDesktopZeroScroll(page, width, height, label) {
  await page.setViewportSize({ width, height });
  await settleFrames(page);
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    headerHeight: document.querySelector('.header-inner')?.getBoundingClientRect().height || 0,
  }));
  assert.ok(m.scrollWidth <= m.innerWidth, `${label} (${width}x${height}) horizontal overflow: ${m.scrollWidth} > ${m.innerWidth}`);
  assert.ok(m.scrollHeight <= m.innerHeight, `${label} (${width}x${height}) vertical overflow: ${m.scrollHeight} > ${m.innerHeight}`);
  assert.equal(m.headerHeight, 54, `${label} (${width}x${height}) header height must stay 54px`);
}

async function assertNarrowZeroHorizontalOverflow(page, width, height, label) {
  await page.setViewportSize({ width, height });
  await settleFrames(page);
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(m.scrollWidth <= m.innerWidth, `${label} (${width}x${height}) horizontal overflow: ${m.scrollWidth} > ${m.innerWidth}`);
}

async function dispatchSyntheticFileDrop(page, targetSelector, { name, bytes, mimeType = 'video/mp4' }) {
  await page.evaluate(({ selector, fileName, byteArr, type }) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Drop target not found: ${selector}`);
    const file = new File([new Uint8Array(byteArr)], fileName, { type, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { selector: targetSelector, fileName: name, byteArr: Array.from(bytes), type: mimeType });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const baseUrl = new URL(process.env.REVIEW_URL || 'http://127.0.0.1:8792/');
    const previewUrl = (query) => {
      const next = new URL(baseUrl.href);
      next.search = query;
      return next.href;
    };

    // -------------------------------------------------------------------------
    // 1. Empty always-split workspace with sidebar intake controls (?workspacePreview=empty)
    // -------------------------------------------------------------------------
    await page.goto(previewUrl('?workspacePreview=empty'));
    await page.locator('#workspace-preview-banner[data-ready="true"]').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-layout'), 'split');
    assert.equal(await page.locator('#empty-onboarding').count(), 0);
    assert.equal(await page.locator('#global-session-controls').count(), 0);
    assert.equal(await page.locator('#sidebar-intake-controls').isVisible(), true);
    assert.equal(await page.locator('#review-page').isVisible(), true);
    assert.equal(await page.locator('#sidebar-watch-value').textContent(), 'Not set');
    assert.equal(await page.locator('#sidebar-intake-settings-btn').isVisible(), true);
    assert.equal(await page.locator('#import-files').isVisible(), true);
    assert.equal(await page.locator('#queue .empty').isVisible(), true);

    await assertDesktopZeroScroll(page, 1440, 900, 'empty-split-en');
    await assertDesktopZeroScroll(page, 1280, 800, 'empty-split-en');

    // Toggle to Chinese and verify sidebar intake labels & mock callbacks
    await page.locator('#lang-toggle').click();
    assert.equal(await page.locator('#sidebar-watch-value').textContent(), '未选择');
    assert.equal(await page.locator('#import-files .import-files-label').textContent(), '导入视频');

    await assertDesktopZeroScroll(page, 1440, 900, 'empty-split-zh');
    await assertDesktopZeroScroll(page, 1280, 800, 'empty-split-zh');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await settleFrames(page);
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/ux-empty-split-1440-zh.png` });
    }

    // Click sidebar Watch Folder and toggle Live Audio Analysis inside unified Auto-Intake Settings popover
    await page.locator('#sidebar-watch-btn').click();
    assert.match(await page.locator('#sidebar-watch-value').textContent(), /Apex Captures/);
    await page.locator('#sidebar-intake-settings-btn').click();
    await page.locator('#sidebar-live-toggle').click();
    assert.equal(await page.locator('#sidebar-live-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#sidebar-live-pill').textContent(), '实时中');
    await page.keyboard.press('Escape');

    // Narrow viewport zero horizontal overflow on empty always-split workspace
    await assertNarrowZeroHorizontalOverflow(page, 768, 900, 'empty-split-768');
    await assertNarrowZeroHorizontalOverflow(page, 390, 844, 'empty-split-390');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/ux-empty-split-390-zh.png`, fullPage: true });
    }

    // -------------------------------------------------------------------------
    // 2. Collapsible desktop sidebar + reload persistence (?workspacePreview=mixed)
    // -------------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(previewUrl('?workspacePreview=mixed'));
    await page.locator('#workspace-preview-banner[data-ready="true"]').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#clipping-workspace')?.dataset.layout === 'split');

    // Expanded by default
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-sidebar-collapsed'), 'false');
    assert.equal(await page.locator('#sidebar-collapse-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#library-drawer-toggle').isVisible(), false, 'Drawer toggle must be hidden on desktop');

    // Verify mixed preview has New badges on non-active rows, NOT on active row
    const initialNewCheck = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#queue .file.library-row')];
      return rows.map((r) => ({
        id: r.dataset.sourceId,
        selected: r.dataset.selected === 'true',
        isNew: r.dataset.new === 'true',
        badgeVisible: !r.querySelector('.library-new-badge').hidden,
        badgeText: r.querySelector('.library-new-badge').textContent,
      }));
    });
    assert.equal(initialNewCheck[0].selected, true);
    assert.equal(initialNewCheck[0].isNew, false, 'Active row must not display New badge');
    assert.ok(initialNewCheck.some((r) => r.isNew && r.badgeVisible && r.badgeText === '新'), 'Non-active rows show 新 badge');

    const expandedGeometry = await page.evaluate(() => ({
      sidebarWidth: document.querySelector('#analysis-page').getBoundingClientRect().width,
      reviewWidth: document.querySelector('#review-page').getBoundingClientRect().width,
    }));
    assert.ok(expandedGeometry.sidebarWidth >= 240, `Expected expanded sidebar >= 240px, got ${expandedGeometry.sidebarWidth}`);

    // Collapse desktop sidebar
    await page.locator('#sidebar-collapse-toggle').click();
    await page.waitForTimeout(240); // allow grid transition to settle
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-sidebar-collapsed'), 'true');
    assert.equal(await page.locator('#sidebar-collapse-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => localStorage.getItem('apex_local_cut_library_collapsed')), '1');

    const collapsedCheck = await page.evaluate(() => {
      const sidebarRect = document.querySelector('#analysis-page').getBoundingClientRect();
      const reviewRect = document.querySelector('#review-page').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#queue .file.library-row')].map((row) => ({
        title: row.title,
        isNew: row.dataset.new === 'true',
        filenameVisible: getComputedStyle(row.querySelector('.library-row-identity')).display !== 'none',
        statusBadgeVisible: getComputedStyle(row.querySelector('.library-row-status')).display !== 'none',
        summaryVisible: getComputedStyle(row.querySelector('.library-row-summary')).display !== 'none',
        railVisible: getComputedStyle(row.querySelector('.library-rail-cell')).display !== 'none',
        railTime: row.querySelector('.library-rail-time')?.textContent,
        railDotStatus: row.querySelector('.library-rail-dot')?.dataset.status,
        railNewDotHidden: row.querySelector('.library-rail-new-dot')?.hidden,
      }));
      const intakeRail = {
        watchDotVisible: getComputedStyle(document.querySelector('#sidebar-watch-btn .intake-dot')).display !== 'none',
        watchLabelVisible: getComputedStyle(document.querySelector('#sidebar-watch-btn .intake-label')).display !== 'none',
        settingsVisible: getComputedStyle(document.querySelector('#sidebar-intake-settings-btn')).display !== 'none',
      };
      return { sidebarWidth: sidebarRect.width, reviewWidth: reviewRect.width, rows, intakeRail };
    });

    assert.equal(collapsedCheck.intakeRail.watchDotVisible, true, 'Collapsed rail must retain unified intake status dot');
    assert.equal(collapsedCheck.intakeRail.watchLabelVisible, false, 'Collapsed rail must hide Watch Folder text label');
    assert.equal(collapsedCheck.intakeRail.settingsVisible, false, 'Collapsed rail must hide settings gear button');

    assert.ok(collapsedCheck.sidebarWidth <= 84, `Collapsed rail should be slim (<= 84px), got ${collapsedCheck.sidebarWidth}`);
    assert.ok(
      collapsedCheck.reviewWidth > expandedGeometry.reviewWidth + 150,
      `Right review pane must reclaim collapsed width (${collapsedCheck.reviewWidth} vs ${expandedGeometry.reviewWidth})`,
    );
    for (const row of collapsedCheck.rows) {
      assert.equal(row.filenameVisible, false, 'Collapsed rail must hide filename text');
      assert.equal(row.statusBadgeVisible, false, 'Collapsed rail must hide full status text badge');
      assert.equal(row.summaryVisible, false, 'Collapsed rail must hide candidate summary text');
      assert.equal(row.railVisible, true, 'Collapsed rail cell must be visible');
      assert.match(row.railTime, /^\d{2}:\d{2}$/, `Rail must display HH:MM time, got ${row.railTime}`);
      assert.ok(row.railDotStatus, 'Rail must show status dot');
      assert.ok(row.title.length > 0 && !row.title.includes('/') && !row.title.includes('\\'), 'Rail row hover title must preserve full basename');
      assert.equal(row.railNewDotHidden, !row.isNew, 'Rail New dot must reflect isNew state');
    }

    await assertDesktopZeroScroll(page, 1440, 900, 'collapsed-rail-1440');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/ux-collapsed-rail-1440-zh.png` });
    }
    await assertDesktopZeroScroll(page, 1280, 800, 'collapsed-rail-1280');

    // Reload page -> collapsed preference MUST persist!
    await page.reload();
    await page.locator('#workspace-preview-banner[data-ready="true"]').waitFor({ timeout: 15000 });
    assert.equal(
      await page.locator('#clipping-workspace').getAttribute('data-sidebar-collapsed'),
      'true',
      'Collapsed preference must persist across page reload',
    );

    // Expand back -> preference updates to '0' and persists
    await page.locator('#sidebar-collapse-toggle').click();
    await page.waitForTimeout(240);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-sidebar-collapsed'), 'false');
    assert.equal(await page.evaluate(() => localStorage.getItem('apex_local_cut_library_collapsed')), '0');

    // -------------------------------------------------------------------------
    // 3. Alt+ArrowUp / Alt+ArrowDown shortcuts + focus/dialog guards
    // -------------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    const rowIds = await page.evaluate(() => [...document.querySelectorAll('#queue .file.library-row')].map((r) => r.dataset.sourceId));
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[0]);

    // Alt+ArrowDown -> moves to row 1 (ws-preview-coarse) and clears its New badge
    assert.equal(await page.locator(`#queue .file[data-source-id="${rowIds[1]}"]`).getAttribute('data-new'), 'true');
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[1]);
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${rowIds[1]}"]`).getAttribute('data-new'),
      'false',
      'Opening a recording via Alt+ArrowDown must clear its 新 badge',
    );

    // Alt+ArrowDown again -> moves to row 2; Alt+ArrowUp -> moves back to row 1
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[2]);
    await page.keyboard.press('Alt+ArrowUp');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[1]);

    // Focus inside <select>, <input>, [contenteditable], and open <dialog> MUST NOT trigger Alt+ArrowDown
    await page.locator('#export-format').focus();
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[1], 'Must not switch while <select> focused');

    await page.evaluate(() => {
      const inp = document.createElement('input');
      inp.id = 'test-shortcut-input';
      document.body.append(inp);
      inp.focus();
    });
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[1], 'Must not switch while <input> focused');
    await page.evaluate(() => document.getElementById('test-shortcut-input')?.remove());

    await page.evaluate(() => {
      const dlg = document.createElement('dialog');
      dlg.id = 'test-shortcut-dialog';
      dlg.setAttribute('open', '');
      document.body.append(dlg);
      document.body.focus();
    });
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), rowIds[1], 'Must not switch while <dialog open>');
    await page.evaluate(() => document.getElementById('test-shortcut-dialog')?.remove());

    // Switching to Exports disables Alt+ArrowDown
    await page.locator('#nav-exports').click();
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.locator('#exports-section').isVisible(), true);
    await page.locator('#nav-analysis').click();

    // -------------------------------------------------------------------------
    // 4. Narrow-viewport slide-out drawer (768x900 & 390x844)
    // -------------------------------------------------------------------------
    // Collapse desktop sidebar first to verify narrow drawer ALWAYS expands full rows
    await page.locator('#sidebar-collapse-toggle').click();
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-sidebar-collapsed'), 'true');

    await assertNarrowZeroHorizontalOverflow(page, 768, 900, 'narrow-split-closed-768');
    assert.equal(await page.locator('#library-drawer-toggle').isVisible(), true);
    assert.equal(await page.locator('#library-drawer-count').textContent(), '5');
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'false');

    // Open drawer at 768px -> full rows visible, backdrop visible, zero horizontal overflow
    await page.locator('#library-drawer-toggle').click();
    await page.waitForTimeout(240);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'true');
    assert.equal(await page.locator('#library-drawer-toggle').getAttribute('aria-expanded'), 'true');
    await assertNarrowZeroHorizontalOverflow(page, 768, 900, 'narrow-split-open-768');
    const drawerRowVisible = await page.evaluate(() => {
      const row = document.querySelector('#queue .file.library-row');
      return getComputedStyle(row.querySelector('.library-filename')).display !== 'none'
        && getComputedStyle(row.querySelector('.library-rail-cell')).display === 'none';
    });
    assert.equal(drawerRowVisible, true, 'Narrow slide-out drawer must show full expanded rows even when desktop collapsed pref is true');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/ux-narrow-drawer-768-zh.png` });
    }

    // Backdrop click closes drawer
    await page.locator('#library-drawer-backdrop').click({ position: { x: 700, y: 400 } });
    await page.waitForTimeout(220);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'false');

    // Escape closes drawer (without resetting active timeline zoom)
    await page.locator('#library-drawer-toggle').click();
    await page.waitForTimeout(220);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'true');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'false');

    // Selecting a recording in drawer switches active recording, clears 新 badge, and auto-closes drawer
    await assertNarrowZeroHorizontalOverflow(page, 390, 844, 'narrow-split-closed-390');
    await page.locator('#library-drawer-toggle').click();
    await page.waitForTimeout(240);
    await assertNarrowZeroHorizontalOverflow(page, 390, 844, 'narrow-split-open-390');
    if (process.env.REVIEW_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/ux-narrow-drawer-390-zh.png` });
    }
    const targetRowId = rowIds[3]; // ws-preview-unanalyzed (starts with New badge)
    assert.equal(await page.locator(`#queue .file[data-source-id="${targetRowId}"]`).getAttribute('data-new'), 'true');
    await page.locator(`#queue .file[data-source-id="${targetRowId}"]`).click();
    await page.waitForTimeout(240);
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), targetRowId);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-drawer-open'), 'false', 'Selecting a recording must auto-close narrow drawer');
    assert.equal(await page.locator(`#queue .file[data-source-id="${targetRowId}"]`).getAttribute('data-new'), 'false');

    // Reset collapse pref before real-media test
    await page.evaluate(() => localStorage.removeItem('apex_local_cut_library_collapsed'));

    // -------------------------------------------------------------------------
    // 5. Real whole-workspace drag-and-drop: empty auto-select vs non-empty New badge without switching
    // -------------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(baseUrl.href);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-layout'), 'split');

    const mediaBytes1 = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const file = await createSyntheticFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    });

    // Drop 1st video directly onto #source-canvas (outside #drop-zone!) -> auto-selects 1st recording, NO 新 badge
    await dispatchSyntheticFileDrop(page, '#source-canvas', {
      name: 'match-first-drop.mp4',
      bytes: mediaBytes1,
    });
    await page.waitForFunction(
      () => document.querySelector('#clipping-workspace')?.dataset.layout === 'split'
        && Boolean(window.reviewApp.activeSourceId)
        && !window.reviewApp.activeSourceId.startsWith('runtime:'),
      null,
      { timeout: 60000 },
    );

    const firstId = await page.evaluate(() => {
      const id = window.reviewApp.activeSourceId;
      window.reviewApp.workspace.addManual(id, { start: 1, end: 3 });
      return id;
    });
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${firstId}"]`).getAttribute('data-new'),
      'false',
      'First recording dropped into empty library must auto-select with New badge cleared',
    );

    // Dragging over right review pane (#source-canvas) lights up workspace-wide drop cue
    const dragCueVisible = await page.evaluate(() => {
      const canvas = document.querySelector('#source-canvas');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3])], 'hover.mp4', { type: 'video/mp4' }));
      canvas.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const active = document.querySelector('#clipping-workspace')?.dataset.dragOver === 'true'
        && getComputedStyle(document.querySelector('#workspace-drop-overlay')).display !== 'none';
      document.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return active;
    });
    assert.equal(dragCueVisible, true, 'Dragging files over right review pane must show workspace-wide drop highlight');

    // Drop 2nd distinct video directly onto #source-canvas (right review pane!)
    const mediaBytes2 = Buffer.from(mediaBytes1);
    mediaBytes2[mediaBytes2.length - 1] = (mediaBytes2[mediaBytes2.length - 1] + 1) & 0xff;
    await dispatchSyntheticFileDrop(page, '#source-canvas', {
      name: 'match-second-drop.mp4',
      bytes: mediaBytes2,
    });
    await page.waitForFunction(
      () => window.reviewApp.workspace.view().sources.length >= 2,
      null,
      { timeout: 60000 },
    );

    const afterSecondDrop = await page.evaluate((origId) => {
      const sources = window.reviewApp.workspace.view().sources;
      const second = sources.find((s) => s.id !== origId);
      const secondRow = document.querySelector(`#queue .file[data-source-id="${second?.id}"]`);
      return {
        activeSourceId: window.reviewApp.activeSourceId,
        secondId: second?.id || null,
        secondDataNew: secondRow?.dataset.new,
        secondBadgeHidden: secondRow?.querySelector('.library-new-badge')?.hidden,
        origDecisionsCount: window.reviewApp.workspace.getSource(origId)?.decisions?.length || 0,
      };
    }, firstId);

    assert.equal(afterSecondDrop.activeSourceId, firstId, 'Dropping video into non-empty workspace MUST NOT switch active recording');
    assert.ok(afterSecondDrop.secondId);
    assert.equal(afterSecondDrop.secondDataNew, 'true', 'Newly dropped recording must have New badge');
    assert.equal(afterSecondDrop.secondBadgeHidden, false, 'New badge must be visible');
    assert.ok(afterSecondDrop.origDecisionsCount >= 1, 'Manual review decisions on active recording must stay preserved');

    // Opening the newly dropped recording clears its New badge
    await page.locator(`#queue .file[data-source-id="${afterSecondDrop.secondId}"]`).click();
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), afterSecondDrop.secondId);
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${afterSecondDrop.secondId}"]`).getAttribute('data-new'),
      'false',
      'Opening the newly dropped recording must clear its New badge',
    );

    assert.deepEqual(errors, [], `Expected zero page errors, got: ${errors.join('; ')}`);
    console.log('PASS: Ticket #65 workspace UX verified (empty onboarding, collapsible rail + reload persistence, narrow drawer 768/390, Alt+Up/Down shortcuts, whole-workspace drop & New badge)');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
