// Each invocation owns a fresh page and controls only the analysis result producer.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function run(mode) {
  assert.ok(['paused', 'playing', 'background'].includes(mode), 'Specify paused, playing or background');
  const background = mode === 'background';
  const browser = background && process.env.REVIEW_NATIVE_CDP_URL
    ? await chromium.connectOverCDP(process.env.REVIEW_NATIVE_CDP_URL, { noDefaults: true })
    : await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: !background });
  const page = process.env.REVIEW_NATIVE_CDP_URL && background ? await browser.contexts()[0].newPage() : await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.addInitScript(() => {
      window.trace = { events: [], frames: [], loads: [], states: [] };
      window.mark = (event, detail) => trace.events.push({
        event, detail, selected: document.querySelector('#queue .file[data-selected="true"]')?.title,
        frame: window.currentFrame?.(),
      });
      document.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (button) mark('click', { id: button.id, playing: button.dataset.playing });
      }, true);
    });
    await page.route('**/analysis-queue.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `import { createAnalysisQueue as create } from './analysis-queue.mjs?original';
        export function createAnalysisQueue(options) {
          return create({...options, async analyze(record, { publish }) {
            window.resultGate = Promise.withResolvers();
            mark('result held', record.file.name);
            await resultGate.promise;
            mark('result delivered', record.file.name);
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
      window.currentFrame = () => readSyntheticFrame(canvas);
      const draw = context.drawImage.bind(context);
      context.drawImage = (...args) => { draw(...args); trace.frames.push(currentFrame()); mark('draw'); };
      const load = reviewApp.player.load.bind(reviewApp.player);
      reviewApp.player.load = params => {
        trace.loads.push(params.file.name); mark('load', params.file.name);
        return load(params);
      };
      const frame = document.querySelector('#player-frame');
      new MutationObserver(records => {
        // A true -> false -> true update may occur within one microtask.
        for (const record of records) trace.states.push(record.oldValue);
        trace.states.push(frame.dataset.playing);
      }).observe(frame, { attributes: true, attributeOldValue: true, attributeFilter: ['data-playing'] });
    });
    await page.waitForFunction(() => window.resultGate);
    await page.locator('#next-candidate').click();
    await page.waitForFunction(() => currentFrame().source === 'B' && Math.abs(currentFrame().frame - 96) <= 1);
    if (mode !== 'playing') {
      if (background) await page.locator('#toggle-current-clip').click();
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
    let decisions;
    const currentSource = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    if (background) {
      const source = await currentSource();
      assert.equal(source.clips.find(c => c.id === 'auto:second').selected, false);
      decisions = source.decisions;
      const other = await page.context().newPage();
      await other.bringToFront();
      await page.waitForFunction(() => document.hidden, null, { polling: 50, timeout: 3000 });
    }
    const boundary = await page.evaluate(() => {
      const index = trace.frames.length;
      mark('release result');
      resultGate.resolve();
      return index;
    });
    const a = page.locator('#queue .file').filter({hasText:'A.webm'});
    await a.locator('.library-status-badge[data-status="ready"]').waitFor();
    await page.evaluate(() => mark('A ready'));
    assert.equal(await a.locator('.library-summary-text').textContent(), '3 candidates');
    if (background) {
      await page.bringToFront();
      await page.waitForFunction(() => !document.hidden);
    }
    const b = page.locator('#queue .file[data-selected="true"]');
    assert.match(await b.innerText(), /B\.webm/);
    const selected = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId);
    assert.equal(await selected(), 'auto:second');
    if (mode !== 'playing') {
      if (background) {
        const source = await currentSource();
        assert.deepEqual(source.decisions, decisions);
        assert.equal(source.clips.find(c => c.id === 'auto:second').selected, false);
      }
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
      assert.ok(states.includes('true'), 'playing state was observed');
      assert.ok(states.slice(states.indexOf('true')).every(state => state === 'true'), 'B paused before user click');
      assert.equal(await page.locator('#player-frame').getAttribute('data-playing'), 'true');
      await page.locator('#play-pause').click();
      await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
      const frozen = await page.evaluate(async () => {
        const frame = currentFrame();
        const start = performance.now();
        const firstDraw = trace.frames.length;
        // Keep observing through three source-frame deadlines after the pause event.
        await new Promise(done => {
          function sample(now) {
            if (now - start >= 3 * 1000 / 12) done();
            else requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
        return { frame, end: currentFrame(), draws: trace.frames.slice(firstDraw), playing: reviewApp.player.state.playing };
      });
      assert.equal(frozen.frame.source, 'B');
      assert.equal(frozen.playing, false);
      assert.deepEqual(frozen.end, frozen.frame);
      for (const draw of frozen.draws) assert.deepEqual(draw, frozen.frame);
    }
    assert.deepEqual(await page.evaluate(() => trace.loads), []);
    if (background) {
      await a.click();
      await page.waitForFunction(() => currentFrame().source === 'A');
      assert.match(await b.innerText(), /A\.webm/);
    }
    console.log('PASS', browser.version(), mode, JSON.stringify(await page.evaluate(() => trace.events)));
  } catch (error) {
    console.error(await page.evaluate(() => ({trace:window.trace, selected:document.querySelector('#queue .file[data-selected="true"]')?.title})).catch(() => null));
    throw error;
  } finally {
    await browser.close();
  }
}
run(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
