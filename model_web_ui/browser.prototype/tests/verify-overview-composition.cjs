const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor:1 });
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.waitForFunction(() => window.reviewApp);
    await page.evaluate(async () => {
      await reviewApp.ready;
      const {createSyntheticFile, readSyntheticFrame} = await import('./tests/synthetic-media.mjs');
      const file = await createSyntheticFile({sourceLabel:'B'});
      const [record] = await reviewApp.queue.importFiles([file], {autoAnalyze:false});
      const id = record.sourceId;
      const scores = new Float32Array(300 * 4);
      scores[201 * 4] = 0.95;
      record.scoreTimeline = {groupScores:scores, groupScoreFrames:300};
      window.publish = provisional => reviewApp.workspace.publishCandidates(id, [
        {id:'known',start:2,end:3}, {id:'tail',start:8,end:8.06,provisional},
      ]);
      publish(true);
      await reviewApp.openReview(id, {focusFirstCandidate:true});
      window.displayed = () => readSyntheticFrame(document.querySelector('#source-canvas'));
    });
    await page.locator('#toggle-current-clip').click();
    const decision = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId).clips
      .find(c => c.id === 'auto:known').selected);
    assert.equal(await decision(), false);
    const before = await page.evaluate(() => displayed());
    const markers = page.locator('#player-overview-markers > span');
    const marker = markers.nth(1);
    const track = page.locator('#player-overview-distribution');
    for (const phase of ['normal', 'fullscreen', 'restored']) {
      if (phase !== 'normal') {
        await page.locator('#player-fullscreen').click();
        await page.waitForFunction(full => !!document.fullscreenElement === full, phase === 'fullscreen');
      }
      await page.locator('#player-frame').waitFor({state:'visible'});
      await page.waitForFunction(full =>
        (document.querySelector('#player-frame').dataset.fullscreen === 'true') === full,
        phase === 'fullscreen');
      await track.evaluate(async el => {
        const deadline = performance.now() + 5000;
        let previous = '', stable = 0;
        while (stable < 4) {
          if (performance.now() > deadline) throw Error('Overview track did not settle');
          await new Promise(requestAnimationFrame);
          const current = JSON.stringify(el.getBoundingClientRect());
          stable = current === previous ? stable + 1 : 0;
          previous = current;
        }
      });
      const box = await track.boundingBox();
      const interval = await marker.boundingBox();
      assert.ok(Math.abs(interval.x - box.x - box.width * 8 / 12) < 1);
      assert.ok(Math.abs(interval.x + interval.width - box.x - box.width * 8.06 / 12) < 1);
      // Capture the composed browser output; drawing layers can hide a correct canvas.
      const screenshot = await page.screenshot();
      const count = await page.evaluate(async ({png,box,interval}) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))]));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap,0,0);
        bitmap.close();
        const x = Math.ceil(interval.x - 0.5), y = Math.ceil(box.y);
        const w = Math.ceil(interval.x + interval.width - 0.5) - x;
        const h = Math.floor(box.y + box.height) - y;
        const rgba = ctx.getImageData(x,y,w,h).data;
        let red = 0;
        for (let i=0; i<rgba.length; i+=4) {
          if (rgba[i] > 100 && rgba[i] - rgba[i+1] > 40 && rgba[i] - rgba[i+2] > 40) red++;
        }
        return red;
      }, {png:screenshot.toString('base64'),box,interval});
      assert.ok(count > 0, phase + ': no visible gunshot pixels inside interval');
      console.log(phase, 'track width', box.width, 'red pixels', count);
    }
    assert.equal(await marker.evaluate(el => getComputedStyle(el).borderLeftStyle), 'dashed');
    await page.evaluate(() => publish(false));
    assert.equal(await markers.count(), 2);
    assert.equal(await marker.getAttribute('data-provisional'), 'false');
    assert.equal(await marker.evaluate(el => getComputedStyle(el).borderLeftStyle), 'solid');
    assert.deepEqual(await page.evaluate(() => displayed()), before);
    assert.equal(await decision(), false);
    const bar = await page.locator('#player-overview-bar').boundingBox();
    const y = bar.y + bar.height/2;
    await page.mouse.move(bar.x + bar.width/4, y);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.75, y);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const f = displayed();
      return reviewApp.player.state.status === 'paused' && f.source === 'B' && Math.abs(f.frame - 108) <= 1;
    });
    const needle = Number(await page.locator('#overview').inputValue());
    assert.ok(Math.abs(needle - 9) < 0.03);
    const [minutes, seconds] = (await page.locator('#overview-position').innerText()).split('/')[0].split(':').map(Number);
    assert.ok(Math.abs(minutes*60 + seconds - needle) < 0.1);
    console.log('PASS stable marker, retained frame and decision, post-fullscreen drag to', needle);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
