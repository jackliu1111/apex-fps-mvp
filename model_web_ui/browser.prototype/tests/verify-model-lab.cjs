// Real browser decode/frontend/WASM integration. Only the directory-picker boundary
// is replaced with native OPFS on an EXTERNAL-DISK Chrome profile. Native system
// picker permission is NOT covered. Copy completed files out for independent audit.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = process.env.LAB_OUTPUT, source = process.env.LAB_SOURCE;
  if (!root || !source) throw new Error('Set LAB_OUTPUT on the external disk and LAB_SOURCE');
  await fs.mkdir(root, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(root, 'test-chrome-profile'), {
    executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, viewport: { width: 1440, height: 1100 }, args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(process.env.LAB_URL || 'http://127.0.0.1:8798/model-lab.html');
    await page.waitForFunction(() => window.modelLab);
    await page.evaluate(() => { window.showDirectoryPicker = async () => {
      const directory = await navigator.storage.getDirectory();
      return directory.getDirectoryHandle('model-lab-integration', { create: true });
    }; });
    await page.click('#directory');
    const benchmark = await page.evaluate(() => modelLab.benchmark());
    assert.equal(benchmark.passed, true, JSON.stringify(benchmark));
    console.log('BENCHMARK', JSON.stringify(benchmark));
    await page.setInputFiles('#file', source);
    await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
    await page.selectOption('#limit', process.env.LAB_LIMIT || '0');
    await page.click('#start');
    await page.waitForFunction(() => modelLab.run?.status === 'running', null, { timeout: 60000 });
    while (await page.evaluate(() => modelLab.busy)) {
      console.log('PROGRESS', await page.locator('#status').textContent());
      await page.waitForTimeout(10000);
    }
    const run = await page.evaluate(() => modelLab.run);
    assert.equal(run.status, 'complete', run.error);
    assert.equal(run.classes.length, 447);
    assert.equal(run.chunks.reduce((n, x) => n + x.frameCount, 0), run.totalFrames);
    assert.equal(run.chunks.reduce((n, x) => n + x.bytes, 0), run.totalFrames * 447 * 4);
    await page.fill('#threshold', '.35'); await page.locator('#threshold').dispatchEvent('change');
    await page.click('#recompute');
    await page.waitForFunction(() => !modelLab.busy);
    assert.equal(await page.evaluate(() => modelLab.report.threshold), .35);
    await page.fill('#threshold', '.2'); await page.locator('#threshold').dispatchEvent('change');
    await page.click('#recompute'); await page.waitForFunction(() => !modelLab.busy);
    const peak = await page.evaluate(() => modelLab.report.rows.find(x => x.name === 'Gunshot, gunfire')?.peakTime || 0);
    await page.evaluate(t => modelLab.inspect(t, true), peak);
    await page.screenshot({ path: path.join(root, 'model-lab-full.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const destination = path.join(root, run.directory); await fs.mkdir(path.join(destination, 'scores'), { recursive: true });
    // Read completed files through browser File System Access, compare bytes on host.
    for (const name of ['run.json', 'statistics.json', ...run.chunks.map(x => `scores/${x.file}`)]) {
      const bytes = await page.evaluate(async ({ folder, name }) => {
        let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('model-lab-integration');
        d = await d.getDirectoryHandle(folder);
        const parts = name.split('/'); if (parts.length === 2) d = await d.getDirectoryHandle(parts[0]);
        const file = await (await d.getFileHandle(parts.at(-1))).getFile();
        const data = new Uint8Array(await file.arrayBuffer()); let s = '';
        for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192));
        return btoa(s);
      }, { folder: run.directory, name });
      await fs.writeFile(path.join(destination, name), Buffer.from(bytes, 'base64'));
    }
    const final = await page.evaluate(() => ({ report: modelLab.report, timings: modelLab.run.timings, benchmark: modelLab.benchmarkResult }));
    // Reopen persisted probabilities after a page reload, without another inference.
    await page.reload(); await page.waitForFunction(() => window.modelLab);
    await page.evaluate(folder => { window.showDirectoryPicker = async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('model-lab-integration');
      return root.getDirectoryHandle(folder);
    }; }, run.directory);
    await page.click('#open-run');
    await page.waitForFunction(() => modelLab.run && !modelLab.busy);
    assert.equal(await page.evaluate(() => modelLab.report.frames), run.totalFrames);
    assert.equal(await page.evaluate(() => modelLab.run.timings.inferenceMs), final.timings.inferenceMs);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(root, 'acceptance.json'), JSON.stringify({ source, destination, ...final, errors,
      boundary: 'Real Chromium OPFS writes on external profile; native directory picker replaced. Files copied out for audit; not a native-picker acceptance.' }, null, 2));
    console.log('COMPLETE', JSON.stringify({ destination, frames: run.totalFrames, timings: final.timings, top: final.report.rows.slice(0, 12) }));
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
