const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function run(directory) {
  const browser = await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const ctx = new AudioContext();
        await ctx.resume();
        const dest = ctx.createMediaStreamDestination();
        const oscillator = ctx.createOscillator();
        oscillator.connect(dest);
        oscillator.start();
        window.signal = ctx;
        return dest.stream;
      };
    });
    await page.goto(process.env.REVIEW_URL);
    await page.locator('#files').setInputFiles(path.join(directory,'B.mp4'));
    const row = page.locator('#queue .file[title="B.mp4"]');
    await row.locator('.library-status-badge[data-status="ready"]').waitFor({timeout:120000});
    await row.click();
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(crypto.randomUUID(),{create:true});
      window.showDirectoryPicker = async () => dir;
      window.sampleAudio = () => ({
        source:document.querySelector('#queue .file[data-selected="true"]')?.title,
        clock:signal.currentTime, frame:reviewApp.player.state.actual,
        buckets:reviewApp.liveMonitor.getState().envelopeBucketCount,
        status:document.querySelector('#sidebar-popover-live-status').dataset.liveStatus,
        watch:reviewApp.watchDirState.status,
      });
    });
    await page.locator('#sidebar-watch-btn').click();
    await page.waitForFunction(() => reviewApp.watchDirState.status === 'watching');
    await page.locator('#sidebar-intake-settings-btn').click();
    await page.locator('#sidebar-live-toggle').click();
    await page.waitForFunction(() => reviewApp.liveMonitor.getState().envelopeBucketCount >= 20);
    const before = await page.evaluate(() => sampleAudio());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#player-mute').getAttribute('aria-pressed'),'false');
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => sampleAudio().status === 'paused-loopback');
    const gated = await page.evaluate(() => sampleAudio());
    await page.locator('#sidebar-intake-settings-btn').click();
    await page.locator('#sidebar-popover-notice').waitFor();
    assert.match(await page.locator('#sidebar-popover-notice').innerText(),/playback|回放/i);
    await page.keyboard.press('Escape');
    await page.waitForFunction(t => sampleAudio().frame > t+1,gated.frame);
    const playing = await page.evaluate(() => sampleAudio());
    assert.equal(playing.buckets,gated.buckets);
    assert.ok(playing.clock > gated.clock+0.5);
    await page.locator('#play-pause').click();
    await page.waitForFunction(n => sampleAudio().status === 'listening' && sampleAudio().buckets > n+10,playing.buckets);
    const resumed = await page.evaluate(() => sampleAudio());
    await page.waitForFunction(n => sampleAudio().buckets > n+20,resumed.buckets);
    const collecting = await page.evaluate(() => sampleAudio());
    assert.equal(collecting.frame,resumed.frame);
    for (const item of [before,gated,playing,resumed,collecting]) {
      assert.equal(item.source,'B.mp4');
      assert.equal(item.watch,'watching');
    }
    assert.equal(await page.locator('#player-frame').getAttribute('data-playing'),'false');
    const paused = await page.evaluate(async () => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const canvas = document.querySelector('#source-canvas');
      const {file} = reviewApp.queue.records.find(record => record.file.name === 'B.mp4');
      const input = new MB.Input({source:new MB.BlobSource(file),formats:MB.ALL_FORMATS});
      try {
        const track = await input.getPrimaryVideoTrack();
        const sink = new MB.CanvasSink(track,{width:canvas.width,height:canvas.height,fit:'contain'});
        const frame = await sink.getCanvas(await track.getFirstTimestamp()+reviewApp.player.state.actual+0.001);
        const pixels = c => c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        const expected = pixels(frame.canvas);
        return pixels(canvas).every((value,index) => value === expected[index]);
      } finally {input.dispose();}
    });
    assert.ok(paused,'Paused B canvas matches independent decode');
    console.log('PASS controlled oscillator through real audio worklet',browser.version(),JSON.stringify({before,gated,playing,resumed,collecting}));
  } finally {await browser.close();}
}
run(process.argv[2]).catch(error => {console.error(error);process.exitCode=1;});
