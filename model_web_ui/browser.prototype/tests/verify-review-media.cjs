#!/usr/bin/env node
// Browser acceptance harness. Does not import the fixture through the product UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mode = process.argv[2] || 'player';
const modes = new Set(['player', 'concurrent', 'storage', 'export', 'legacy-baseline']);
if (!modes.has(mode)) throw new Error(`Unknown mode: ${mode}`);
const resultPath = process.env.RESULT_PATH;
if (!resultPath) throw new Error('Set RESULT_PATH to a new JSON output path');
if (fs.existsSync(resultPath)) throw new Error(`Refusing to replace ${resultPath}`);
const mediaPath = process.env.MEDIA_PATH;
if (!['storage', 'export'].includes(mode) && (!mediaPath || !fs.statSync(mediaPath).isFile())) throw new Error('Set MEDIA_PATH to an existing local recording');
const baseUrl = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:8792/';
const report = { date: new Date().toISOString(), mode, baseUrl, source: mediaPath || null, baseline: mode === 'legacy-baseline' ? '86f7ef7c536493282a66265996223dc372293126' : undefined, passed: false };
const targetsFor = (duration) => duration > 2120 ? [300, 2100, 900] : [duration * 0.1, duration * 0.5, duration * 0.3];

function assertPlaybackHealthy(samples) {
  let previous;
  for (const sample of samples) {
    const state = sample.player || sample;
    assert.ok(!state.error, state.error || 'Player error');
    if (state.playing && state.status === 'playing') {
      assert.ok(Number.isFinite(state.actual), 'Playing without a displayed source frame');
      assert.ok(state.position - state.actual < 0.5, `Displayed frame is ${(state.position - state.actual).toFixed(3)} s behind playback`);
      if (previous?.playing && previous.status === 'playing' && state.position - previous.position > 0.5) {
        assert.notEqual(state.actual, previous.actual, 'Playback clock advanced while the displayed frame froze');
      }
    }
    previous = state;
  }
}

async function fixtureFile(page) {
  // A separate input has no product change handler, so the new UI cannot start a second analysis.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'review-test-fixture';
    input.setAttribute('aria-label', 'Isolated test fixture'); document.body.append(input);
  });
  await page.locator('#review-test-fixture').setInputFiles(mediaPath);
  return page.evaluate(async () => {
    window.reviewTestFile = document.querySelector('#review-test-fixture').files[0];
    const MB = window.reviewTestMB = await import('/assets/vendor/mediabunny.mjs');
    const input = new MB.Input({ source: new MB.BlobSource(reviewTestFile), formats: MB.ALL_FORMATS });
    const started = performance.now();
    try {
      const video = await input.getPrimaryVideoTrack();
      const origin = Math.max(0, await video.getFirstTimestamp());
      const duration = await video.computeDuration() - origin;
      window.reviewTestMedia = { origin, duration };
      return { name: reviewTestFile.name, bytes: reviewTestFile.size, origin, duration, probeMs: performance.now() - started };
    } finally { input.dispose(); }
  });
}

async function createPlayer(page) {
  await page.evaluate(async () => {
    const { createSourcePlayer } = await import('/source-player.mjs');
    const canvas = document.createElement('canvas'); canvas.id = 'review-test-canvas'; document.body.prepend(canvas);
    window.reviewTestPlayer = createSourcePlayer({ MB: reviewTestMB, canvas });
  });
}

