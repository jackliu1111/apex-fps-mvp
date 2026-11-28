const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const {createSyntheticFile, readSyntheticFrame} = await import('./tests/synthetic-media.mjs');
      const file = await createSyntheticFile({sourceLabel:'B'});
      const [record] = await reviewApp.queue.importFiles([file], {autoAnalyze:false});
      const id = record.sourceId;
      reviewApp.workspace.publishCandidates(id, [{id:'first',start:4,end:6},{id:'second',start:8,end:10}]);
      reviewApp.workspace.updateAnalysis(id, {status:'completed'});
      await reviewApp.openReview(id, {focusFirstCandidate:true});
      window.displayed = () => readSyntheticFrame(document.querySelector('#source-canvas'));
    });
    const prev = page.locator('#prev-candidate'), next = page.locator('#next-candidate');
    const check = async (id, seconds) => {
      await page.waitForFunction(({id,seconds}) => {
        const source = reviewApp.workspace.getSource(reviewApp.activeSourceId);
        const frame = displayed();
        return source.review.selectedClipId === 'auto:' + id && frame.source === 'B' &&
          Math.abs(frame.frame - seconds * 12) <= 1;
      }, {id,seconds});
    };
    await check('first', 4);
    assert.ok(await prev.isDisabled());
    await next.click();
    await check('second', 8);
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => reviewApp.player.state.playing && displayed().frame >= 106);
    await prev.click();
    await check('first', 4);
    if (await page.locator('#play-pause').getAttribute('data-playing') === 'true') {
      await page.locator('#play-pause').click();
    }
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused');
    // Selection points to the opposite answer for both searches from the gap.
    await next.click();
    await check('second', 8);
    for (const [button, id, seconds] of [[prev,'first',4],[next,'second',8]]) {
      await page.evaluate(() => reviewApp.player.seek(7));
      await page.waitForFunction(() => Math.abs(displayed().frame - 84) <= 1);
      await button.click();
      await check(id, seconds);
    }
    assert.ok(await next.isDisabled());
    await page.evaluate(() => reviewApp.workspace.updateAnalysis(reviewApp.activeSourceId, {status:'analyzing'}));
    const before = await page.evaluate(() => displayed());
    await next.click();
    await page.getByText('Reached end of current candidates; analysis still in progress.', {exact:true}).waitFor();
    await check('second',8);
    assert.deepEqual(await page.evaluate(() => displayed()), before);
    assert.equal(await page.locator('#player-frame').getAttribute('data-playing'), 'false');
    console.log('PASS B navigation from playback and gap, 4s/8s decoded frames, completed and analyzing tail');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
