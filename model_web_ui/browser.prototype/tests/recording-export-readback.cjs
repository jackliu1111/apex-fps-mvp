const assert = require('node:assert/strict');

async function verifyExport(page, source, b, trimmed, otherNames) {
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
  const closed = await page.evaluate(() => closedOutputs);
  assert.deepEqual(closed, [output.name]);
  console.log('Completed writer.close()', JSON.stringify({count:closed.length, files:closed}));
  await page.locator('.batch-files > summary').click();
  assert.ok((await page.locator('.output-item').innerText()).includes(output.name));
  const decoded = await page.evaluate(async ({name, start, end, otherNames}) => {
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
        errors.push({ b: Math.min(...aligned), otherSources: await Promise.all(otherNames.map(name => errorAt(name, target))),
          wrongRange: await errorAt('B', 8 + offset) });
      }
      return {names, duration:await inputs[0].computeDuration(), bytes:saved.size, errors};
    } finally {
      inputs.forEach(input => input.dispose());
    }
  }, {name:output.name, ...trimmed, otherNames});
  assert.deepEqual(decoded.names, [output.name]);
  assert.equal(decoded.bytes, output.bytes);
  assert.ok(Math.abs(decoded.duration - trimmed.end + trimmed.start) <= 1/30, JSON.stringify(decoded));
  for (const e of decoded.errors) assert.ok(e.b < 4 && e.b + 1 < Math.min(...e.otherSources,e.wrongRange), JSON.stringify(e));
  return decoded;
}

module.exports = { verifyExport };
