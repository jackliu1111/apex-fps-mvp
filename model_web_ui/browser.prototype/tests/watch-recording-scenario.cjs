const assert = require('node:assert/strict');
const path = require('node:path');

async function installLiveFixture(page) {
  // Exercise the real Start button and audio pipeline with a local silent track.
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.fixtureAudio = new AudioContext();
      return fixtureAudio.createMediaStreamDestination().stream;
    };
  });
  await page.route('**/auto-intake-service.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export * from './auto-intake-service.mjs?original';
      import {createAutoIntakeService as create} from './auto-intake-service.mjs?original';
      export function createAutoIntakeService(options) {
        return create({...options,
          getLiveHistory: () => ({startEpochMs: Date.now()-60000, envRms:[0.3],
            scoreWindows:[{start:0,end:60,scores:[0.9,0.1]}]}),
          alignRecording: async ({file,duration,liveHistory}) => file.name === 'C.mp4'
            ? {confidence:'exact',offsetMs:0,correlation:1,mapped:{
                windowScores:[{...liveHistory.scoreWindows[0],end:duration}]}}
            : {confidence:'unmatched'}
        });
      }`,
  }));
}

async function exerciseWatch(page, directory, row) {
  const navigations = [];
  const onNavigation = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
  page.on('framenavigated', onNavigation);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.watchFixtureDir = await root.getDirectoryHandle('watch-' + crypto.randomUUID(), {create:true});
    window.showDirectoryPicker = async () => watchFixtureDir;
    const canvas = document.querySelector('#source-canvas');
    const ctx = canvas.getContext('2d');
    const baseline = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const sourceId = reviewApp.activeSourceId;
    const actual = reviewApp.player.state.actual;
    const expectedClips = JSON.stringify(reviewApp.workspace.getSource(sourceId).clips);
    const trace = {actual, samples:0, draws:0, violations:[]};
    function fail(kind) {
      if (!trace.violations.includes(kind)) trace.violations.push(kind);
    }
    function checkPixels() {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      if (pixels.length !== baseline.length || !pixels.every((v,i) => v === baseline[i])) fail('changed pixels');
    }
    const draw = ctx.drawImage;
    ctx.drawImage = function(...args) {
      draw.apply(this,args);
      trace.draws++;
      checkPixels();
    };
    let raf;
    function sample() {
      trace.samples++;
      const source = reviewApp.workspace.getSource(reviewApp.activeSourceId);
      if (source?.id !== sourceId || document.querySelector('#queue .file[data-selected="true"]')?.title !== 'B.mp4') fail('selection');
      if (reviewApp.player.state.status !== 'paused' || reviewApp.player.state.actual !== actual) fail('player');
      if (source?.review.selectedClipId !== 'auto:second' || JSON.stringify(source.clips) !== expectedClips) fail('clips');
      raf = requestAnimationFrame(sample);
    }
    sample();
    window.stopWatchTrace = () => {
      cancelAnimationFrame(raf);
      ctx.drawImage = draw;
      checkPixels();
      return trace;
    };
  });
  await page.locator('#sidebar-watch-btn').click();
  await page.waitForFunction(() => reviewApp.watchDirState.status === 'watching');
  await page.locator('#sidebar-intake-settings-btn').click();
  await page.locator('#sidebar-auto-analyze').check();
  await page.locator('#sidebar-live-toggle').click();
  await page.waitForFunction(() => document.querySelector('#sidebar-live-toggle').getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => reviewApp.liveMonitor.getState().status === 'listening');
  assert.equal(await page.evaluate(() => reviewApp.autoIntake.getState().autoAnalyzeUncovered),true);
  await page.keyboard.press('Escape');
  // A separate file input gives the fixture writer bytes without importing into the app.
  const input = await page.evaluateHandle(() => Object.assign(document.createElement('input'), {type:'file',multiple:true}));
  await input.setInputFiles(['C','A'].map(id => path.join(directory,id+'.mp4')));
  await input.evaluate(async input => {
    for (const file of input.files) {
      const handle = await watchFixtureDir.getFileHandle(file.name,{create:true});
      const writer = await handle.createWritable();
      await writer.write(file);
      await writer.close();
    }
  });
  for (const id of ['C','A']) await row(id).locator('.library-status-badge[data-status="ready"]').waitFor({timeout:120000});
  const result = await page.evaluate(async () => {
    for (let i=0; i<2; i++) await reviewApp.engineBridge.pollWatchDirectory();
    await reviewApp.queue.whenIdle();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      trace: stopWatchTrace(), loads:[...sourceLoads], starts:window.offlineStarts,
      records:reviewApp.queue.records.map(r => ({name:r.file.name,id:r.sourceId,status:r.status,
        alignment:r.alignment?.confidence,source:r.modelInfo?.source,windows:r.windows,model:r.model})),
      intakeCount: reviewApp.autoIntake.getState().intakeCount,
    };
  });
  page.off('framenavigated',onNavigation);
  console.log('Watch intake and paused-frame trace',JSON.stringify({...result,navigations}));
  assert.deepEqual(navigations,[]);
  assert.deepEqual(result.trace.violations,[]);
  assert.ok(result.trace.samples > 1);
  assert.deepEqual(result.loads,[]);
  assert.equal(result.intakeCount,2);
  assert.equal(result.records.length,3);
  const c = result.records.find(r => r.name === 'C.mp4');
  const d = result.records.find(r => r.name === 'A.mp4');
  for (const record of [c,d]) {
    const item = row(record.name.slice(0,-4));
    assert.equal(await item.count(),1);
    assert.equal(await item.getAttribute('data-source-id'),record.id);
    assert.equal(record.status,'complete');
  }
  assert.equal(c.source,'live-monitor');
  assert.equal(c.alignment,'exact');
  assert.ok(d.windows > 0);
  assert.deepEqual(result.starts,[{name:d.name,id:d.id}]);
}

module.exports = {installLiveFixture,exerciseWatch};
