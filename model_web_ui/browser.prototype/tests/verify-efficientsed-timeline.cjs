// Headless browser E2E regression for EfficientSED parity, custom Worker registry,
// layered 5-group waveform, pyramid 40ms zoom/pan, toggles, hover, trim/exclude/OPFS export,
// responsive zero-scroll budgets, and session reset on reload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function resolvePath(envValue, candidates, label) {
  if (envValue) {
    const resolved = path.resolve(envValue);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configured ${label} does not exist: ${resolved}`);
    }
    return resolved;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function tryResolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    return require(process.env.PLAYWRIGHT_MODULE);
  }
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

async function createBrowserDriver({ rootDir, assetsDir, samplePath }) {
  const pw = tryResolvePlaywright();
  if (pw) {
    const baseUrl = process.env.REVIEW_URL || 'http://127.0.0.1:8792/';
    const browser = await pw.chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE,
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (dialog) => dialog.accept());
    return {
      mode: 'playwright',
      baseUrl,
      goto: (url) => page.goto(url),
      setViewport: (width, height) => page.setViewportSize({ width, height }),
      evaluate: (fn, ...args) => page.evaluate(fn, ...args),
      waitFor: (fn, timeoutMs = 120000) => page.waitForFunction(fn, null, { timeout: timeoutMs }),
      clickSelector: (sel) => page.locator(sel).first().click(),
      mouseMove: (x, y) => page.mouse.move(x, y),
      mouseDown: (x, y) => page.mouse.move(x, y).then(() => page.mouse.down()),
      mouseUp: () => page.mouse.up(),
      wheel: (x, y, deltaX, deltaY) => page.mouse.move(x, y).then(() => page.mouse.wheel(deltaX, deltaY)),
      keyPress: (key) => page.keyboard.press(key),
      uploadSample: async (filePath) => page.locator('#files').setInputFiles(filePath),
      getErrors: () => errors,
      close: () => browser.close(),
    };
  }

  const cdpPath = resolvePath(process.env.CDP_HARNESS, ['/tmp/cdp-harness.mjs'], 'CDP_HARNESS');
  if (!cdpPath) {
    throw new Error('Neither Playwright (PLAYWRIGHT_MODULE) nor CDP harness (/tmp/cdp-harness.mjs / CDP_HARNESS) is available.');
  }
  if (!assetsDir) {
    throw new Error('CDP harness requires ASSETS_DIR (e.g. /tmp/apex-spec-38-assets).');
  }
  const { launchBrowser } = await import(pathToFileURL(cdpPath).href);
  const cdp = await launchBrowser({
    rootDir,
    assetsDir,
    samplePath: samplePath || '__synthetic__',
  });
  return {
    mode: 'cdp',
    baseUrl: 'http://127.0.0.1:18820/',
    goto: (url) => cdp.goto(url),
    setViewport: (width, height) => cdp.setViewport(width, height),
    evaluate: (fn, ...args) => cdp.evalJs(fn, ...args),
    waitFor: (fn, timeoutMs = 120000) => cdp.waitFor(fn, timeoutMs),
    clickSelector: (sel) => cdp.clickSelector(sel),
    mouseMove: (x, y) => cdp.mouseMove(x, y),
    mouseDown: (x, y) => cdp.mouseDown(x, y),
    mouseUp: (x, y) => cdp.mouseUp(x, y),
    wheel: (x, y, deltaX, deltaY) => cdp.wheel(x, y, deltaX, deltaY),
    keyPress: (key, opts) => cdp.keyPress(key, opts),
    uploadSample: null,
    getErrors: () => cdp.pageErrors,
    close: () => cdp.close(),
  };
}

(async () => {
  const timeoutGuard = setTimeout(() => {
    console.error('verify-efficientsed-timeline.cjs timed out after 120000ms');
    process.exit(1);
  }, 120000);

  const rootDir = path.resolve(__dirname, '../../../site');
  const assetsDir = resolvePath(process.env.ASSETS_DIR, [path.join(rootDir, 'assets'), '/tmp/apex-spec-38-assets', '/private/tmp/apex-browser-prototype-20261026/assets'], 'ASSETS_DIR');
  const useSynthetic = process.env.SYNTHETIC === '1';
  const samplePath = useSynthetic
    ? null
    : resolvePath(process.env.SAMPLE_PATH || process.env.MEDIA_PATH, ['/tmp/apex-browser-prototype-20261026/sample-combat.mp4'], 'SAMPLE_PATH');

  let driver;
  try {
    driver = await createBrowserDriver({ rootDir, assetsDir, samplePath });
    await driver.setViewport(1440, 900);
    await driver.goto(driver.baseUrl);
    await driver.waitFor(() => !!window.reviewApp, 15000);
    await driver.evaluate(() => window.reviewApp.ready);

    // 1. Reference-waveform PyTorch probability parity (< 1e-4) in real inference-worker.js
    const parity = await driver.evaluate(async () => {
      const manifestResp = await fetch('/assets/efficientsed/model.json');
      if (!manifestResp.ok) return { skipped: true, reason: `model.json HTTP ${manifestResp.status}` };
      const manifest = await manifestResp.json();
      const wavResp = await fetch('/assets/efficientsed/reference-waveform.f32');
      const probResp = await fetch('/assets/efficientsed/reference-probabilities.f32');
      if (!wavResp.ok || !probResp.ok) {
        return { skipped: true, reason: `reference assets HTTP ${wavResp.status}/${probResp.status}` };
      }
      const waveform = new Float32Array(await wavResp.arrayBuffer());
      const expected = new Float32Array(await probResp.arrayBuffer());
      const worker = new Worker('./inference-worker.js', { type: 'module' });
      try {
        const result = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.type === 'result') resolve(data);
            else if (data.type === 'error') reject(new Error(data.message));
          };
          worker.onerror = (err) => reject(new Error(err.message || 'Worker error'));
          worker.postMessage({
            id: 1,
            waveform,
            model: 'efficientsed',
            manifest: { sha256: manifest.sha256, bytes: manifest.bytes, modelFile: manifest.modelFile },
          }, [waveform.buffer]);
        });
        let maxError = 0;
        for (let i = 0; i < expected.length; i++) {
          const diff = Math.abs(result.values[i] - expected[i]);
          if (diff > maxError) maxError = diff;
        }
        return { skipped: false, dims: result.dims, length: result.values.length, expectedLength: expected.length, maxError };
      } finally {
        worker.terminate();
      }
    });
    if (process.env.REQUIRE_PARITY === '1' || process.env.ASSETS_DIR) {
      assert.equal(parity.skipped, false, `Expected reference parity assets to be served: ${parity.reason || ''}`);
    }
    if (!parity.skipped) {
      assert.deepEqual(parity.dims, [1, 250, 447]);
      assert.equal(parity.length, parity.expectedLength);
      assert.ok(parity.maxError < 1e-4, `Expected PyTorch probability parity maxError < 1e-4, got ${parity.maxError}`);
    }

    // 2. Custom registered model end-to-end across the real Worker boundary (spec serialization)
    const customWorkerResult = await driver.evaluate(async () => {
      const { createBrowserAnalysis } = await import('./browser-analysis.mjs');
      const { createModelRegistry } = await import('./model-registry.mjs');
      const registry = createModelRegistry();
      registry.register('custom-efficientsed-e2e', {
        manifestUrl: '/assets/efficientsed/model.json',
        onnxUrl: '/assets/efficientsed/fmn10-tf256.onnx',
        frontendUrl: '/assets/efficientsed/frontend.json',
        frontendType: 'efficientsed',
        sampleRate: 16000,
        windowSeconds: 10,
        strideSeconds: 5,
        frameSeconds: 0.04,
        framesPerWindow: 250,
        hopFrames: 125,
        scoreType: 'frame',
        inputName: 'mel',
        inputShape: [1, 1, 128, 1000],
      });
      let refWaveform = null;
      const wavResp = await fetch('/assets/efficientsed/reference-waveform.f32');
      if (wavResp.ok) refWaveform = new Float32Array(await wavResp.arrayBuffer());
      else refWaveform = new Float32Array(160000);

      const track = {
        id: 1,
        codec: 'opus',
        canDecode: async () => true,
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 10,
      };
      const video = {
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 10,
      };
      const MB = {
        ALL_FORMATS: [],
        BlobSource: class {},
        Input: class {
          async getPrimaryVideoTrack() { return video; }
          async getAudioTracks() { return [track]; }
          async getPrimaryAudioTrack() { return track; }
          dispose() {}
        },
      };
      const openAudioStream = (_mb, _track, _origin, _audioLen, _sampleRate, check, metrics, onDecoded) => {
        metrics.decoderPasses = 1;
        let sent = false;
        return {
          async next() {
            check();
            if (sent) return null;
            sent = true;
            onDecoded({
              timestamp: 0,
              buffer: { duration: 10, numberOfChannels: 1, sampleRate: 16000, getChannelData: () => refWaveform },
            });
            return refWaveform.slice();
          },
          async close() {},
        };
      };
      const queue = createBrowserAnalysis({ MB, models: registry, openAudioStream });
      await queue.importFiles([{ name: 'custom-worker-check.mp4', size: 128, lastModified: 1 }], { model: 'custom-efficientsed-e2e' });
      await queue.whenIdle();
      const rec = queue.records[0];
      return {
        status: rec.status,
        error: rec.error,
        model: rec.model,
        groupCount: rec.scoreTimeline?.groupCount ?? 0,
        groupScoreFrames: rec.scoreTimeline?.groupScoreFrames ?? 0,
      };
    });
    assert.equal(customWorkerResult.status, 'complete', customWorkerResult.error);
    assert.equal(customWorkerResult.model, 'custom-efficientsed-e2e');
    assert.equal(customWorkerResult.groupCount, 4);
    assert.equal(customWorkerResult.groupScoreFrames, 250);

    // 3. Default EfficientSED single-pass analysis on real combat sample (or synthetic fallback)
    const demoAvailable = !useSynthetic && await driver.evaluate(async () => {
      const r = await fetch('/demo/manifest.json');
      return r.ok;
    });
    if (demoAvailable) {
      await driver.evaluate(async () => {
        const [meta, blob] = await Promise.all([
          fetch('/demo/manifest.json').then((r) => r.json()),
          fetch('/demo/recording.mp4').then((r) => r.blob()),
        ]);
        const file = new File([blob], meta.name, { type: 'video/mp4', lastModified: meta.lastModified });
        await reviewApp.importFiles([file]);
      });
    } else if (samplePath && driver.uploadSample) {
      await driver.uploadSample(samplePath);
    } else {
      await driver.evaluate(async () => {
        const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
        await reviewApp.importFiles([await createSyntheticFile()]);
      });
    }

    await driver.waitFor(() => window.reviewApp?.queue.records[0]?.status === 'complete', 120000);
    const analysisSummary = await driver.evaluate(() => {
      const rec = reviewApp.queue.records[0];
      return {
        status: rec.status,
        error: rec.error,
        model: rec.model,
        decoderPasses: rec.timings?.decoderPasses,
        duration: rec.duration,
        groupCount: rec.scoreTimeline?.groupCount ?? 0,
        groupScoreFrames: rec.scoreTimeline?.groupScoreFrames ?? 0,
        pyramidLevels: rec.scoreTimeline?.groupScorePyramid?.levels?.length ?? 0,
        peakLevels: rec.waveform?.pyramid?.levels?.length ?? 0,
        candidateCount: rec.candidates?.length ?? 0,
      };
    });
    assert.equal(analysisSummary.status, 'complete', analysisSummary.error);
    assert.equal(analysisSummary.model, 'efficientsed');
    assert.equal(analysisSummary.decoderPasses, 1);
    assert.equal(analysisSummary.groupCount, 4);
    assert.ok(analysisSummary.groupScoreFrames > 0);
    assert.ok(analysisSummary.pyramidLevels > 0);
    assert.ok(analysisSummary.peakLevels > 0);
    if (samplePath) {
      assert.ok(analysisSummary.candidateCount > 0, 'Expected real combat sample to yield gunshot candidates');
    }

    // 4. Open review & verify #player-overview-distribution + 5-group layered #prediction-wave rendering
    await driver.clickSelector('#queue .file');
    await driver.waitFor(() => window.reviewApp?.player.state.status === 'paused', 20000);
    await driver.waitFor(() => {
      const w = document.getElementById('prediction-wave');
      const o = document.getElementById('player-overview-distribution');
      return Number(w?.dataset.paintCount || 0) >= 1 && Number(o?.dataset.paintCount || 0) >= 1;
    }, 10000);
    await driver.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const canvasBaseline = await driver.evaluate(() => {
      const inspectCanvas = (id) => {
        const canvas = document.getElementById(id);
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let nonZero = 0;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            nonZero++;
            if (colors.size < 20) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
          }
        }
        return {
          width: canvas.width,
          height: canvas.height,
          paintCount: Number(canvas.dataset.paintCount || 0),
          groupScoreFrames: Number(canvas.dataset.groupScoreFrames || 0),
          nonZero,
          colorCount: colors.size,
          dataUrl: canvas.toDataURL(),
        };
      };
      return {
        wave: inspectCanvas('prediction-wave'),
        overview: inspectCanvas('player-overview-distribution'),
        toggleIds: [...document.querySelectorAll('#waveform-group-toggles button')].map((b) => ({
          id: b.dataset.groupId,
          pressed: b.getAttribute('aria-pressed'),
        })),
      };
    });
    assert.ok(canvasBaseline.wave.width > 0 && canvasBaseline.wave.nonZero > 0);
    assert.ok(canvasBaseline.overview.width > 0 && canvasBaseline.overview.nonZero > 0);
    assert.ok(canvasBaseline.wave.groupScoreFrames === analysisSummary.groupScoreFrames);
    assert.deepEqual(
      canvasBaseline.toggleIds,
      ['gunshot', 'speech', 'music', 'impact'].map((id) => ({ id, pressed: 'true' })),
    );
    if (samplePath) {
      assert.ok(canvasBaseline.wave.colorCount > 1, 'Expected multi-color layered rendering on combat sample');
    }

    // 5. Playback & seek toDataURL() invariance, plus pyramid zoom/pan down to 40ms
    await driver.evaluate(async () => {
      const id = reviewApp.activeSourceId;
      const dur = reviewApp.workspace.getSource(id).duration;
      const target = Math.min(dur * 0.25, Math.max(0.5, dur - 0.5));
      reviewApp.workspace.setReview(id, { position: target });
      await reviewApp.player.seek(target);
    });
    await driver.waitFor(() => window.reviewApp.player.state.status === 'paused', 10000);
    const startPlayPos = await driver.evaluate(() => {
      window.__e2ePlayStart = window.reviewApp.player.state.position;
      return window.__e2ePlayStart;
    });
    await driver.clickSelector('#play-pause');
    await driver.waitFor(() => window.reviewApp.player.state.position > window.__e2ePlayStart + 0.35, 10000);
    await driver.clickSelector('#play-pause');
    await driver.waitFor(() => window.reviewApp.player.state.status === 'paused', 10000);

    const afterPlayCheck = await driver.evaluate(() => ({
      pos: window.reviewApp.player.state.position,
      waveUrl: document.getElementById('prediction-wave').toDataURL(),
      wavePaint: Number(document.getElementById('prediction-wave').dataset.paintCount),
      overviewUrl: document.getElementById('player-overview-distribution').toDataURL(),
      overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
    }));
    assert.ok(afterPlayCheck.pos > startPlayPos + 0.3, `Expected playback to advance from ${startPlayPos}`);
    assert.equal(afterPlayCheck.waveUrl, canvasBaseline.wave.dataUrl, 'Playback/seek must not alter waveform pixels');
    assert.equal(afterPlayCheck.wavePaint, canvasBaseline.wave.paintCount, 'Playback/seek must not repaint waveform');
    assert.equal(afterPlayCheck.overviewUrl, canvasBaseline.overview.dataUrl, 'Playback/seek must not alter overview pixels');
    assert.equal(afterPlayCheck.overviewPaint, canvasBaseline.overview.paintCount, 'Playback/seek must not repaint overview');

    // Zoom down to 40ms via wheel on #source-axis
    const axisBox = await driver.evaluate(() => {
      const r = document.getElementById('source-axis').getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
    });
    for (let i = 0; i < 24; i++) {
      await driver.wheel(axisBox.x, axisBox.y, 0, -250);
      const span = await driver.evaluate(() => {
        const s = reviewApp.workspace.getSource(reviewApp.activeSourceId);
        return s.review.zoomEnd - s.review.zoomStart;
      });
      if (span <= 0.041) break;
    }
    await driver.waitFor(() => !document.getElementById('selection-player-axis').dataset.transitioning, 5000);
    await driver.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const zoomedState = await driver.evaluate(() => {
      const s = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      const ticks = [...document.getElementById('source-ticks').children].map((n) => n.textContent);
      return {
        zoomStart: s.review.zoomStart,
        zoomEnd: s.review.zoomEnd,
        span: s.review.zoomEnd - s.review.zoomStart,
        zoomInDisabled: document.getElementById('prediction-zoom').disabled,
        ticks,
        wavePaint: Number(document.getElementById('prediction-wave').dataset.paintCount),
        waveUrl: document.getElementById('prediction-wave').toDataURL(),
        overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
        overviewUrl: document.getElementById('player-overview-distribution').toDataURL(),
      };
    });
    assert.ok(zoomedState.span <= 0.041 && zoomedState.span >= 0.039, `Expected 40ms zoom span, got ${zoomedState.span}`);
    assert.equal(zoomedState.zoomInDisabled, true);
    assert.ok(zoomedState.ticks.some((text) => /\.\d{3}$/.test(text)), `Expected ms ticks, got ${JSON.stringify(zoomedState.ticks)}`);
    assert.ok(zoomedState.wavePaint > canvasBaseline.wave.paintCount);
    assert.notEqual(zoomedState.waveUrl, canvasBaseline.wave.dataUrl);
    assert.equal(zoomedState.overviewPaint, canvasBaseline.overview.paintCount, 'Zooming must never repaint overview');
    assert.equal(zoomedState.overviewUrl, canvasBaseline.overview.dataUrl, 'Zooming must never alter overview pixels');

    // Horizontal pan at 40ms detail without repainting overview
    await driver.evaluate((prev) => { window.__e2eZoomBeforePan = prev; }, zoomedState.zoomStart);
    await driver.wheel(axisBox.x, axisBox.y, 120, 0);
    await driver.waitFor(() => {
      const s = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      return s.review.zoomStart !== window.__e2eZoomBeforePan;
    }, 5000);
    await driver.waitFor(() => !document.getElementById('selection-player-axis').dataset.transitioning, 5000);
    const pannedState = await driver.evaluate(() => {
      const s = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      return {
        zoomStart: s.review.zoomStart,
        zoomEnd: s.review.zoomEnd,
        span: s.review.zoomEnd - s.review.zoomStart,
        wavePaint: Number(document.getElementById('prediction-wave').dataset.paintCount),
        waveUrl: document.getElementById('prediction-wave').toDataURL(),
        overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
      };
    });
    assert.ok(pannedState.zoomStart !== zoomedState.zoomStart, 'Horizontal pan should move zoomStart');
    assert.ok(pannedState.span <= 0.041 && pannedState.span >= 0.039);
    assert.equal(pannedState.overviewPaint, canvasBaseline.overview.paintCount);

    // Seeking within zoomed 40ms window keeps both waveform & overview canvases pixel-identical
    await driver.evaluate(async () => {
      const id = reviewApp.activeSourceId;
      const src = reviewApp.workspace.getSource(id);
      const mid = (src.review.zoomStart + src.review.zoomEnd) / 2;
      reviewApp.workspace.setReview(id, { position: mid });
      await reviewApp.player.seek(mid);
    });
    await driver.waitFor(() => window.reviewApp.player.state.status === 'paused', 10000);
    const zoomedSeekState = await driver.evaluate(() => ({
      wavePaint: Number(document.getElementById('prediction-wave').dataset.paintCount),
      waveUrl: document.getElementById('prediction-wave').toDataURL(),
      overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
      overviewUrl: document.getElementById('player-overview-distribution').toDataURL(),
    }));
    assert.equal(zoomedSeekState.wavePaint, pannedState.wavePaint);
    assert.equal(zoomedSeekState.waveUrl, pannedState.waveUrl);
    assert.equal(zoomedSeekState.overviewPaint, canvasBaseline.overview.paintCount);
    assert.equal(zoomedSeekState.overviewUrl, canvasBaseline.overview.dataUrl);

    await driver.clickSelector('#source-fit');
    await driver.waitFor(() => !document.getElementById('selection-player-axis').dataset.transitioning, 5000);

    // 6. #waveform-group-toggles isolation (speech off keeps overview identical; all off -> pure neutral #7b8391)
    const beforeToggleSnapshot = await driver.evaluate(() => {
      const rec = reviewApp.queue.records[0];
      const src = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      return {
        groupScores: Array.from(rec.scoreTimeline.groupScores.slice(0, 500)),
        candidateCount: rec.candidates.length,
        decisions: src.decisions,
        overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
      };
    });

    await driver.clickSelector('#waveform-group-toggles [data-group-id="speech"]');
    const afterSpeechToggle = await driver.evaluate(() => ({
      pressed: document.querySelector('#waveform-group-toggles [data-group-id="speech"]').getAttribute('aria-pressed'),
      overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
    }));
    assert.equal(afterSpeechToggle.pressed, 'false');
    assert.equal(afterSpeechToggle.overviewPaint, beforeToggleSnapshot.overviewPaint);

    await driver.clickSelector('#waveform-group-toggles [data-group-id="gunshot"]');
    const afterGunshotToggle = await driver.evaluate(() => ({
      pressed: document.querySelector('#waveform-group-toggles [data-group-id="gunshot"]').getAttribute('aria-pressed'),
      overviewPaint: Number(document.getElementById('player-overview-distribution').dataset.paintCount),
    }));
    assert.equal(afterGunshotToggle.pressed, 'false');
    assert.ok(afterGunshotToggle.overviewPaint > beforeToggleSnapshot.overviewPaint);

    for (const id of ['music', 'impact']) {
      await driver.clickSelector(`#waveform-group-toggles [data-group-id="${id}"]`);
    }
    const allDisabledCheck = await driver.evaluate(() => {
      const canvas = document.getElementById('prediction-wave');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const nonNeutral = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0 && (data[i] !== 123 || data[i + 1] !== 131 || data[i + 2] !== 145)) {
          nonNeutral.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
          if (nonNeutral.length >= 5) break;
        }
      }
      const rec = reviewApp.queue.records[0];
      const src = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      return {
        nonNeutral,
        groupScores: Array.from(rec.scoreTimeline.groupScores.slice(0, 500)),
        candidateCount: rec.candidates.length,
        decisions: src.decisions,
      };
    });
    assert.deepEqual(allDisabledCheck.nonNeutral, [], 'With all 4 groups off, waveform canvas must render only #7b8391 neutral contour');
    assert.deepEqual(allDisabledCheck.groupScores, beforeToggleSnapshot.groupScores);
    assert.equal(allDisabledCheck.candidateCount, beforeToggleSnapshot.candidateCount);
    assert.deepEqual(allDisabledCheck.decisions, beforeToggleSnapshot.decisions);

    // Re-enable 3 groups (leaving speech off briefly so Step 7 also checks hover shows raw scores regardless of toggle!)
    for (const id of ['gunshot', 'music', 'impact']) {
      await driver.clickSelector(`#waveform-group-toggles [data-group-id="${id}"]`);
    }

    // 7. #source-hover timestamp & 4-group raw scores (even while speech toggle is off)
    const hoverTarget = await driver.evaluate(() => {
      const rec = reviewApp.queue.records[0];
      const tl = rec.scoreTimeline;
      let bestFrame = 0;
      let bestSum = -1;
      for (let f = 0; f < tl.groupScoreFrames; f++) {
        const vt = (f + 0.5) * tl.frameSeconds + tl.audioOffset;
        if (vt < 0.2 || vt > rec.duration - 0.2) continue;
        let sum = 0;
        for (let g = 0; g < tl.groupCount; g++) sum += tl.groupScores[f * tl.groupCount + g];
        if (sum > bestSum) { bestSum = sum; bestFrame = f; }
      }
      const videoTime = (bestFrame + 0.5) * tl.frameSeconds + tl.audioOffset;
      const ratio = videoTime / rec.duration;
      const box = document.getElementById('source-axis').getBoundingClientRect();
      return {
        x: box.left + ratio * box.width,
        y: box.top + box.height * 0.5,
        expectedScores: Array.from(tl.groupScores.slice(bestFrame * 4, bestFrame * 4 + 4)).map((v) => v.toFixed(2)),
      };
    });
    await driver.mouseMove(hoverTarget.x, hoverTarget.y);
    await driver.waitFor(() => !document.getElementById('source-hover').hidden, 5000);
    const hoverCheck = await driver.evaluate(() => {
      const hover = document.getElementById('source-hover');
      const rows = [...document.querySelectorAll('#source-hover-scores .hover-score-row')].map((row) => ({
        groupId: row.dataset.groupId,
        enabled: row.dataset.enabled,
        value: row.querySelector('data')?.textContent,
      }));
      return {
        hidden: hover.hidden,
        scoreStatus: hover.dataset.scoreStatus,
        label: document.getElementById('source-hover-label')?.textContent || '',
        rows,
      };
    });
    assert.equal(hoverCheck.hidden, false);
    assert.equal(hoverCheck.scoreStatus, 'ok');
    assert.match(hoverCheck.label, /^\d{2}:\d{2}\.\d/);
    assert.equal(hoverCheck.rows.length, 4);
    assert.equal(hoverCheck.rows.find((r) => r.groupId === 'speech')?.enabled, 'false');
    assert.deepEqual(hoverCheck.rows.map((r) => r.value), hoverTarget.expectedScores);

    // Re-enable speech toggle & move pointer off axis
    await driver.clickSelector('#waveform-group-toggles [data-group-id="speech"]');
    await driver.mouseMove(2, 2);
    await driver.waitFor(() => document.getElementById('source-hover').hidden, 5000);

    // 8. Trim, exclude, and OPFS directory export
    await driver.evaluate(() => {
      const id = reviewApp.activeSourceId;
      const src = reviewApp.workspace.getSource(id);
      if (src.clips.filter((c) => !c.provisional && !c.excluded).length < 2) {
        const dur = src.duration;
        reviewApp.workspace.addManual(id, { start: Math.min(1, dur * 0.1), end: Math.min(dur, Math.max(2, dur * 0.25)) });
        reviewApp.workspace.addManual(id, { start: Math.min(dur - 2, dur * 0.5), end: Math.min(dur, dur * 0.65) });
      }
    });
    await driver.clickSelector('#overview-markers button');
    await driver.waitFor(() => {
      const id = reviewApp.activeSourceId;
      return !!reviewApp.workspace.getSource(id).review.selectedClipId && reviewApp.player.state.status === 'paused' && !document.getElementById('selection-player-axis').dataset.transitioning;
    }, 10000);
    await driver.evaluate(() => {
      const src = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      const clip = src.clips.find((c) => c.id === src.review.selectedClipId);
      window.__e2eBeforeTrimStart = clip.start;
      document.getElementById('selection-left').focus();
    });
    await driver.keyPress('ArrowRight', { code: 'ArrowRight', keyCode: 39 });
    await driver.waitFor(() => {
      const src = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      const clip = src.clips.find((c) => c.id === src.review.selectedClipId);
      return clip && clip.start > window.__e2eBeforeTrimStart && reviewApp.player.state.status === 'paused';
    }, 10000);
    await driver.clickSelector('#source-fit');
    await driver.waitFor(() => !document.getElementById('selection-player-axis').dataset.transitioning, 5000);
    await driver.clickSelector('#overview-markers button:last-of-type');
    await driver.waitFor(() => !document.getElementById('selection-player-axis').dataset.transitioning && reviewApp.player.state.status === 'paused', 10000);
    await driver.clickSelector('#exclude-selection');

    const decisionsState = await driver.evaluate(() => {
      const rec = reviewApp.queue.records[0];
      const src = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      const hasSelected = src.clips.some((c) => c.selected && !c.provisional);
      if (!hasSelected) {
        const retained = src.clips.find((c) => !c.excluded && !c.provisional);
        if (retained) reviewApp.workspace.choose(src.id, retained.id, true);
      }
      return {
        decisions: reviewApp.workspace.getSource(reviewApp.activeSourceId).decisions.map((d) => d.kind),
        selectedCount: reviewApp.workspace.getSource(reviewApp.activeSourceId).clips.filter((c) => c.selected && !c.provisional).length,
        groupScores: Array.from(rec.scoreTimeline.groupScores.slice(0, 500)),
      };
    });
    assert.ok(decisionsState.decisions.includes('retain'));
    assert.ok(decisionsState.decisions.includes('exclude'));
    assert.ok(decisionsState.selectedCount >= 1);
    assert.deepEqual(decisionsState.groupScores, beforeToggleSnapshot.groupScores);

    await driver.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      window.__e2eExportDir = await root.getDirectoryHandle('efficientsed-e2e-export', { create: true });
      window.showDirectoryPicker = async () => window.__e2eExportDir;
    });
    await driver.clickSelector('#export');
    await driver.waitFor(() => {
      const batch = window.reviewApp.workspace.view().batches[0];
      return batch && ['completed', 'failed'].includes(batch.status);
    }, 120000);
    const exportCheck = await driver.evaluate(async () => {
      const batch = window.reviewApp.workspace.view().batches[0];
      const sizes = [];
      for (const out of batch.outputs || []) {
        const f = await (await window.__e2eExportDir.getFileHandle(out.name)).getFile();
        sizes.push({ name: out.name, saved: out.saved, bytes: out.bytes, diskBytes: f.size });
      }
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('efficientsed-e2e-export', { recursive: true }).catch(() => {});
      return { status: batch.status, error: batch.error, outputs: sizes };
    });
    assert.equal(exportCheck.status, 'completed', exportCheck.error);
    assert.ok(exportCheck.outputs.length >= 1);
    for (const out of exportCheck.outputs) {
      assert.equal(out.saved, true);
      assert.ok(out.bytes > 0);
      assert.equal(out.diskBytes, out.bytes);
    }

    // 9. Responsive zero-scroll check at 1440x900, 1280x800, and 768x900 horizontal
    await driver.clickSelector('.batch-review');
    await driver.waitFor(() => !document.getElementById('review-page').hidden, 5000);
    for (const [width, height, checkVertical] of [[1440, 900, true], [1280, 800, true], [768, 900, false]]) {
      await driver.setViewport(width, height);
      await driver.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const layout = await driver.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      }));
      assert.ok(layout.scrollWidth <= layout.innerWidth, `${width}x${height} horizontal overflow: ${layout.scrollWidth} > ${layout.innerWidth}`);
      if (checkVertical) {
        assert.ok(layout.scrollHeight <= layout.innerHeight, `${width}x${height} vertical overflow: ${layout.scrollHeight} > ${layout.innerHeight}`);
      }
    }

    // 10. Reload session reset & zero page errors
    assert.equal(await driver.evaluate(() => window.reviewApp.shouldWarnOnLeave()), false);
    await driver.goto(driver.baseUrl);
    await driver.waitFor(() => !!window.reviewApp, 15000);
    const resetCheck = await driver.evaluate(async () => {
      await window.reviewApp.ready;
      return {
        sources: window.reviewApp.workspace.view().sources.length,
        batches: window.reviewApp.workspace.view().batches.length,
        bindings: window.reviewApp.bindings.size,
        analysisVisible: !document.getElementById('analysis-page').hidden,
      };
    });
    assert.equal(resetCheck.sources, 0);
    assert.equal(resetCheck.batches, 0);
    assert.equal(resetCheck.bindings, 0);
    assert.equal(resetCheck.analysisVisible, true);
    assert.deepEqual(driver.getErrors(), []);

    console.log(JSON.stringify({
      mode: driver.mode,
      sample: samplePath ? path.basename(samplePath) : 'synthetic',
      parityMaxError: parity.skipped ? 'skipped' : parity.maxError,
      customWorkerModel: customWorkerResult.model,
      decoderPasses: analysisSummary.decoderPasses,
      groupScoreFrames: analysisSummary.groupScoreFrames,
      zoom40msSpan: zoomedState.span,
      exportedFiles: exportCheck.outputs.length,
      zeroScrollViewports: ['1440x900', '1280x800', '768x900-horizontal'],
      reloadReset: 'passed',
      pageErrors: driver.getErrors(),
    }));
  } finally {
    clearTimeout(timeoutGuard);
    await driver?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
