const {readDisplayedFrame} = require('./recording-frame.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function run(directory) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/analysis-queue.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `import {createAnalysisQueue as create} from './analysis-queue.mjs?original';
        export const createAnalysisQueue = options => create({...options,
          analyze: async (record, ctx) => ctx.publish([2,5,8].map((start,i) =>
            ({id:String(i+1),start,end:start+2})),{frontier:Infinity})});`,
    }));
    await page.goto(process.env.REVIEW_URL);
    await page.locator('#files').setInputFiles(['A','B'].map(id => path.join(directory,id+'.mp4')));
    const row = name => page.locator('#queue .file[title="'+name+'.mp4"]');
    const marker = id => page.locator('#overview-markers [data-clip-id="auto:'+id+'"]');
    for (const name of ['A','B']) await row(name).locator('.library-status-badge[data-status="ready"]').waitFor();
    await row('A').click();
    await marker(3).click();
    const at = time => page.waitForFunction(target => reviewApp.player.state.status === 'paused' &&
      Math.abs(reviewApp.player.state.actual-target) <= 1/30, time, {timeout:10000});
    const frame = () => page.locator('#source-canvas').evaluate(canvas => canvas.toDataURL());
    await at(8);
    const start = await frame();
    await page.locator('#source-head').press('Shift+ArrowRight');
    await at(9);
    const middle = await frame();
    assert.ok(middle !== start, 'Source distinguishes middle from start');
    await row('B').click();
    await marker(2).click();
    await at(5);
    await page.locator('#toggle-current-clip').click();
    assert.equal(await page.locator('#toggle-current-clip').getAttribute('aria-pressed'),'false');
    await row('A').click();
    await at(9);
    assert.equal(await row('A').getAttribute('data-selected'),'true');
    assert.equal(await marker(3).getAttribute('aria-pressed'),'true');
    assert.ok(await frame() === middle,'Restored displayed A frame differs from original paused A frame');
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => reviewApp.player.state.playing && reviewApp.player.state.actual > 9.1);
    const playback = await readDisplayedFrame(page, 'A.mp4');
    assert.equal(playback.error, 0, JSON.stringify(playback));
    console.log('PASS A third clip at 8s, paused at 9s, B second clip toggled, A restored exact canvas at 9s and played', browser.version());
  } finally {
    await browser.close();
  }
}
run(process.argv[2]).catch(error => {console.error(error); process.exitCode=1;});
