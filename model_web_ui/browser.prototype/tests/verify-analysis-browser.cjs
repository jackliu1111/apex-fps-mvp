// Real WebCodecs + ONNX smoke at the user-confirmed browser-flow seam.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.ANALYSIS_TEST_URL || 'http://127.0.0.1:8794');
    const result = await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { createBrowserAnalysis } = await import('/browser-analysis.mjs');
      const queue = createBrowserAnalysis({ MB });
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
      const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
      const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 100000 });
      const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 32000 });
      const second = new MB.AudioBufferSource({ codec: 'opus', bitrate: 32000 });
      output.addVideoTrack(video, { frameRate: 4 }); output.addAudioTrack(audio, { name: 'silence' }); output.addAudioTrack(second, { name: 'tone' });
      await output.start();
      const silent = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
      const tone = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
      for (let i = 0; i < tone.length; i++) tone.getChannelData(0)[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / 48000);
      await audio.add(silent); await second.add(tone);
      for (let i = 0; i < 48; i++) await video.add(i / 4, 0.25);
      video.close(); audio.close(); second.close(); await output.finalize();
      const file = new File([output.target.buffer], 'analysis-two-tracks.webm', { type: 'video/webm' });
      const invalid = new File(['not media'], 'broken.webm', { type: 'video/webm' });
      await queue.importFiles([invalid, file]);
      await queue.whenIdle();
      const good = queue.records.find((record) => record.file.name === file.name);
      const bad = queue.records.find((record) => record.file.name === invalid.name);
      const windows = good.windows;
      queue.recompute(good.id, 0);
      const candidateAfterRecompute = good.candidates.length;
      const snapshot = { good: { status: good.status, error: good.error, windows, tracks: good.tracks?.length, selected: good.selected, output: good.outputAudioTrackIndex, decoderPasses: good.timings?.decoderPasses, processedUntil: good.processedUntil, duration: good.duration, model: good.model }, bad: { status: bad.status, error: bad.error }, candidateAfterRecompute, windowsAfterRecompute: good.windows };
      await queue.dispose();
      return snapshot;
    });
    assert.equal(result.good.status, 'complete', JSON.stringify(result));
    assert.equal(result.good.tracks, 2);
    assert.equal(result.good.windows, 2);
    assert.equal(result.good.decoderPasses, 1);
    assert.equal(result.good.output, 0);
    assert.equal(result.good.selected, 0);
    assert.equal(result.windowsAfterRecompute, result.good.windows);
    assert.equal(result.bad.status, 'failed');
    assert.ok(result.bad.error);
    assert.ok(result.candidateAfterRecompute > 0);
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
