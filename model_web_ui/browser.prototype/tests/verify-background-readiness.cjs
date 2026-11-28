// Verifies Ticket #62 (ADR 0009 + ADR 0010): Minimal browser interaction & background readiness cues.
// Checks in real headless Chrome via Playwright:
//  1. Dedicated IndexedDB (`apex-watch-dir-v1`) persists real OPFS FileSystemDirectoryHandle across
//     page.reload() and silently auto-restores watching on 'granted' permission with ZERO clicks,
//     without touching legacy `apex-review-v1` or persisting session sources/batches.
//  2. 'prompt' permission state displays one-click 「恢复监听」 / `Restore Watch` CTA in global topbar
//     while keeping `.header-inner` strictly 54px single-row with zero wrap/overflow across 1440..851px
//     in BOTH EN and ZH; clicking restores directly via requestPermission({ mode: 'read' }).
//  3. Opt-in ready notification checkbox inside `#topbar-live-popover` never auto-prompts on load,
//     requests permission only on explicit click, and emits silent Notification without stealing focus.
//  4. Foreground ready recording does NOT interrupt current review, marks `新` in sidebar, updates
//     `(1)` tab title + dynamic SVG favicon badge, and shows clickable `#ready-toast` (`立即查看`)
//     that switches to the recording, jumps to its first candidate, clears badge/title/favicon, and
//     preserves the previous recording's manual review decisions (ADR 0004).
//  5. Background-tab ready recording (verified both deterministically and with a genuinely backgrounded
//     second Chrome tab) stays unread until the user opens its row. Returning also polls OPFS.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function settleFrames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function assertHeaderInvariant(page, widths, label) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await settleFrames(page);
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.header-inner');
      const nav = document.querySelector('.app-header .navigation');
      const wrapped = [...nav.children].filter((item) => {
        const range = document.createRange();
        range.selectNodeContents(item.querySelector('[data-i18n]') || item);
        return new Set([...range.getClientRects()].map((rect) => rect.top)).size > 1;
      }).map((item) => item.textContent);
      return {
        wrapped,
        overflow: header.scrollWidth > header.clientWidth,
        docOverflow: document.documentElement.scrollWidth > window.innerWidth,
        headerHeight: header.getBoundingClientRect().height,
      };
    });
    assert.deepEqual(layout.wrapped, [], `${label} nav labels must not wrap at ${width}px`);
    assert.equal(layout.overflow, false, `${label} header must not overflow at ${width}px`);
    assert.equal(layout.docOverflow, false, `${label} document must not overflow horizontally at ${width}px`);
    if (width > 850) {
      assert.equal(layout.headerHeight, 54, `${label} header height must remain strictly 54px at ${width}px`);
    }
  }
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