async function playerRun(page) {
  report.media = await fixtureFile(page);
  const [start, far, middle] = targetsFor(report.media.duration);
  await createPlayer(page);
  report.open = await page.evaluate(async (position) => {
    const started = performance.now();
    await reviewTestPlayer.load({ file: reviewTestFile, ...reviewTestMedia, position });
    return { firstFrameMs: performance.now() - started, state: reviewTestPlayer.state };
  }, start);
  report.seeks = [];
  for (const target of [far, start, far]) {
    report.seeks.push(await page.evaluate(async (target) => {
      const started = performance.now(); await reviewTestPlayer.seek(target);
      return { target, firstFrameMs: performance.now() - started, state: reviewTestPlayer.state };
    }, target));
  }
  report.rapid = await page.evaluate(async (targets) => {
    await Promise.all(targets.map((target) => reviewTestPlayer.seek(target))); return reviewTestPlayer.state;
  }, [start, middle, far]);
  assert.equal(report.rapid.target, far);
  assert.equal(report.rapid.status, 'paused');
  await page.evaluate(() => reviewTestPlayer.play());
  report.playback = [];
  for (let index = 0; index < 10; index++) {
    await page.waitForTimeout(1000); report.playback.push(await page.evaluate(() => reviewTestPlayer.state));
  }
  await page.evaluate(() => reviewTestPlayer.pause());
  report.paused = await page.evaluate(() => reviewTestPlayer.state);
  await page.waitForTimeout(300); report.afterPause = await page.evaluate(() => reviewTestPlayer.state);
  assert.equal(report.afterPause.position, report.paused.position);
  assert.ok(report.playback.at(-1).position > far);
  assertPlaybackHealthy(report.playback);
  if (process.env.SCREENSHOT_PATH) {
    if (fs.existsSync(process.env.SCREENSHOT_PATH)) throw new Error('SCREENSHOT_PATH already exists');
    await page.locator('#review-test-canvas').screenshot({ path: process.env.SCREENSHOT_PATH });
    report.screenshot = process.env.SCREENSHOT_PATH;
  }
  await page.evaluate(() => reviewTestPlayer.dispose());
}

async function concurrentRun(page) {
  report.media = await fixtureFile(page);
  const [start, far, middle] = targetsFor(report.media.duration);
  await createPlayer(page);
  await page.evaluate(async () => {
    const { createBrowserAnalysis } = await import('/browser-analysis.mjs');
    window.reviewTestQueue = createBrowserAnalysis({ MB: reviewTestMB });
  });
  report.runs = [];
  for (let run = 0; run < 2; run++) {
    await page.evaluate(async ({ run, start }) => {
      if (run === 0) await reviewTestQueue.importFiles([reviewTestFile]);
      else await reviewTestQueue.retry(reviewTestQueue.records[0].id);
      await reviewTestPlayer.load({ file: reviewTestFile, ...reviewTestMedia, position: start });
      await reviewTestPlayer.play();
    }, { run, start });
    const samples = [], seeks = [];
    for (let index = 0; index < 40; index++) {
      await page.waitForTimeout(1000);
      if (index === 12 || index === 25) seeks.push(await page.evaluate(async (target) => {
        const started = performance.now(); await reviewTestPlayer.seek(target);
        return { target, firstFrameMs: performance.now() - started, state: reviewTestPlayer.state };
      }, index === 12 ? far : middle));
      samples.push(await page.evaluate(() => ({ player: reviewTestPlayer.state,
        analysis: { status: reviewTestQueue.records[0].status, processedUntil: reviewTestQueue.records[0].processedUntil } })));
    }
    await page.evaluate(() => reviewTestPlayer.pause());
    await page.evaluate(() => reviewTestQueue.whenIdle());
    const result = await page.evaluate(() => {
      const record = reviewTestQueue.records[0];
      return { status: record.status, error: record.error, windows: record.windows, clips: record.candidates.length, timings: record.timings };
    });
    report.runs.push({ result, samples, seeks });
    assert.equal(result.status, 'complete', result.error || undefined);
    assertPlaybackHealthy(samples);
    console.log(`Concurrent run ${run + 1}: ${(result.timings.totalMs / 1000).toFixed(3)} s`);
  }
  await page.evaluate(async () => { await reviewTestPlayer.dispose(); await reviewTestQueue.dispose(); });
}

