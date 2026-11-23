const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function clickAcrossRefresh(page, button, duringPress) {
  await button.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await button.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await duringPress();
  } finally {
    await page.mouse.up();
  }
}

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

    const firstMark = await page.evaluate(() => window.reviewApp.liveCompanion.session.snapshot().decisions[0].id);
    const undo = page.locator('#live-events-list').getByRole('button', { name: '撤销', exact: true });
    await clickAcrossRefresh(page, undo, async () => {
      // Add another mark from the live session while the first mark's button is held.
      // The list reorders, but a single gesture must still undo only the original.
      await page.evaluate(() => {
        const session = window.reviewApp.liveCompanion.session;
        const now = session.snapshot().latestEpochMs;
        session.addMark({ wallStartMs: now - 500, wallEndMs: now + 500 });
      });
    });
    const remaining = await page.evaluate(() => window.reviewApp.liveCompanion.session.snapshot().decisions);
    assert.equal(remaining.length, 1, 'One click across a live refresh must undo exactly one mark');
    assert.notEqual(remaining[0].id, firstMark, 'The newer mark must survive');

    // Keep two distinguishable marks in the mapped recording, then undo the earlier mark after conform.
    await page.evaluate(() => {
      const session = reviewApp.liveCompanion.session;
      const start = session.snapshot().startEpochMs + 250;
      session.addMark({ wallStartMs: start, wallEndMs: start + 1000 });
    });

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
    assert.equal(liveState.conformed[0].liveDecisions, 2);
    const expected = await page.evaluate(id =>
      reviewApp.liveCompanion.session.snapshot().conformed[0].liveDecisions.find(mark => mark.id === id), remaining[0].id);
    assert.ok(expected);
    await undo.last().click();
    await page.locator('#live-conformed-list .live-card').getByText(/标记 1 条/).waitFor({ timeout: 3000 });
    assert.deepEqual(await page.evaluate(() =>
      reviewApp.liveCompanion.session.snapshot().conformed[0].liveDecisions.map(mark => mark.id)), [expected.id]);

    // Open conformed recording in offline Clip Review.
    const chosen = page.locator('#live-conformed-list .live-card').filter({ hasText: 'demo-apex-clip.mp4' });
    await clickAcrossRefresh(page, chosen.getByRole('button', { name: '去剪辑' }), async () => {
      // Another master arrives while the original button is held. Only the pressed master may open.
      await page.evaluate(() => {
        const session = window.reviewApp.liveCompanion.session;
        const original = session.snapshot().conformed[0];
        const file = new File([original.file], 'second-recording.mp4', { type: original.file.type });
        session.registerConformed({ ...original, id: 'another-master', name: file.name, file });
      });
    });
    await page.waitForFunction(() => window.reviewApp.mode === 'offline' && window.reviewApp.page === 'review', null, { timeout: 10000 });

    const imported = await page.evaluate(() => {
      const app = window.reviewApp;
      const source = app.workspace.getSource(app.activeSourceId);
      return { name: source.identity.name, decisions: source.decisions, windows: app.bindings.get(source.id).windowScores.length };
    });
    assert.equal(imported.name, 'demo-apex-clip.mp4');
    assert.deepEqual(imported.decisions.filter(d => d.kind === 'retain').map(d => d.range), [{ start: expected.start, end: expected.end }]);
    assert.ok(imported.windows > 0);
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => window.reviewApp.player.state.position > 0.2);

    // Return to Live Mode and stop cleanly; empty stage should be restored.
    await page.locator('#mode-live').click();
    await page.locator('#live-btn-stop').click();
    await page.waitForFunction(() => !window.reviewApp.liveCompanion.session.snapshot().active, null, { timeout: 5000 });
    assert.equal(await page.locator('#live-stage-empty').isVisible(), true);

    assert.deepEqual(errors, []);
    console.log('PASS: live mode demo e2e verified', JSON.stringify({ beforeUndo: liveState, retainedInReview: imported.decisions.length }));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
