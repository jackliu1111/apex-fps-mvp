// Verifies Ticket #61 (ADR 0009 + ADR 0010): Single-workspace end-to-end engine wiring.
// Checks:
//  1. Global topbar session controls (#global-session-controls) visible on BOTH Clip & Exports views
//     with strict 54px single-row height & zero wrap/overflow across 1440..851px in EN and ZH,
//     plus clean wrapping down to 320px and floating popover not expanding header height.
//  2. Empty-state 2-step onboarding Step 1 (Watch Folder) & Step 2 (Live Monitoring) driving real
//     engineBridge services (read-only folder picker, pure-audio video-track shutdown, device switch,
//     device-only loopback gate bypass, playback gate pause/resume, and #62 restore hook slot).
//  3. Path B: Uncovered recording finalizes in watch folder -> auto-ingests as unanalyzed without
//     background scan -> transitions empty -> split -> right-header Start Analysis -> analyzes/completes.
//  4. Path A: Live-covered recording finalizes in watch folder while reviewing another recording ->
//     conforms & appears at top of sidebar with New badge WITHOUT switching active review or losing
//     manual decisions -> clicking row opens it and clears New badge -> zero vertical/horizontal scroll.
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
        range.selectNodeContents(item);
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
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: process.env.REVIEW_IGNORE_HTTPS_ERRORS === '1',
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Install deterministic browser boundary mocks BEFORE page script loads:
    // - showDirectoryPicker (read-only watch folder backed by in-memory map)
    // - navigator.mediaDevices.getDisplayMedia / getUserMedia / enumerateDevices (WebAudio oscillator + fake video track)
    await page.addInitScript(() => {
      const watchFiles = new Map();
      const pickerCalls = [];
      let stoppedVideoTracks = 0;

      window.__testWatchFiles = watchFiles;
      window.__testPickerCalls = pickerCalls;
      window.__getStoppedVideoTracks = () => stoppedVideoTracks;

      const watchDirHandle = {
        name: 'OBS Captures',
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
        async *entries() {
          for (const [name, file] of watchFiles.entries()) {
            yield [name, { kind: 'file', async getFile() { return file; } }];
          }
        },
      };
      window.__testWatchDirHandle = watchDirHandle;

      window.showDirectoryPicker = async (opts) => {
        pickerCalls.push(opts || {});
        return watchDirHandle;
      };

      function createAudioStreamWithOptionalVideo(includeVideo) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.25;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        const stream = dest.stream;
        if (includeVideo) {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const vStream = canvas.captureStream(5);
          const vTrack = vStream.getVideoTracks()[0];
          const origStop = vTrack.stop.bind(vTrack);
          vTrack.stop = () => {
            stoppedVideoTracks += 1;
            return origStop();
          };
          stream.addTrack(vTrack);
        }
        return stream;
      }

      const fakeDevices = [
        { kind: 'audioinput', deviceId: 'vb-cable-1', label: 'VB-Cable Virtual Output', groupId: 'g1' },
        { kind: 'audioinput', deviceId: 'headset-1', label: 'USB Headset Mic', groupId: 'g2' },
      ];

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          async getDisplayMedia() {
            return createAudioStreamWithOptionalVideo(true);
          },
          async getUserMedia() {
            return createAudioStreamWithOptionalVideo(false);
          },
          async enumerateDevices() {
            return fakeDevices;
          },
        },
      });
    });

    const url = process.env.REVIEW_URL || 'http://127.0.0.1:8792/';
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);

    // -------------------------------------------------------------------------
    // 1. Global topbar header invariant (EN & ZH) across all desktop & narrow widths
    // -------------------------------------------------------------------------
    const widths = [1440, 1280, 1201, 1200, 1024, 900, 851, 768, 540, 390, 320];
    await assertHeaderInvariant(page, widths, 'topbar-en');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#lang-toggle').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await assertHeaderInvariant(page, widths, 'topbar-zh');

    // Verify floating popover opens without changing 54px header height and supports source/device/bypass switching
    await page.setViewportSize({ width: 1280, height: 800 });
    await settleFrames(page);
    await page.locator('#topbar-live-settings-btn').click();
    assert.equal(await page.locator('#topbar-live-popover').isVisible(), true);
    assert.equal(
      await page.evaluate(() => document.querySelector('.header-inner').getBoundingClientRect().height),
      54,
      'Opening live monitor popover must NOT expand header height beyond 54px',
    );
    assert.equal(await page.locator('#topbar-device-group').isHidden(), true);

    await page.locator('#topbar-source-device').click();
    await page.waitForFunction(() => !document.getElementById('topbar-device-group').hidden);
    assert.equal(await page.locator('#topbar-device-select option').count(), 2);
    assert.equal(await page.locator('#topbar-gate-bypass').isDisabled(), false);

    // Switch back to system audio -> device group hides and bypass disables
    await page.locator('#topbar-source-system').click();
    await page.waitForFunction(() => document.getElementById('topbar-device-group').hidden);
    assert.equal(await page.locator('#topbar-gate-bypass').isDisabled(), true);

    // Escape closes popover
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#topbar-live-popover').isHidden(), true);

    // -------------------------------------------------------------------------
    // 2. Empty-state 2-step onboarding wired to real services + visible on Exports page
    // -------------------------------------------------------------------------
    assert.equal(await page.locator('#clipping-workspace').getAttribute('data-layout'), 'empty');
    assert.equal(await page.locator('#empty-onboarding').isVisible(), true);

    // Step 1: Choose read-only watch folder via onboarding button
    await page.locator('#onboarding-choose-watch-dir').click();
    await page.waitForFunction(() => window.reviewApp.watchDirState.status === 'watching');
    assert.equal(await page.evaluate(() => window.__testPickerCalls[0]?.mode), 'read');
    assert.equal(await page.locator('#topbar-watch-value').textContent(), 'OBS Captures');
    assert.match(await page.locator('#onboarding-watch-status').textContent(), /OBS Captures/);

    // Step 2: Start pure-audio live monitoring via onboarding button
    await page.locator('#onboarding-toggle-monitoring').click();
    await page.waitForFunction(() => window.reviewApp.liveMonitor.getState().status === 'listening');
    assert.equal(await page.locator('#topbar-live-monitor').getAttribute('data-live-status'), 'listening');
    assert.equal(await page.locator('#topbar-live-status').textContent(), '监听中');
    assert.equal(await page.locator('#onboarding-toggle-monitoring').getAttribute('aria-pressed'), 'true');
    assert.ok(
      await page.evaluate(() => window.__getStoppedVideoTracks() >= 1),
      'Pure-audio system capture must immediately stop video tracks',
    );

    // Global topbar controls stay visible & live on Exports page too!
    await page.locator('#nav-exports').click();
    assert.equal(await page.locator('#exports-section').isVisible(), true);
    assert.equal(await page.locator('#global-session-controls').isVisible(), true);
    assert.equal(await page.locator('#topbar-live-status').textContent(), '监听中');
    assert.equal(await page.locator('#topbar-watch-value').textContent(), 'OBS Captures');
    await page.locator('#nav-analysis').click();

    // Verify playback loopback gate auto-pauses & resumes live monitor in topbar
    await page.evaluate(() => window.reviewApp.engineBridge.notifyPlayerState({ playing: true, muted: false, volume: 0.6 }));
    assert.equal(await page.locator('#topbar-live-monitor').getAttribute('data-live-status'), 'paused-loopback');
    assert.equal(await page.locator('#topbar-live-status').textContent(), '回放暂停');
    await page.evaluate(() => window.reviewApp.engineBridge.notifyPlayerState({ playing: false, muted: false, volume: 0.6 }));
    assert.equal(await page.locator('#topbar-live-monitor').getAttribute('data-live-status'), 'listening');

    // -------------------------------------------------------------------------
    // 3. Path B: Uncovered recording finalizes in watch folder -> unanalyzed -> manual Start Analysis
    // -------------------------------------------------------------------------
    await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const base = await createSyntheticFile();
      const buf = await base.arrayBuffer();
      // Timestamp far outside live history -> uncovered -> enters as unanalyzed without offline scan
      const file = new File([buf], '2026-11-26_12-00_Uncovered_Warmup.mp4', {
        type: 'video/mp4',
        lastModified: Date.now() - 4 * 3600 * 1000,
      });
      window.__testWatchFiles.set(file.name, file);
      await window.reviewApp.engineBridge.pollWatchDirectory();
      await window.reviewApp.engineBridge.pollWatchDirectory();
      await window.reviewApp.engineBridge.pollWatchDirectory();
    });

    await page.waitForFunction(
      () => document.querySelector('#clipping-workspace')?.dataset.layout === 'split'
        && Boolean(window.reviewApp.activeSourceId)
        && !window.reviewApp.activeSourceId.startsWith('runtime:'),
      null,
      { timeout: 30000 },
    );

    // Verify uncovered recording entered as 未分析 (unanalyzed) with right-header 开始分析 CTA
    const firstSourceId = await page.evaluate(() => window.reviewApp.activeSourceId);
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${firstSourceId}"] .library-status-badge`).textContent(),
      '未分析',
    );
    assert.equal(await page.locator('#review-primary-action').isVisible(), true);
    assert.equal(await page.locator('#review-primary-action').textContent(), '开始分析');

    // Ensure split sidebar does NOT duplicate watch/monitor controls
    assert.equal(await page.locator('#library-topbar-slots').isVisible(), false);

    // Add a manual review decision on firstSourceId before a 2nd recording arrives
    await page.evaluate((id) => {
      window.reviewApp.workspace.addManual(id, { start: 0.5, end: 2.0 });
    }, firstSourceId);

    // Trigger manual offline analysis via right-header primary action ("开始分析")
    await page.locator('#review-primary-action').click();
    await page.waitForFunction(
      (id) => {
        const rec = window.reviewApp.bindings.get(id);
        return rec && (rec.status === 'analyzing' || rec.status === 'complete');
      },
      firstSourceId,
      { timeout: 30000 },
    );

    // -------------------------------------------------------------------------
    // 4. Path A: Second recording auto-ingests while first is open -> New badge & NO review switch
    // -------------------------------------------------------------------------
    await page.evaluate(async () => {
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const base = await createSyntheticFile();
      const bytes = new Uint8Array(await base.arrayBuffer());
      // Add a benign trailing free box so identity fingerprint differs cleanly from the 1st recording
      const freeBox = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
      const combined = new Uint8Array(bytes.length + freeBox.length);
      combined.set(bytes, 0);
      combined.set(freeBox, bytes.length);
      const file2 = new File([combined], '2026-11-26_15-30_Olympus_Match.mp4', {
        type: 'video/mp4',
        lastModified: Date.now() + 2000,
      });
      window.__testWatchFiles.set(file2.name, file2);
      await window.reviewApp.engineBridge.pollWatchDirectory();
      await window.reviewApp.engineBridge.pollWatchDirectory();
      await window.reviewApp.engineBridge.pollWatchDirectory();
    });

    await page.waitForFunction(() => document.querySelectorAll('#queue .file.library-row').length === 2, null, { timeout: 30000 });

    // Active review MUST remain on firstSourceId, and the newly arrived top row MUST display 新 badge
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), firstSourceId);
    const topRowInfo = await page.evaluate(() => {
      const top = document.querySelector('#queue .file.library-row');
      return {
        id: top.dataset.sourceId,
        isNew: top.dataset.new === 'true',
        badgeText: top.querySelector('.library-new-badge')?.textContent,
        badgeHidden: top.querySelector('.library-new-badge')?.hidden,
      };
    });
    assert.notEqual(topRowInfo.id, firstSourceId);
    assert.equal(topRowInfo.isNew, true);
    assert.equal(topRowInfo.badgeHidden, false);
    assert.equal(topRowInfo.badgeText, '新');

    // Manual review decision on firstSourceId must remain intact
    assert.equal(
      await page.evaluate((id) => window.reviewApp.workspace.getSource(id).decisions.length >= 1, firstSourceId),
      true,
    );

    // Click newly arrived row -> opens it and clears 新 badge
    await page.locator(`#queue .file[data-source-id="${topRowInfo.id}"]`).click();
    assert.equal(await page.evaluate(() => window.reviewApp.activeSourceId), topRowInfo.id);
    assert.equal(
      await page.locator(`#queue .file[data-source-id="${topRowInfo.id}"] .library-new-badge`).isHidden(),
      true,
    );

    // Zero vertical & horizontal scroll in split workspace at 1440x900 & 1280x800
    await assertDesktopZeroScroll(page, 1440, 900, 'e2e-split-1440-zh');
    await assertDesktopZeroScroll(page, 1280, 800, 'e2e-split-1280-zh');

    // Stop live monitor via topbar pill
    await page.locator('#topbar-live-toggle').click();
    await page.waitForFunction(() => window.reviewApp.liveMonitor.getState().status === 'idle');
    assert.equal(await page.locator('#topbar-live-monitor').getAttribute('data-live-status'), 'off');

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log('PASS: single-workspace end-to-end topbar, onboarding, pure-audio monitor, and auto-intake paths');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