async function storageRun(page) {
  const databaseName = `review-acceptance-${Date.now()}`;
  report.before = await page.evaluate(async (databaseName) => {
    const { createReviewWorkspace } = await import('/review-workspace.mjs');
    const { createIndexedDBStorage, identifyFile } = await import('/review-storage.mjs');
    const store = createIndexedDBStorage({ databaseName });
    const work = createReviewWorkspace({ storage: store }); await work.restore();
    const identity = await identifyFile(new File(['content-A'], 'same-name.webm', { lastModified: 1 }));
    const other = await identifyFile(new File(['content-B'], 'same-name.webm', { lastModified: 1 }));
    const id = work.addSource({ ...identity, duration: 2640 });
    work.publishCandidates(id, [{ key: 'trim', start: 600, end: 630 }, { key: 'exclude', start: 1200, end: 1220 }, { key: 'tail', start: 2600, end: 2640, provisional: true }]);
    const clips = work.getSource(id).clips;
    work.trim(id, clips[0].id, { start: 604, end: 622 }); work.choose(id, clips[1].id, false);
    work.setReview(id, { position: 2100, zoomStart: 590, zoomEnd: 640, selectedClipId: work.getSource(id).clips[0].id });
    work.updateAnalysis(id, { status: 'analyzing', processedUntil: 900 });
    work.submitBatch(id, { audio: { policy: 'source-primary' }, output: { videoBitrate: 2000000 } });
    work.trim(id, work.getSource(id).clips[0].id, { start: 605, end: 621 });
    await work.flush(); const view = work.view(); await store.close(); return { view, otherId: other.id };
  }, databaseName);
  await page.reload();
  report.after = await page.evaluate(async (databaseName) => {
    const { createReviewWorkspace } = await import('/review-workspace.mjs');
    const { createIndexedDBStorage } = await import('/review-storage.mjs');
    const store = createIndexedDBStorage({ databaseName });
    const work = createReviewWorkspace({ storage: store }); await work.restore();
    const view = work.view(); await store.close(); return view;
  }, databaseName);
  assert.equal(report.before.view.save.status, 'saved');
  assert.notEqual(report.before.view.sources[0].id, report.before.otherId);
  assert.equal(report.after.sources[0].review.position, 2100);
  assert.equal(report.after.sources[0].analysis.status, 'interrupted');
  assert.deepEqual(report.after.sources[0].clips.filter((clip) => clip.selected && !clip.provisional).map((clip) => [clip.start, clip.end]), [[605, 621]]);
  assert.deepEqual(report.after.batches[0].clips.map((clip) => [clip.start, clip.end]), [[604, 622]]);
  assert.equal(report.after.batches[0].status, 'interrupted');
  assert.equal(report.after.sources[0].decisions.filter((decision) => decision.kind === 'exclude').length, 1);
}

async function exportRun(page) {
  report.export = await page.evaluate(async () => {
    const MB = await import('/assets/vendor/mediabunny.mjs');
    const { createBrowserConverter } = await import('/browser-export.mjs');
    const { createExportQueue } = await import('/export-queue.mjs');
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
    const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 100000 });
    const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 32000 });
    const toneTrack = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
    output.addVideoTrack(video, { frameRate: 4 }); output.addAudioTrack(audio); output.addAudioTrack(toneTrack);
    await output.start();
    const silence = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
    const tone = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
    for (let index = 0; index < tone.length; index++) tone.getChannelData(0)[index] = 0.08 * Math.sin(2 * Math.PI * 440 * index / 48000);
    await audio.add(silence); await toneTrack.add(tone);
    for (let index = 0; index < 48; index++) await video.add(index / 4, 0.25);
    video.close(); audio.close(); toneTrack.close(); await output.finalize();
    const file = new File([output.target.buffer], 'export-fixture.webm', { type: 'video/webm' });
    const baseConvert = createBrowserConverter({ MB }); let capturedBlob;
    const convert = async (args) => { const result = await baseConvert(args); if (result.blob) capturedBlob = result.blob; return result; };
    const batch = { id: 'real-memory', sourceId: 'fixture', source: { name: file.name }, clips: [{ id: 'clip', start: 2, end: 5 }],
      audio: { trackIndex: 1 }, output: { videoBitrate: 300000, audioBitrate: 64000 } };
    const queue = createExportQueue({ convert });
    try {
      queue.enqueue(batch, { file, origin: 0 }); batch.clips[0].start = 4; batch.audio.trackIndex = 0;
      await queue.whenIdle(); const memory = queue.getBatch('real-memory');
      if (memory.status !== 'completed') throw new Error(JSON.stringify(memory));
      // Consume the converter's public Blob result; blob: fetch is deliberately not enabled in CSP.
      const probe = new MB.Input({ source: new MB.BlobSource(capturedBlob), formats: MB.ALL_FORMATS });
      let crossings = 0, count = 0, previous = 0, rate = 0;
      try {
        const track = await probe.getPrimaryAudioTrack();
        for await (const sample of new MB.AudioBufferSink(track).buffers(0.5, 1.5)) {
          rate = sample.buffer.sampleRate;
          for (const value of sample.buffer.getChannelData(0)) { if (previous < 0 && value >= 0) crossings++; previous = value; count++; }
        }
      } finally { probe.dispose(); }
      const frequency = crossings / (count / rate);
      const root = await navigator.storage.getDirectory();
      const name = `grill-acceptance-${crypto.randomUUID()}`, directory = await root.getDirectoryHandle(name, { create: true });
      let disk, cancelled;
      try {
        disk = await convert({ batch: { ...batch, audio: { trackIndex: 1 } }, clip: { start: 2, end: 5 }, source: { file, origin: 0, directoryHandle: directory } });
        disk.directoryEntries = []; for await (const [entry] of directory.entries()) disk.directoryEntries.push(entry);
        const controller = new AbortController();
        try {
          await convert({ batch, clip: { start: 0, end: 12 }, source: { file, origin: 0, directoryHandle: directory }, signal: controller.signal,
            onProgress: () => controller.abort(new DOMException('test cancel', 'AbortError')) });
        } catch (error) { cancelled = { name: error.name, message: error.message }; }
        if (!cancelled) throw new Error('Cancellation unexpectedly completed');
        disk.afterCancelEntries = []; for await (const [entry] of directory.entries()) disk.afterCancelEntries.push(entry);
      } finally { await root.removeEntry(name, { recursive: true }); }
      return { memory, frequency, disk, cancelled, fixtureBytes: file.size, storageLocation: 'temporary-origin-private-directory' };
    } finally { await queue.dispose(); }
  });
  const result = report.export;
  assert.equal(result.memory.outputs[0].start, 2);
  assert.equal(result.memory.outputs[0].saved, false);
  assert.equal(result.disk.saved, true);
  assert.equal(result.disk.directoryEntries.length, 1);
  assert.deepEqual(result.disk.afterCancelEntries, result.disk.directoryEntries);
  assert.ok(Math.abs(result.frequency - 440) < 5);
  assert.ok(Math.abs(result.disk.measuredDuration - 3) < 0.12);
}

