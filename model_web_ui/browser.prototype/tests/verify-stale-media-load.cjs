// B3: delay A's successful decoder capability result until B's real first frame.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const row = source => page.locator(`#queue .library-row[data-source-id="${source}"]`);
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      const app = window.reviewApp;
      await app.ready;
      const media = await import('/tests/synthetic-media.mjs');
      for (const source of ['B', 'A']) {
        const file = await media.createSyntheticFile({ sourceLabel: source });
        app.bindings.set(source, { file, origin: 0, duration: 12, status: 'complete' });
        app.workspace.addSource({ id: source, name: file.name, size: file.size, duration: 12 });
        app.workspace.publishCandidates(source, source === 'B'
          ? [{ id: 'first', start: 4, end: 6 }, { id: 'second', start: 8, end: 10 }]
          : [{ id: 'first', start: 1, end: 3 }]);
        app.workspace.updateAnalysis(source, { status: 'completed', processedUntil: 12 });
      }
      await app.openReview('B');
      const canvas = document.querySelector('#source-canvas');
      const events = window.staleEvents = [];
      const display = canvas.getContext('2d');
      const draw = display.drawImage.bind(display);
      display.drawImage = (...args) => {
        draw(...args);
        events.push({ event: 'draw', ...media.readSyntheticFrame(canvas),
          selected: document.querySelector('#queue .library-row[data-selected="true"]')?.dataset.sourceId });
      };
      const load = app.player.load;
      app.player.load = async params => {
        const source = params.file === app.bindings.get('A').file ? 'A' : 'B';
        events.push({ event: 'request', source });
        const result = await load(params);
        events.push({ event: 'complete', source });
        return result;
      };
      const { InputAudioTrack } = await import('/assets/vendor/mediabunny.mjs');
      // The first audio decoder probe belongs to the next requested recording (A).
      const canDecode = InputAudioTrack.prototype.canDecode;
      InputAudioTrack.prototype.canDecode = async function (...args) {
        InputAudioTrack.prototype.canDecode = canDecode;
        const supported = await canDecode.apply(this, args);
        if (!supported) throw new Error('Fixture audio cannot be decoded');
        events.push({ event: 'held', source: 'A' });
        await new Promise(resolve => { window.releaseStaleResult = resolve; });
        events.push({ event: 'released', source: 'A' });
        return supported;
      };
    });
    await row('A').click();
    await page.waitForFunction(() => window.releaseStaleResult);
    await row('B').click();
    await page.waitForFunction(() => window.staleEvents.some(e => e.event === 'complete' && e.source === 'B'));
    assert.equal(await row('B').getAttribute('data-selected'), 'true');
    await page.evaluate(() => {
      if (!window.staleEvents.some(e => e.event === 'draw' && e.source === 'B')) throw new Error('Missing B first frame');
      const list = document.querySelector('#queue');
      const checkSelection = changes => {
        for (const change of changes) {
          // oldValue also catches a brief deselection reverted in the same microtask.
          if (change.target.dataset.sourceId === 'B' &&
              (change.oldValue === 'false' || change.target.dataset.selected !== 'true')) {
            window.staleEvents.push({ event: 'lost selection', source: 'B' });
          }
        }
      };
      new MutationObserver(checkSelection).observe(list, {
        subtree: true, attributes: true, attributeFilter: ['data-selected'], attributeOldValue: true,
      });
      window.releaseStaleResult();
    });
    await page.waitForFunction(() => window.staleEvents.some(e => e.event === 'complete' && e.source === 'A'));
    assert.equal(await row('B').getAttribute('data-selected'), 'true');
    await page.locator('#overview-markers [data-clip-id="auto:second"]').click();
    await page.waitForFunction(() => window.staleEvents.some(e => e.event === 'draw' && e.source === 'B' && Math.abs(e.frame - 96) <= 1));
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => window.staleEvents.some(e => e.event === 'draw' && e.source === 'B' && e.frame >= 98));
    await page.locator('#play-pause').click();
    const events = await page.evaluate(() => window.staleEvents);
    assert.deepEqual(events.filter(e => e.event !== 'draw').map(e => [e.event, e.source]), [
      ['request', 'A'], ['held', 'A'], ['request', 'B'], ['complete', 'B'], ['released', 'A'], ['complete', 'A'],
    ]);
    const draws = events.filter(e => e.event === 'draw');
    assert.ok(draws.every(e => e.source === 'B' && e.selected === 'B'), JSON.stringify(draws));
    assert.equal(await row('B').getAttribute('data-selected'), 'true');
    assert.equal(await page.evaluate(() => reviewApp.workspace.getSource('B').review.selectedClipId), 'auto:second');
    console.log('PASS B3', browser.version(), JSON.stringify(events));
  } catch (error) {
    console.error('B3 trace', await page.evaluate(() => window.staleEvents).catch(() => []));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
