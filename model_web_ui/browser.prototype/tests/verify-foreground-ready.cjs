// Each invocation owns a fresh page and controls only the analysis result producer.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function run(mode) {
  assert.ok(['paused', 'playing'].includes(mode), 'Specify paused or playing');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route('**/analysis-queue.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `import { createAnalysisQueue as create } from './analysis-queue.mjs?original';
        export function createAnalysisQueue(options) {
          return create({...options, async analyze(record, { publish }) {
            window.resultGate = Promise.withResolvers();
            await resultGate.promise;
            publish([[1,2],[4,5],[8,9]].map(([start,end]) => ({start,end})), {frontier:Infinity});
          }});
        }`,
    }));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const { createSyntheticFile, readSyntheticFrame } = await import('./tests/synthetic-media.mjs');
      const [a, b] = await Promise.all(['A', 'B'].map(sourceLabel => createSyntheticFile({ sourceLabel })));
      const [recB] = await reviewApp.queue.importFiles([b], { autoAnalyze: false });
      reviewApp.workspace.publishCandidates(recB.sourceId, [
        { id:'first', start:4, end:6 }, { id:'second', start:8, end:10 },
      ]);
      await reviewApp.queue.importFiles([a]);
      await reviewApp.openReview(recB.sourceId, {focusFirstCandidate:true});
      const canvas = document.querySelector('#source-canvas');
      const context = canvas.getContext('2d');
      window.trace = { frames: [], loads: [], states: [] };
      window.currentFrame = () => readSyntheticFrame(canvas);
      const draw = context.drawImage.bind(context);
      context.drawImage = (...args) => { draw(...args); trace.frames.push(currentFrame()); };
      const load = reviewApp.player.load.bind(reviewApp.player);
      reviewApp.player.load = params => {
        trace.loads.push(params.file.name);
        return load(params);
      };
      new MutationObserver(() => trace.states.push(document.querySelector('#player-frame').dataset.playing))
        .observe(document.querySelector('#player-frame'), {attributes:true, attributeFilter:['data-playing']});
    });
    await page.waitForFunction(() => window.resultGate);
    await page.locator('#next-candidate').click();
    await page.waitForFunction(() => currentFrame().source === 'B' && Math.abs(currentFrame().frame - 96) <= 1);
    if (mode === 'paused') {
      await page.evaluate(() => reviewApp.player.seek(8.5));
    }
    const start = await page.evaluate(() => {
      trace.frames.length = trace.loads.length = trace.states.length = 0;
      return currentFrame();
    });
    if (mode === 'playing') {
      await page.locator('#play-pause').click();
      await page.waitForFunction(() => trace.frames.length >= 3);
    } else {
      assert.equal(start.source, 'B');
      assert.ok(Math.abs(start.frame - 102) <= 1);
    }
    const boundary = await page.evaluate(() => {
      const index = trace.frames.length;
      resultGate.resolve();
      return index;
    });
    const a = page.locator('#queue .file').filter({hasText:'A.webm'});
    await a.locator('.library-status-badge[data-status="ready"]').waitFor();
    assert.equal(await a.locator('.library-summary-text').textContent(), '3 candidates');
    const b = page.locator('#queue .file[data-selected="true"]');
    assert.match(await b.innerText(), /B\.webm/);
    const selected = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId);
    assert.equal(await selected(), 'auto:second');
    if (mode === 'paused') {
      assert.deepEqual(await page.evaluate(() => currentFrame()), start);
      assert.equal(await page.locator('#player-frame').getAttribute('data-playing'), 'false');
      assert.ok(await page.evaluate(n => trace.frames.every(f => f.source === 'B' && f.frame === n), start.frame));
      await page.locator('#prev-candidate').click();
      await page.waitForFunction(() => currentFrame().source === 'B' && Math.abs(currentFrame().frame - 48) <= 1);
      assert.equal(await selected(), 'auto:first');
    } else {
      await page.waitForFunction(n => trace.frames.length >= n + 3, boundary);
      const {frames, states} = await page.evaluate(() => trace);
      assert.ok(frames.every((f,i) => f.source === 'B' && (!i || frames[i-1].frame < f.frame)));
      assert.ok(!states.slice(states.indexOf('true')).includes('false'), 'B paused before user click');
      await page.locator('#play-pause').click();
      await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
      const frozen = await page.evaluate(() => currentFrame());
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.equal(frozen.source, 'B');
      assert.deepEqual(await page.evaluate(() => currentFrame()), frozen);
    }
    assert.deepEqual(await page.evaluate(() => trace.loads), []);
    console.log('PASS', mode, JSON.stringify(await page.evaluate(() => ({frames:trace.frames, end:currentFrame(), loads:trace.loads}))));
  } catch (error) {
    console.error(await page.evaluate(() => ({trace:window.trace, selected:document.querySelector('#queue .is-selected')?.innerText})).catch(() => null));
    throw error;
  } finally {
    await browser.close();
  }
}
run(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
