const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const open = source => page.locator(`#queue [data-source-id="${source}"]`).click();
  const marker = clip => page.locator(`#overview-markers [data-clip-id="auto:${clip}"]`);
  const choices = source => page.evaluate(id => reviewApp.workspace.getSource(id).clips.map(
    ({ id, start, end, selected, excluded }) => ({ id, start, end, selected, excluded })), source);
  async function expectClip(source, clip, frame) {
    await page.waitForFunction(({ source, clip, frame }) => {
      const app = window.reviewApp;
      const canvas = document.querySelector('#source-canvas');
      const decoded = window.readFrame(canvas);
      return app.activeSourceId === source && app.workspace.getSource(source).review.selectedClipId === 'auto:' + clip &&
        app.player.state.status === 'paused' && decoded.source === source && Math.abs(decoded.frame - frame) <= 1;
    }, { source, clip, frame });
  }
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      const app = window.reviewApp;
      await app.ready;
      const { createSyntheticFile, readSyntheticFrame } = await import('/tests/synthetic-media.mjs');
      window.readFrame = readSyntheticFrame;
      for (const source of ['B', 'A']) {
        const file = await createSyntheticFile({ sourceLabel: source });
        app.bindings.set(source, { file, duration: 12, origin: 0, status: 'complete' });
        app.workspace.addSource({ id: source, name: file.name, size: file.size, duration: 12 });
        const clips = source === 'A' ? [['first', 1, 2], ['middle', 4, 6], ['last', 8, 10]]
          : [['first', 1, 2], ['other', 6, 7]];
        app.workspace.publishCandidates(source, clips.map(([id, start, end]) => ({ id, start, end })));
        app.workspace.updateAnalysis(source, { status: 'completed', processedUntil: 12 });
      }
      await app.openReview('B');
    });
    await marker('first').click();
    await expectClip('B', 'first', 12);
    await page.locator('#toggle-current-clip').click();
    const untouched = await choices('B');
    assert.deepEqual(untouched.map(c => c.selected), [false, true]);

    await open('A');
    await marker('middle').click();
    await expectClip('A', 'middle', 48);
    const original = (await choices('A')).find(c => c.id === 'auto:middle');
    await page.locator('#exclude-selection').click();
    assert.equal(await marker('middle').count(), 0);
    if (await page.locator('#source-fit').isEnabled()) await page.locator('#source-fit').click();
    await marker('first').click();
    await expectClip('A', 'first', 12);
    await page.locator('#next-candidate').click();
    await expectClip('A', 'last', 96);
    assert.deepEqual(await choices('B'), untouched);

    await page.locator('#undo-selection').click();
    assert.deepEqual((await choices('A')).find(c => c.id === 'auto:middle'), original);
    if (await page.locator('#source-fit').isEnabled()) await page.locator('#source-fit').click();
    await marker('first').click();
    await expectClip('A', 'first', 12);
    await page.locator('#next-candidate').click();
    await expectClip('A', 'middle', 48);
    await open('B');
    await expectClip('B', 'first', 12);
    assert.deepEqual(await choices('B'), untouched);
    assert.match(await marker('first').getAttribute('class'), /unselected/);
    console.log('PASS R2', browser.version(), 'excluded → A:96; undo → A:48; B:12 retains decisions', untouched);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
