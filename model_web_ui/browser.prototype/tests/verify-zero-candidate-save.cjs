const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { verifyExport } = require('./recording-export-readback.cjs');

async function run(directory) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/analysis-queue.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `import { createAnalysisQueue as create } from './analysis-queue.mjs?original';
        export const createAnalysisQueue = options => create({ ...options,
          analyze: async (record, context) => {
            await new Promise(resolve => { window.finishZeroAnalysis = resolve; });
            context.publish([], {frontier: Infinity});
          } });`,
    }));
    await page.goto(process.env.REVIEW_URL);
    await page.locator('#files').setInputFiles(path.join(directory, 'B.mp4'));
    const row = page.locator('#queue .file[title="B.mp4"]');
    await page.waitForFunction(() => Boolean(window.finishZeroAnalysis));
    await row.click();
    const empty = page.locator('#prediction-empty');
    await empty.waitFor();
    assert.match(await empty.innerText(), /analysis proceeds|随分析逐步出现/);
    await page.evaluate(() => finishZeroAnalysis());
    await row.locator('.library-status-badge[data-status="ready"]').waitFor();
    const source = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    const b = await source();
    assert.equal(b.identity.name, 'B.mp4');
    assert.equal(b.clips.length, 0);
    for (let language = 0; language < 2; language++) {
      const chinese = (await page.locator('html').getAttribute('lang')).startsWith('zh');
      const expected = chinese ? /分析已完成，未发现候选/ : /Analysis complete\. No candidates found/;
      assert.match(await empty.innerText(), expected);
      await page.locator('#lang-toggle').click();
    }
    const manual = page.locator('#quick-manual');
    assert.ok(await manual.isEnabled());
    console.log('Ready with zero candidates', await empty.innerText());
    await manual.click();
    const clips = (await source()).clips;
    assert.equal(clips.length, 1);
    assert.ok(clips[0].manual && clips[0].selected);
    const decoded = await verifyExport(page, source, b, clips[0], []);
    console.log('PASS zero candidate save', browser.version(), JSON.stringify(decoded));
  } finally {
    await browser.close();
  }
}

run(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
