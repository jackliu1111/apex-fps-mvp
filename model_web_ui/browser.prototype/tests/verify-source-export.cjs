// Small synthetic fixtures: verifies encoded dimensions and frame timestamps,
// without loading a model or writing large media files.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8802');
    const results = await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { createBrowserConverter } = await import('/browser-export.mjs');
      const { sourceExportSettings } = await import('/export-policy.mjs');
      const { estimateExportBytes } = await import('/export-queue.mjs');
      const results = [];
      for (const spec of [{ width: 3840, height: 2160, fps: 60 }, { width: 1920, height: 1080, fps: 30000 / 1001 }, { width: 640, height: 360, fps: 30, variable: true }]) {
        const canvas = document.createElement('canvas'); Object.assign(canvas, { width: spec.width, height: spec.height });
        const ctx = canvas.getContext('2d');
        const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
        const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 8000000 });
        const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 96000 });
        output.addVideoTrack(video, spec.variable ? {} : { frameRate: spec.fps }); output.addAudioTrack(audio);
        await output.start();
        await audio.add(new AudioBuffer({ numberOfChannels: 1, length: 48000, sampleRate: 48000 }));
        let timestamp = 0;
        for (let i = 0; timestamp < 0.95; i++) {
          const duration = spec.variable ? (i % 2 ? 1 / 20 : 1 / 40) : 1 / spec.fps;
          ctx.fillStyle = i % 2 ? '#0c344c' : '#302010'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(i * 20, 40, 200, 200);
          await video.add(timestamp, duration); timestamp += duration;
        }
        video.close(); audio.close(); await output.finalize();
        const file = new File([output.target.buffer], 'source.webm');
        const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
        const sourceTrack = await input.getPrimaryVideoTrack();
        const settings = sourceExportSettings({}, sourceTrack);
        const batch = { output: settings, audio: { trackIndex: 0 }, clips: [{ start: 0, end: 1 }] };
        const exported = await createBrowserConverter({ MB })({ batch, clip: batch.clips[0], source: { file } });
        const probe = new MB.Input({ source: new MB.BlobSource(exported.blob), formats: MB.ALL_FORMATS });
        const targetTrack = await probe.getPrimaryVideoTrack();
        const targetAudio = await probe.getPrimaryAudioTrack();
        const timestamps = async (track) => { const values = []; for await (const packet of new MB.EncodedPacketSink(track).packets()) values.push(packet.timestamp); return values.sort((a,b) => a-b); };
        const sourceTimes = await timestamps(sourceTrack), targetTimes = await timestamps(targetTrack);
        results.push({ spec, videoCodec: targetTrack.codec, audioCodec: targetAudio.codec, mimeType: exported.blob.type, name: exported.name, width: targetTrack.displayWidth, height: targetTrack.displayHeight, sourceTimes, targetTimes, bytes: exported.bytes, estimate: estimateExportBytes(batch), tenSecondEstimate: estimateExportBytes({ ...batch, clips: [{ start: 0, end: 10 }] }), bitrate: settings.videoBitrate });
        input.dispose(); probe.dispose();
      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.videoCodec, 'avc'); assert.equal(result.audioCodec, 'aac');
      assert.equal(result.mimeType, 'video/mp4'); assert.ok(result.name.endsWith('.mp4'));
      assert.equal(result.width, result.spec.width); assert.equal(result.height, result.spec.height);
      assert.equal(result.targetTimes.length, result.sourceTimes.length);
      result.sourceTimes.forEach((time, i) => assert.ok(Math.abs(result.targetTimes[i] - time) < 0.002, 'Source frame timestamps preserved'));
      assert.ok(result.bytes < 100 * 1024 * 1024);
      if (result.spec.width === 3840) assert.ok(result.tenSecondEstimate > 64 * 1024 * 1024, '4K batches request a directory before encoding');
      console.log(JSON.stringify({ ...result, sourceTimes: undefined, targetTimes: undefined, frames: result.targetTimes.length, timestampCheck: 'passed' }));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