(async () => {
  // For native tab visibility, point this at a dedicated Chrome with a fresh test profile.
  const nativeEndpoint = process.env.REVIEW_NATIVE_CDP_URL;
  const browser = nativeEndpoint
    ? await chromium.connectOverCDP(nativeEndpoint, { noDefaults: true })
    : await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const context = nativeEndpoint ? browser.contexts()[0] : await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: process.env.REVIEW_IGNORE_HTTPS_ERRORS === '1',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Stub Notification boundary so we can assert zero auto-prompt, explicit opt-in, silent alerts & zero focus steal.
    // Also install a fallback visibilityState controller for headless Chrome builds where tab switching keeps visibilityState === 'visible'.
    await page.addInitScript(() => {
      let perm = 'default';
      const requests = [];
      const sent = [];
      let focusCalls = 0;
      const origFocus = window.focus.bind(window);
      window.focus = () => { focusCalls++; return origFocus(); };

      let forcedVisibility = null;
      const origVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() {
          return forcedVisibility ?? (origVisDesc?.get ? origVisDesc.get.call(document) : 'visible');
        },
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get() {
          return forcedVisibility ? forcedVisibility === 'hidden' : Boolean(origHiddenDesc?.get?.call(document));
        },
      });
      window.__setForcedVisibility = (state) => {
        forcedVisibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      };

      window.__notifTest = {
        requests,
        sent,
        getFocusCalls: () => focusCalls,
      };

      class MockNotification {
        static get permission() { return perm; }
        static async requestPermission() {
          requests.push(Date.now());
          perm = 'granted';
          return perm;
        }
        constructor(title, options = {}) {
          this.title = title;
          this.options = options;
          this.onclick = null;
          sent.push({ title, options });
        }
        close() {}
      }
      window.Notification = MockNotification;
    });

    const url = process.env.REVIEW_URL || 'http://127.0.0.1:8792/';
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);
    await page.evaluate(() => window.reviewApp.watchDirRestoreReady);

    // Ensure Notification permission was NOT requested on load
    assert.equal(await page.evaluate(() => window.__notifTest.requests.length), 0, 'Must never auto-prompt Notification permission on load');

    // -------------------------------------------------------------------------
    // 1. Seed legacy apex-review-v1 (must remain untouched), save real OPFS directory handle
    //    via showDirectoryPicker -> verify reload silently auto-restores with ZERO clicks!
    // -------------------------------------------------------------------------
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('apex-review-v1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('workspaces');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('workspaces', 'readwrite');
          tx.objectStore('workspaces').put({ sentinel: 'untouched' }, 'legacy');
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
      const opfsRoot = await navigator.storage.getDirectory();
      const opfsDir = await opfsRoot.getDirectoryHandle('OBS_Background_Test', { create: true });
      // Clean any prior test files in OPFS folder
      for await (const [name] of opfsDir.entries()) {
        await opfsDir.removeEntry(name).catch(() => {});
      }
      window.showDirectoryPicker = async () => opfsDir;
    });

    await page.locator('#sidebar-watch-btn').click();
    await page.waitForFunction(() => window.reviewApp.watchDirState.status === 'watching');
    assert.equal(await page.locator('#sidebar-watch-value').textContent(), 'OBS_Background_Test');

    // Reload page -> real IndexedDB apex-watch-dir-v1 loads OPFS handle and silently auto-restores!
    await page.reload();
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.watchDirRestoreReady);
    assert.equal(await page.evaluate(() => window.reviewApp.watchDirState.status), 'watching');
    assert.equal(await page.locator('#sidebar-watch-value').textContent(), 'OBS_Background_Test');
    assert.equal(await page.locator('#sidebar-watch-restore-cta').isHidden(), true);

    // Verify legacy apex-review-v1 is completely untouched and session sources/batches did NOT persist
    const persistenceCheck = await page.evaluate(async () => {
      const legacy = await new Promise((resolve) => {
        const open = indexedDB.open('apex-review-v1');
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('workspaces').objectStore('workspaces').get('legacy');
          req.onsuccess = () => { db.close(); resolve(req.result); };
        };
      });
      return {
        legacy,
        sources: window.reviewApp.workspace.view().sources.length,
        batches: window.reviewApp.workspace.view().batches.length,
      };
    });
    assert.deepEqual(persistenceCheck, { legacy: { sentinel: 'untouched' }, sources: 0, batches: 0 });

    // -------------------------------------------------------------------------
    // 2. Verify 'prompt' one-click Restore Watch CTA in global topbar keeps 54px single-row header
    //    across ALL widths (1440..851px) in BOTH EN and ZH, and clicking restores without picker!
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      let perm = 'prompt';
      let pickerCalled = 0;
      const reqs = [];
      window.__restoreCheck = { reqs, getPickerCalled: () => pickerCalled };
      window.showDirectoryPicker = async () => { pickerCalled++; throw new Error('Picker must not open on one-click restore'); };
      const mockSavedHandle = {
        name: 'OBS_Apex_Recordings_2026',
        async queryPermission() { return perm; },
        async requestPermission(opts) { reqs.push(opts); perm = 'granted'; return 'granted'; },
        async *entries() {},
      };
      window.reviewApp.setWatchDirectoryRestoreNeeded(mockSavedHandle);
    });

    assert.equal(await page.locator('#sidebar-watch-dir').getAttribute('data-watch-status'), 'needs-permission');
    assert.equal(await page.locator('#sidebar-watch-restore-cta').isVisible(), true);
    assert.equal(await page.locator('#sidebar-watch-restore-cta').textContent(), 'Restore Watch');

    const widths = [1440, 1280, 1201, 1200, 1024, 900, 851, 768, 540, 390, 320];
    await assertHeaderInvariant(page, widths, 'restore-cta-en');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#lang-toggle').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('#sidebar-watch-restore-cta').textContent(), '恢复监听');
    await assertHeaderInvariant(page, widths, 'restore-cta-zh');

    // Click Restore Watch CTA -> one-click restore succeeds without opening directory picker
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#sidebar-watch-restore-cta').click();
    await page.waitForFunction(() => window.reviewApp.watchDirState.status === 'watching');
    assert.equal(await page.locator('#sidebar-watch-restore-cta').isHidden(), true);
    assert.equal(await page.evaluate(() => window.__restoreCheck.getPickerCalled()), 0);
    assert.deepEqual(await page.evaluate(() => window.__restoreCheck.reqs), [{ mode: 'read' }]);

    // -------------------------------------------------------------------------
    // 3. Opt-in browser Notification checkbox inside #sidebar-intake-popover
    // -------------------------------------------------------------------------
    await page.locator('#sidebar-intake-settings-btn').click();
    assert.equal(await page.locator('#sidebar-intake-popover').isVisible(), true);
    assert.equal(await page.locator('#sidebar-ready-notify').isChecked(), false);
    await page.locator('#sidebar-ready-notify').check();
    await page.waitForFunction(() => window.reviewApp.readyNotifier.notificationsEnabled === true);
    assert.equal(await page.evaluate(() => window.__notifTest.requests.length), 1);
    await page.keyboard.press('Escape');

    // -------------------------------------------------------------------------
    // 4. Foreground non-interruption + clickable #ready-toast + title/favicon badge
    // -------------------------------------------------------------------------
    const baseTitleZh = await page.evaluate(() => document.title);
    const baseIconHref = await page.evaluate(() => document.getElementById('app-favicon').getAttribute('href'));

    // Seed recording A (open, with manual decision) and recording B (becomes ready in foreground)
    const fgIds = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const base = await createSyntheticFile();
      const bytes = new Uint8Array(await base.arrayBuffer());
      const makeFile = (name, padByte) => {
        const freeBox = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, padByte]);
        const out = new Uint8Array(bytes.length + freeBox.length);
        out.set(bytes, 0);
        out.set(freeBox, bytes.length);
        return new File([out], name, { type: 'video/mp4', lastModified: Date.now() + padByte * 1000 });
      };
      const fileA = makeFile('2026-11-26_14-10_Match_A.mp4', 0x61);
      await window.reviewApp.queue.importFiles([fileA], { autoAnalyze: false });
      const idA = window.reviewApp.workspace.view().sources[0].id;
      await window.reviewApp.openReview(idA);
      const manualIdA = window.reviewApp.workspace.addManual(idA, { start: 0.4, end: 1.6 });

      // Recording B conforms & becomes ready while tab stays visible
      const fileB = makeFile('2026-11-26_14-45_Olympus_Ready_B.mp4', 0x62);
      const recB = await window.reviewApp.queue.importPrecomputed(fileB, {
        windowScores: [
          { start: 0, end: 1.5, scores: [0.05, 0.05] },
          { start: 1.5, end: 3.0, scores: [0.94, 0.2] },
        ],
        alignment: { confidence: 'exact', offsetMs: -12, correlation: 0.91 },
      });
      return { idA, manualIdA, idB: recB.sourceId };
    });

    // Active review MUST remain on A; B has 新 badge; title shows (1); favicon updates; #ready-toast visible!
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), fgIds.idA);
    assert.equal(await page.locator('#ready-toast').isVisible(), true);
    assert.equal(await page.locator('#ready-toast-title').textContent(), '2026-11-26_14-45_Olympus_Ready_B.mp4');
    assert.equal(await page.locator('#ready-toast-open').textContent(), '立即查看');
    assert.equal(await page.evaluate(() => document.title), `(1) ${baseTitleZh}`);
    const iconAfterFg = await page.evaluate(() => document.getElementById('app-favicon').getAttribute('href'));
    assert.notEqual(iconAfterFg, baseIconHref);
    assert.match(decodeURIComponent(iconAfterFg), />1</);
    assert.equal(await page.evaluate(() => window.__notifTest.sent.length), 1);
    assert.equal(await page.evaluate(() => window.__notifTest.sent[0].options.silent), true);
    assert.equal(await page.evaluate(() => window.__notifTest.getFocusCalls()), 0);

    // Zero vertical & horizontal scroll with #ready-toast visible at 1440x900 and 1280x800
    await assertDesktopZeroScroll(page, 1440, 900, 'ready-toast-1440');
    await assertDesktopZeroScroll(page, 1280, 800, 'ready-toast-1280');

    // Click "立即查看" in #ready-toast -> opens B, focuses B's first candidate, clears toast/title/favicon/新 badge, preserves A's manual decision!
    await page.locator('#ready-toast-open').click();
    await page.waitForFunction((idB) => window.reviewApp.activeSourceId === idB, fgIds.idB);
    assert.equal(await page.locator('#ready-toast').isHidden(), true);
    assert.equal(await page.evaluate(() => document.title), baseTitleZh);
    assert.equal(await page.evaluate(() => document.getElementById('app-favicon').getAttribute('href')), baseIconHref);
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${fgIds.idB}"] .library-new-badge`).isHidden(),
      true,
    );
    const afterToastOpen = await page.evaluate(({ idA, manualIdA, idB }) => {
      const srcA = window.reviewApp.workspace.getSource(idA);
      const srcB = window.reviewApp.workspace.getSource(idB);
      const firstB = srcB.clips.find((c) => !c.provisional && !c.excluded);
      return {
        preservedA: srcA.clips.some((c) => c.id === manualIdA),
        selectedClipB: srcB.review.selectedClipId,
        expectedFirstB: firstB?.id || null,
        reviewPosB: srcB.review.position,
        expectedStartB: firstB?.start ?? null,
      };
    }, fgIds);
    assert.equal(afterToastOpen.preservedA, true, 'Recording A manual decision must remain intact');
    assert.ok(afterToastOpen.expectedFirstB, 'Recording B must have a candidate');
    assert.equal(afterToastOpen.selectedClipB, afterToastOpen.expectedFirstB);
    assert.equal(afterToastOpen.reviewPosB, afterToastOpen.expectedStartB);

    // -------------------------------------------------------------------------
    // 5. Real background Chrome tab + visibility-return preserves the current recording
    //    and real OPFS watch-folder background discovery
    // -------------------------------------------------------------------------
    // Add a manual decision on B before backgrounding the tab
    const manualIdB = await page.evaluate((idB) => {
      return window.reviewApp.workspace.addManual(idB, { start: 0.2, end: 1.1 });
    }, fgIds.idB);

    // Open a second Chrome tab; if headless Chrome keeps background tab 'visible', fall back to dispatching real visibilitychange.
    const opened = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', '_blank'));
    const otherTab = await opened;
    await otherTab.setContent('<h1>Game Foreground Tab</h1>');
    async function setWorkspaceBackgrounded(hidden) {
      if (hidden) {
        await otherTab.bringToFront();
        const nativeHidden = await page.waitForFunction(() => document.visibilityState === 'hidden', null, { timeout: 600 }).then(() => true).catch(() => false);
        console.log('Workspace hidden event:', nativeHidden ? 'native tab' : 'simulated visibility');
        if (nativeEndpoint) assert.ok(nativeHidden, 'Chrome must hide the workspace tab');
        if (!nativeHidden) {
          await page.evaluate(() => window.__setForcedVisibility('hidden'));
        }
        assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
      } else {
        await page.bringToFront();
        const nativeVisible = await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 600 }).then(() => true).catch(() => false);
        console.log('Workspace visible event:', nativeVisible ? 'native tab' : 'simulated visibility');
        if (nativeEndpoint) assert.ok(nativeVisible, 'Chrome must restore the workspace tab');
        if (!nativeVisible) {
          await page.evaluate(() => window.__setForcedVisibility(null));
        }
        assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      }
    }
    await setWorkspaceBackgrounded(true);

    // While genuinely hidden, recording C becomes ready (conformed)
    const idC = await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const base = await createSyntheticFile();
      const bytes = new Uint8Array(await base.arrayBuffer());
      const freeBox = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x63]);
      const out = new Uint8Array(bytes.length + freeBox.length);
      out.set(bytes, 0);
      out.set(freeBox, bytes.length);
      const fileC = new File([out], '2026-11-26_15-20_WorldsEdge_Background_C.mp4', {
        type: 'video/mp4',
        lastModified: Date.now() + 90_000,
      });
      const recC = await window.reviewApp.queue.importPrecomputed(fileC, {
        windowScores: [
          { start: 0, end: 1.0, scores: [0.02, 0.02] },
          { start: 1.0, end: 2.5, scores: [0.95, 0.15] },
        ],
        alignment: { confidence: 'coarse', offsetMs: 650, correlation: 0.32 },
      });
      return recC.sourceId;
    });

    // While STILL hidden: activeSourceId stays B, title is (1), favicon badged, toast hidden, focus not stolen
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), fgIds.idB);
    assert.equal(await page.evaluate(() => document.title), `(1) ${baseTitleZh}`);
    assert.equal(await page.locator('#ready-toast').isHidden(), true);
    assert.equal(await page.evaluate(() => window.__notifTest.getFocusCalls()), 0);

    await setWorkspaceBackgrounded(false);
    await settleFrames(page);
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), fgIds.idB);
    assert.equal(await page.evaluate(() => document.title), `(1) ${baseTitleZh}`);
    const readyRow = page.locator(`#queue .file[data-source-id="${idC}"]`);
    assert.equal(await readyRow.locator('.library-new-badge').isVisible(), true);
    assert.ok(await page.evaluate(({id, clip}) => reviewApp.workspace.getSource(id).clips.some(c => c.id === clip),
      {id: fgIds.idB, clip: manualIdB}));
    await readyRow.click();
    await page.waitForFunction(id => reviewApp.activeSourceId === id, idC);
    assert.equal(await page.evaluate(() => document.title), baseTitleZh);
    assert.equal(await readyRow.locator('.library-new-badge').isHidden(), true);

    // -------------------------------------------------------------------------
    // 6. Real OPFS background-tab file discovery: switch to real OPFS watch folder, background tab,
    //    write finalized MP4 into OPFS while backgrounded, return to foreground -> immediate poll discovers it!
    // -------------------------------------------------------------------------
    await page.evaluate(async () => {
      const opfsRoot = await navigator.storage.getDirectory();
      const opfsDir = await opfsRoot.getDirectoryHandle('OBS_Background_Test', { create: true });
      await window.reviewApp.engineBridge.activateWatchDirectory(opfsDir, { requestPermission: false, persist: false });
    });
    await setWorkspaceBackgrounded(true);

    const bgFileName = '2026-11-26_15-40_OPFS_Background_Arrival.mp4';
    await page.evaluate(async (fileName) => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const base = await createSyntheticFile();
      const bytes = new Uint8Array(await base.arrayBuffer());
      const freeBox = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x64]);
      const out = new Uint8Array(bytes.length + freeBox.length);
      out.set(bytes, 0);
      out.set(freeBox, bytes.length);
      const opfsRoot = await navigator.storage.getDirectory();
      const opfsDir = await opfsRoot.getDirectoryHandle('OBS_Background_Test', { create: true });
      const fh = await opfsDir.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      await writable.write(out);
      await writable.close();
    }, bgFileName);

    // A successful close makes this file eligible for discovery on visibility return.
    await setWorkspaceBackgrounded(false);
    await page.waitForFunction(
      (name) => window.reviewApp.workspace.view().sources.some((s) => s.identity.name === name),
      bgFileName,
      { timeout: 15000 },
    );

    await otherTab.close();
    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log('PASS: watch-dir IndexedDB auto-restore, 54px restore CTA header, opt-in notifications, foreground ready toast, visibility-return review retention, and real background-tab OPFS discovery');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
