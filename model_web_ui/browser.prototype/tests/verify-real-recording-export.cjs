// Supply three distinct local one-minute 30 fps gameplay recordings named A/B/C.mp4.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const { installLiveFixture, exerciseWatch } = require('./watch-recording-scenario.cjs');

async function run(directory, mode) {
  const manual = mode === '--watch-manual';
  const watch = manual || mode === '--watch';
  assert.ok(directory, 'Supply a directory containing A.mp4, B.mp4, C.mp4');
  const endpoint = process.env.REVIEW_NATIVE_CDP_URL;
  const browser = endpoint ? await chromium.connectOverCDP(endpoint, { noDefaults: true }) : await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = endpoint ? await browser.contexts()[0].newPage() : await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const source = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
    const row = name => page.locator(`#queue .file[title="${name}.mp4"]`);
    if (watch) await installLiveFixture(page);
    await page.route('**/analysis-queue.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `import { createAnalysisQueue as create } from './analysis-queue.mjs?original';
        export function createAnalysisQueue(options) {
          const bStarted = Promise.withResolvers();
          window.offlineStarts = [];
          return create({ ...options,
            async prepare(record, context) {
              const media = await options.prepare(record, context);
              if (record.file.name !== 'B.mp4') await bStarted.promise;
              return media;
            },
            async analyze(record, context) {
              if (record.file.name === 'B.mp4') {
                bStarted.resolve();
                context.publish([{id:'first',start:2,end:6},{id:'second',start:8,end:10}], {frontier:Infinity});
                return;
              }
              offlineStarts.push({name:record.file.name, id:record.sourceId});
              await options.analyze(record, context);
              if (!${watch} && record.file.name === 'A.mp4') {
                window.aCompletion = Promise.withResolvers();
                await aCompletion.promise;
              }
            }
          });
        }`,
    }));
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:8793/');
    await page.locator('#files').setInputFiles((watch ? ['B'] : ['A', 'B', 'C']).map(id => path.join(directory, id + '.mp4')));
    await row('B').locator('.library-status-badge[data-status="ready"]').waitFor();
    await row('B').click();
    await page.locator('#overview-markers [data-clip-id="auto:second"]').click();
    await page.locator('#toggle-current-clip').click();
    const b = await source();
    assert.equal(b.identity.name, 'B.mp4');
    assert.equal(b.clips.find(c => c.id === 'auto:second').selected, false);
    async function checkPausedB(time) {
      await page.waitForFunction(target => {
        const { status, actual } = reviewApp.player.state;
        return status === 'paused' && Math.abs(actual - target) <= 1/30 + 0.000001;
      }, time);
      const frame = await page.evaluate(async () => {
        const MB = await import('/assets/vendor/mediabunny.mjs');
        const record = reviewApp.queue.records.find(r => r.file.name === 'B.mp4');
        const input = new MB.Input({source: new MB.BlobSource(record.file), formats: MB.ALL_FORMATS});
        try {
          const canvas = document.querySelector('#source-canvas');
          const {width, height} = canvas;
          const track = await input.getPrimaryVideoTrack();
          const sink = new MB.CanvasSink(track, {width, height, fit: 'contain'});
          const frame = await sink.getCanvas(await track.getFirstTimestamp() + reviewApp.player.state.actual + 0.001);
          const pixels = c => c.getContext('2d').getImageData(0, 0, width, height).data;
          const actual = pixels(canvas), expected = pixels(frame.canvas);
          let sum = 0;
          for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - expected[i]);
          return {time:reviewApp.player.state.actual, error:sum / actual.length};
        } finally {
          input.dispose();
        }
      });
      console.log('Displayed B', JSON.stringify(frame));
      assert.ok(frame.error < 1, JSON.stringify(frame));
    }
    if (watch) await page.locator('#source-head').press('Shift+ArrowRight');
    await checkPausedB(watch ? 9 : 8);
    console.log('Paused review', JSON.stringify({row:await page.locator('#queue .file[data-selected="true"]').getAttribute('title'),
      clip:(await source()).review.selectedClipId, selected:b.clips.map(({id,start,end,selected}) => ({id,start,end,selected}))}));
    await page.evaluate(() => {
      const canvas = document.querySelector('#source-canvas');
      window.frameSnapshot = () => canvas.toDataURL();
      window.beforeReturn = frameSnapshot();
      window.sourceLoads = [];
      const load = reviewApp.player.load.bind(reviewApp.player);
      reviewApp.player.load = params => {
        sourceLoads.push(params.file.name);
        return load(params);
      };
    });
    if (watch) {
      await exerciseWatch(page, directory, row, manual);
    } else {
      await page.waitForFunction(() => window.aCompletion, null, { timeout: 120000 });
      if (endpoint) {
        const other = await page.context().newPage();
        await other.bringToFront();
        await page.waitForFunction(() => document.hidden, null, { polling: 50 });
      }
      await page.evaluate(() => aCompletion.resolve());
      await row('A').locator('.library-status-badge[data-status="ready"]').waitFor();
      if (endpoint) {
        await page.bringToFront();
        await page.waitForFunction(() => !document.hidden);
      }
    }
    const returned = await page.evaluate(() => ({
      selected: document.querySelector('#queue .file[data-selected="true"]')?.title,
      loads: sourceLoads, sameFrame: frameSnapshot() === beforeReturn,
    }));
    assert.deepEqual(returned, { selected: 'B.mp4', loads: [], sameFrame: true }, 'Returning to paused B');
    assert.equal(await page.locator('#player-frame').getAttribute('data-playing'), 'false');
    assert.equal(await row('B').getAttribute('data-selected'), 'true');
    assert.equal((await source()).review.selectedClipId, 'auto:second');
    assert.equal(await page.locator('#toggle-current-clip').getAttribute('aria-pressed'), 'false');
    await page.locator('#prev-candidate').click();
    await page.waitForFunction(() => !document.querySelector('#selection-player-axis').dataset.transitioning &&
      reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId === 'auto:first');
    assert.equal(await page.locator('#overview-markers [data-clip-id="auto:first"]').getAttribute('aria-pressed'), 'true');
    await checkPausedB(2);
    if (manual) return;
    const box = await page.locator('#selection-left').boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 55, y, { steps: 8 });
    await page.mouse.up();
    const trimmed = (await source()).clips.find(c => c.manual && c.selected);
    assert.ok(trimmed?.start > 2 && trimmed.end === 6);
    await page.evaluate(async () => {
      window.outputDirectory = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports-' + crypto.randomUUID(), { create: true });
      window.closedOutputs = [];
      const getHandle = outputDirectory.getFileHandle.bind(outputDirectory);
      outputDirectory.getFileHandle = async (...args) => {
        const file = await getHandle(...args);
        if (!args[1]?.create) return file;
        const open = file.createWritable.bind(file);
        file.createWritable = async (...options) => {
          const writer = await open(...options);
          const close = writer.close.bind(writer);
          writer.close = async () => {
            await close();
            closedOutputs.push(file.name);
          };
          return writer;
        };
        return file;
      };
      window.showDirectoryPicker = async () => { throw new DOMException('cancel', 'AbortError'); };
    });
    await page.locator('#export-format').selectOption('webm');
    await page.locator('#export').click();
    await page.waitForFunction(() => reviewApp.workspace.view().batches[0]?.status === 'awaiting-destination');
    const [submission] = await page.evaluate(() => reviewApp.workspace.view().batches);
    assert.equal(submission.sourceId, b.id);
    assert.deepEqual(submission.clips, [{id:trimmed.id, start:trimmed.start, end:trimmed.end}]);
    console.log('Submitted', JSON.stringify({sourceId:submission.sourceId,name:b.identity.name,clips:submission.clips}));
    await page.locator('.batch-review').click();
    await page.locator('#toggle-current-clip').click();
    assert.equal((await source()).clips.find(c => c.id === trimmed.id).selected, false);
    await page.evaluate(() => { window.showDirectoryPicker = async () => outputDirectory; });
    await page.locator('#nav-exports').click();
    await page.locator('.batch-start').click();
    await page.waitForFunction(() => ['completed','failed'].includes(reviewApp.workspace.view().batches[0]?.status));
    const [batch] = await page.evaluate(() => reviewApp.workspace.view().batches);
    assert.equal(batch.status, 'completed', batch.error);
    assert.equal(batch.sourceId, b.id);
    assert.deepEqual(batch.clips, [{id:trimmed.id, start:trimmed.start, end:trimmed.end}]);
    assert.equal(batch.id, submission.id);
    const [output] = batch.outputs;
    assert.ok(output.saved);
    assert.deepEqual(await page.evaluate(() => closedOutputs), [output.name]);
    await page.locator('.batch-files > summary').click();
    assert.ok((await page.locator('.output-item').innerText()).includes(output.name));
    const decoded = await page.evaluate(async ({name, start, end}) => {
      const MB = await import('/assets/vendor/mediabunny.mjs');
      const names = await Array.fromAsync(outputDirectory.keys());
      const saved = await (await outputDirectory.getFileHandle(name)).getFile();
      const inputs = [];
      async function sink(file) {
        const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
        inputs.push(input);
        const track = await input.getPrimaryVideoTrack();
        return { frames: new MB.CanvasSink(track, { width: 80, height: 45, fit: 'contain' }),
          origin: await track.getFirstTimestamp() };
      }
      async function pixels(reader, time) {
        const {canvas} = await reader.frames.getCanvas(reader.origin + time);
        return canvas.getContext('2d').getImageData(0, 0, 80, 45).data;
      }
      function distance(a,b) {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
      }
      try {
        const output = await sink(saved);
        const sources = {};
        for (const {file} of reviewApp.queue.records) sources[file.name] = await sink(file);
        const errors = [];
        for (const offset of [0.1, (end-start)/2, end-start-0.12]) {
          const actual = await pixels(output, offset);
          const target = start + offset;
          const errorAt = async (id, time) => distance(actual, await pixels(sources[id + '.mp4'], time));
          const aligned = [];
          for (const n of [-1, 0, 1]) aligned.push(await errorAt('B', target + n / 30));
          errors.push({ b: Math.min(...aligned), a: await errorAt('A', target), c: await errorAt('C', target),
            wrongRange: await errorAt('B', 8 + offset) });
        }
        return {names, duration:await inputs[0].computeDuration(), bytes:saved.size, errors};
      } finally {
        inputs.forEach(input => input.dispose());
      }
    }, {name:output.name, ...trimmed});
    assert.deepEqual(decoded.names, [output.name]);
    assert.equal(decoded.bytes, output.bytes);
    assert.ok(Math.abs(decoded.duration - trimmed.end + trimmed.start) <= 1/30, JSON.stringify(decoded));
    for (const e of decoded.errors) assert.ok(e.b < 4 && e.b + 1 < Math.min(e.a,e.c,e.wrongRange), JSON.stringify(e));
    await page.locator('.batch-review').click();
    await row('C').locator('.library-status-badge[data-status="ready"]').waitFor();
    const durations = await page.evaluate(() => reviewApp.queue.records.map(record => record.duration));
    assert.equal(durations.length, 3);
    for (const duration of durations) assert.ok(Math.abs(duration - 60) <= 1/30 + 0.000001, JSON.stringify(durations));
    await row('A').click();
    await page.waitForFunction(() => reviewApp.player.state.status === 'paused' && sourceLoads.at(-1) === 'A.mp4');
    assert.equal((await source()).identity.name, 'A.mp4');
    console.log('PASS real recording chain', browser.version(), { nativeTab: Boolean(endpoint), durations, returned, start: trimmed.start, end: trimmed.end, decoded: JSON.stringify(decoded) });
  } finally {
    await browser.close();
  }
}
run(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
