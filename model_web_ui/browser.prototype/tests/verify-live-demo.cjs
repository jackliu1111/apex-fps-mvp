const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.error(`[browser ${msg.type()}]`, msg.text());
      }
    });

    const baseUrl = process.env.REVIEW_URL || 'http://127.0.0.1:18815/';
    const liveUrl = baseUrl.includes('?') ? `${baseUrl}&mode=live` : `${baseUrl}?mode=live`;
    await page.goto(liveUrl);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);

    // Direct ?mode=live opens Live Mode without built-in Demo buttons.
    assert.equal(await page.evaluate(() => window.reviewApp.mode), 'live');
    assert.equal(await page.locator('#live-workspace h1').textContent(), '实时模式(demo)');
    assert.equal(await page.locator('#live-btn-demo').count(), 0);
    assert.equal(await page.locator('#live-stage-demo-btn').count(), 0);

    // Launch local video simulation with sample clip.
    const sampleClip = path.resolve(__dirname, '../../../site/demo-apex-clip.mp4');
    await page.locator('#live-sim-file').setInputFiles(sampleClip);
    try {
      await page.waitForFunction(() => Boolean(window.reviewApp.liveCompanion.session.snapshot().active), null, { timeout: 15000 });
    } catch (err) {
      const notice = await page.locator('#live-notice').textContent().catch(() => '');
      throw new Error(`Simulation did not activate: notice="${notice}" errors=${JSON.stringify(errors)} (${err.message})`);
    }

    assert.equal(await page.locator('#live-sim-title').textContent(), '模拟模式');
    assert.equal(await page.locator('#live-stage-mode-tag').textContent(), 'LIVE · 模拟视频');
    assert.equal(await page.locator('#live-stage-empty').isHidden(), true);

    // Wait for real AudioWorklet envelope + EfficientSED WASM inference score window.
    await page.waitForFunction(() => {
      const snap = window.reviewApp.liveCompanion.session.snapshot();
      return snap.envPeaks.length >= 250 && snap.scoreWindows.length >= 1;
    }, null, { timeout: 25000 });

    // Add a manual mark during live playback.
    await page.locator('#live-btn-mark').click();
    await page.waitForFunction(() => window.reviewApp.liveCompanion.session.snapshot().decisions.length >= 1, null, { timeout: 5000 });

    // Trigger simulated master conform (acoustic NCC alignment on demo-apex-clip.mp4).
    await page.locator('#live-btn-sim-conform').click();
    await page.waitForFunction(() => window.reviewApp.liveCompanion.session.snapshot().conformed.length >= 1, null, { timeout: 15000 });

    const liveState = await page.evaluate(() => {
      const snap = window.reviewApp.liveCompanion.session.snapshot();
      return {
        envCount: snap.envPeaks.length,
        scoreWindows: snap.scoreWindows.length,
        candidates: snap.candidates.length,
        decisions: snap.decisions.length,
        conformed: snap.conformed.map((c) => ({
          name: c.name,
          confidence: c.alignment?.confidence,
          offsetMs: c.alignment?.offsetMs,
          correlation: c.alignment?.correlation,
          liveDecisions: c.liveDecisions.length,
        })),
      };
    });

    assert.equal(liveState.conformed[0].name, 'demo-apex-clip.mp4');
    assert.equal(liveState.conformed[0].confidence, 'exact', `Expected exact NCC alignment, got: ${JSON.stringify(liveState.conformed[0])}`);
    assert.ok(liveState.conformed[0].liveDecisions >= 1, 'Expected manual live mark to migrate into conformed recording');

    // Open conformed recording in offline Clip Review.
    await page.locator('#live-conformed-list button.primary').first().click();
    await page.waitForFunction(() => window.reviewApp.mode === 'offline' && window.reviewApp.page === 'review', null, { timeout: 10000 });

    // Return to Live Mode and stop cleanly; empty stage should be restored.
    await page.locator('#mode-live').click();
    await page.locator('#live-btn-stop').click();
    await page.waitForFunction(() => !window.reviewApp.liveCompanion.session.snapshot().active, null, { timeout: 5000 });
    assert.equal(await page.locator('#live-stage-empty').isVisible(), true);

    assert.deepEqual(errors, []);
    console.log('PASS: live mode demo e2e verified', JSON.stringify(liveState));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
