// Real-file regression: a model/decoder mock cannot reproduce competing Blob I/O.
// Diagnostic only: CHUNK_MIB labels and verifies the served module; it does not edit source.
// Use an isolated checkout for 1/2/4 MiB variants, then run this script sequentially.
// CHUNK_MIB=4 PLAYWRIGHT_MODULE=/path/to/playwright node diagnostics/verify-player-read-quantum.cjs <url> <media> 40 <new-report.json>
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [url = 'http://127.0.0.1:8792', media, seconds = '15', reportPath] = process.argv.slice(2);
if (!media) throw new Error('Provide an existing real recording; this test does not copy it.');
if (!reportPath || fs.existsSync(reportPath)) throw new Error('Provide a new report path; existing reports are preserved.');
if (![1, 2, 4].includes(Number(process.env.CHUNK_MIB))) throw new Error('Set CHUNK_MIB to 1, 2, or 4 to match the isolated server source.');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || process.env.CHROME_PATH || undefined,
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const report = { experimentChunkMiB: Number(process.env.CHUNK_MIB), browser: browser.version(), media, seconds: Number(seconds), samples: [], seeks: [], passed: false };
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/tests/player-harness.html`);
    report.readSource = await page.evaluate(async (expected) => {
      const response = await fetch('/media-read-source.mjs');
      if (!response.ok) throw new Error('Media read scheduler is unavailable');
      const source = await response.text();
      const match = source.match(/const READ_CHUNK_BYTES = (\d+) \* 1024 \* 1024;/);
      if (Number(match?.[1]) !== expected) throw new Error('CHUNK_MIB does not match the actual served read quantum');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return { chunkMiB: expected, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    }, Number(process.env.CHUNK_MIB));
    await page.locator('#source').setInputFiles(media);
    await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { createSourcePlayer } = await import('../source-player.mjs');
      const { createBrowserAnalysis } = await import('../browser-analysis.mjs');
      window.queue = createBrowserAnalysis({ MB });
      window.player = createSourcePlayer({ MB, canvas: document.querySelector('#frame') });
      const file = document.querySelector('#source').files[0];
      await queue.importFiles([file]);
      const source = queue.records[0]; window.setupStarted = performance.now();
      await player.load({ file, origin: source.origin, duration: source.duration, position: 300 });
      await player.play(); window.playerReadyMs = performance.now() - setupStarted;
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
      const sample = await page.evaluate(() => ({ player: player.state, processedUntil: queue.records[0].processedUntil, analysisStatus: queue.records[0].status, timings: queue.records[0].timings, windows: queue.records[0].windows }));
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
    report.measurements = await page.evaluate(() => ({ playerReadyMs, importMs: queue.records[0].importMs, firstReviewableMs: queue.records[0].timings?.firstReviewableMs, timings: queue.records[0].timings, processedUntil: queue.records[0].processedUntil, windows: queue.records[0].windows }));
    report.passed = true;
    console.log(JSON.stringify({ passed: true, samples: report.samples.length, seeks: report.seeks,
      maxLagMs: Math.max(...report.samples.map((s) => (s.player.position - s.player.actual) * 1000)),
      analyzedUntil: report.samples.at(-1).processedUntil, measurements: report.measurements }));
  } catch (error) { report.error = error.message; throw error; }
  finally { if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
