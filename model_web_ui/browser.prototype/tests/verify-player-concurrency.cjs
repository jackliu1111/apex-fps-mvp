// Real-file regression: a model/decoder mock cannot reproduce competing Blob I/O.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/verify-player-concurrency.cjs <url> <media> [seconds] [report.json]
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [url = 'http://127.0.0.1:8792', media, seconds = '15', reportPath] = process.argv.slice(2);
if (!media) throw new Error('Provide an existing real recording; this test does not copy it.');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const report = { browser: browser.version(), media, seconds: Number(seconds), samples: [], seeks: [], passed: false };
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/tests/player-harness.html`);
    await page.locator('#source').setInputFiles(media);
    await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { createSourcePlayer } = await import('../source-player.mjs');
      const { createBrowserAnalysis } = await import('../browser-analysis.mjs');
      window.queue = createBrowserAnalysis({ MB });
      window.player = createSourcePlayer({ MB, canvas: document.querySelector('#frame') });
      const file = document.querySelector('#source').files[0];
      await queue.importFiles([file]);
      const source = queue.records[0];
      await player.load({ file, origin: source.origin, duration: source.duration, position: 300 });
      await player.play();
    });
    let previous, stationarySince;
    const started = Date.now();
    for (let index = 0; index < Number(seconds) * 4; index++) {
      if (Number(seconds) >= 40 && (index === 48 || index === 100)) {
        const target = index === 48 ? 2100 : 900, before = Date.now();
        await page.evaluate((time) => player.seek(time), target);
        report.seeks.push({ target, elapsedMs: Date.now() - before }); previous = undefined; stationarySince = undefined;
      }
      await page.waitForTimeout(250);
      const sample = await page.evaluate(() => ({ player: player.state, processedUntil: queue.records[0].processedUntil, analysisStatus: queue.records[0].status }));
      sample.elapsedMs = Date.now() - started; report.samples.push(sample);
      const state = sample.player;
      assert.equal(state.status, 'playing', state.error || 'Player stopped unexpectedly');
      assert.ok(state.position - state.actual < 0.5, `frame lag ${(state.position - state.actual).toFixed(3)}s at ${state.position.toFixed(3)}s`);
      if (previous === state.metrics.framesDisplayed) stationarySince ??= Date.now();
      else stationarySince = undefined;
      assert.ok(!stationarySince || Date.now() - stationarySince < 500, 'Displayed frames stopped advancing');
      previous = state.metrics.framesDisplayed;
    }
    assert.ok(report.samples.at(-1).processedUntil > 0, 'Analysis did not advance during review');
    report.passed = true;
    console.log(JSON.stringify({ passed: true, samples: report.samples.length, seeks: report.seeks,
      maxLagMs: Math.max(...report.samples.map((s) => (s.player.position - s.player.actual) * 1000)),
      analyzedUntil: report.samples.at(-1).processedUntil }));
  } catch (error) { report.error = error.message; throw error; }
  finally { if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