async function baselineRun(page) {
  report.media = await fixtureFile(page);
  const [start, far] = targetsFor(report.media.duration);
  await page.waitForFunction(() => !!window.prototypeApi);
  await page.evaluate(async () => { await prototypeApi.importFiles([reviewTestFile]); prototypeApi.files[0].selected = 0; });
  report.previews = []; report.analysis = [];
  for (const position of [start, far, start]) {
    report.previews.push(await page.evaluate(async (start) => {
      const api = window.prototypeApi, file = api.files[0], time = performance.now();
      const blob = await api.makePreview(file, { start, end: Math.min(start + 5, file.duration) });
      const conversionMs = performance.now() - time, video = document.querySelector('#player');
      if (video.readyState < 2) await new Promise((resolve, reject) => {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('Video decode failed')), { once: true });
      });
      return { start, conversionMs, firstFrameMs: performance.now() - time, bytes: blob.size };
    }, position));
  }
  for (let run = 0; run < 2; run++) {
    const result = await page.evaluate(async () => {
      const api = window.prototypeApi, file = api.files[0]; file.status = '待分析';
      await api.run(() => api.analyzeQueue([file]));
      return { status: file.status, duration: file.duration, windows: file.windows, clips: file.clips.length, timings: file.timings };
    });
    report.analysis.push(result); assert.equal(result.status, '完成');
    console.log(`Baseline run ${run + 1}: ${(result.timings.totalMs / 1000).toFixed(3)} s`);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  report.pageErrors = []; page.on('pageerror', (error) => report.pageErrors.push(error.message));
  try {
    await page.goto(baseUrl);
    report.moduleHashes = await page.evaluate(async (mode) => {
      const files = mode === 'legacy-baseline' ? ['app.js', 'stream-audio.js', 'inference-worker.js']
        : mode === 'storage' ? ['review-workspace.mjs', 'review-storage.mjs']
        : mode === 'export' ? ['browser-export.mjs', 'export-queue.mjs']
        : ['source-player.mjs', 'browser-analysis.mjs', 'analysis-queue.mjs', 'stream-audio.js'];
      return Object.fromEntries(await Promise.all(files.map(async (name) => {
        const response = await fetch(`/${name}`);
        if (!response.ok) throw new Error(`Missing module ${name}`);
        const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
        return [name, [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')];
      })));
    }, mode);
    await ({ player: playerRun, concurrent: concurrentRun, storage: storageRun, export: exportRun, 'legacy-baseline': baselineRun })[mode](page);
    report.passed = true;
  } catch (error) { report.failure = error.stack || String(error); throw error; }
  finally {
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    await browser.close(); console.log(`${mode}: ${report.passed ? 'PASS' : 'FAIL'}; report ${resultPath}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
