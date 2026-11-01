// Real Mediabunny and OPFS, with a filesystem failure or a deliberately tiny write budget.
// This catches rejected writes that a streaming producer does not await.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    for (const scenario of ['permission', 'buffer']) {
      const page = await browser.newPage(), pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:18806');
      const result = await page.evaluate(async scenario => {
        const MB = await import('/assets/vendor/mediabunny.mjs');
        const { createBrowserConverter } = await import('/browser-export.mjs');
        const { createSyntheticFile } = await import('/tests/synthetic-media.mjs');
        const file = await createSyntheticFile({ duration: 1 });
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(`directory-error-test-${scenario}`, { create: true });
        const directoryHandle = {
          name: directory.name,
          async getFileHandle(...args) {
            const handle = await directory.getFileHandle(...args);
            return {
              getFile: () => handle.getFile(),
              async createWritable() {
                const writer = await handle.createWritable();
                return {
                  async write(chunk) {
                    if (scenario === 'permission') throw new DOMException('WRITE_DENIED', 'NotAllowedError');
                    return writer.write(chunk);
                  },
                  close: () => writer.close(), abort: () => writer.abort(),
                };
              },
            };
          },
          removeEntry: (...args) => directory.removeEntry(...args),
        };
        let failure;
        try {
          await createBrowserConverter({ MB, ...(scenario === 'buffer' ? { maxBufferedBytes: 1 } : {}) })({ batch: { audio: { trackIndex: 0 }, output: { format: 'webm' } },
            clip: { start: 0, end: 0.5 }, source: { file, directoryHandle } });
        } catch (error) { failure = { name: error.name, message: error.message, needsDestination: error.needsDestination }; }
        // Allow the browser's unhandled-rejection notification task to run.
        await new Promise(resolve => setTimeout(resolve, 100));
        const remaining = [];
        for await (const name of directory.keys()) remaining.push(name);
        return { failure, remaining };
      }, scenario);
      if (scenario === 'permission') assert.deepEqual(result.failure, { name: 'NotAllowedError', message: 'WRITE_DENIED', needsDestination: true });
      else { assert.equal(result.failure?.name, 'Error', JSON.stringify(result)); assert.match(result.failure.message, /写入缓冲/); }
      assert.deepEqual(result.remaining, [], 'A failed write must remove only its partial file');
      assert.deepEqual(pageErrors, [], 'A handled export failure must not leak unhandled stream write rejections');
      console.log(`PASS: real streaming ${scenario} failure is reported once, partial file removed, no unhandled page errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
