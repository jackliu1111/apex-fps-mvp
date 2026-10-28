const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8794/');
    const results = await page.evaluate(async (realSample) => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
      const { createSelectionEvidence } = await import('./selection-evidence.mjs');
      const files = [await createSyntheticFile()];
      if (realSample) {
        const response = await fetch('/demo/recording.mp4');
        if (!response.ok) throw new Error('Real sample unavailable');
        files.push(new File([await response.blob()], 'real-sample.mp4'));
      }
      const Original = window.VideoDecoder, results = [];
      let decoded = [];
      window.VideoDecoder = new Proxy(Original, { construct(Target, args) {
        const decoder = new Target(...args), decode = decoder.decode.bind(decoder);
        decoder.decode = (chunk) => { decoded.push({ type: chunk.type, timestamp: chunk.timestamp }); return decode(chunk); };
        return decoder;
      } });
      try {
        for (const file of files) {
          const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
          const video = await input.getPrimaryVideoTrack(), origin = Math.max(0, await video.getFirstTimestamp());
          const sink = new MB.CanvasSink(video, { width: 160, fit: 'contain', poolSize: 1 });
          decoded = [];
          for (let i = 0; i < 10; i++) await sink.getCanvas(origin + 1.1 + i);
          const baseline = decoded.length; input.dispose(); decoded = [];
          let evidence, timer;
          try {
            const result = await new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Keyframe generation timed out')), 30000);
              evidence = createSelectionEvidence({ MB, onResult(result) {
                if (result.peaks) resolve(result);
                else if (result.status.includes('失败') || result.status.includes('不可用')) reject(new Error(result.status));
              } });
              evidence.request({ file, origin }, 1.1, 11.1);
            });
            results.push({ file: file.name, baselineDecoded: baseline, keyframeDecoded: decoded.length, allKeyframes: decoded.every(chunk => chunk.type === 'key'), uniqueImages: new Set(result.frames.map(frame => frame.image)).size, displayedImages: result.frames.length });
          } finally { clearTimeout(timer); evidence?.cancel(); }
        }
      } finally { window.VideoDecoder = Original; }
      return results;
    }, process.env.REAL_SAMPLE === '1');
    for (const result of results) {
      assert.equal(result.displayedImages, 10);
      assert.equal(result.allKeyframes, true);
      assert.equal(result.keyframeDecoded, result.uniqueImages, 'Repeated sample positions reuse a decoded keyframe');
      assert.ok(result.keyframeDecoded < result.baselineDecoded, 'Reference images avoid decoding the intervening frames');
    }
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
