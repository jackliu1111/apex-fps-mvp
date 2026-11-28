import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('batch import shows each stage and the player navigates from the middle of a clip', async ({ app, browser }) => {
  await app.open('/');
  await expect(browser.locator('#import-files')).toBeEnabled();
  const encoded = await browser.evaluate(async () => {
    const { createSyntheticFile } = await import('/tests/synthetic-media.mjs');
    const samples = [];
    for (const duration of [12, 6, 9]) {
      const file = await createSyntheticFile({ duration });
      const reader = new FileReader();
      const data = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(file);
      samples.push(await data);
    }
    return samples;
  });
  const directory = await mkdtemp(join(tmpdir(), 'apex-batch-e2e-'));
  try {
    const paths = ['one.webm', 'two.webm', 'three.webm'].map(name => join(directory, name));
    for (const [index, path] of paths.entries()) await writeFile(path, Buffer.from(encoded[index], 'base64'));
    // Hold real responses at the model and track-reader boundaries. The page
    // creates its own rows, runs the real model, and advances its own queue.
    await browser.evaluate(async () => {
      const { Input } = await import('/assets/vendor/mediabunny.mjs');
      const getAudioTracks = Input.prototype.getAudioTracks;
      const originalFetch = window.fetch;
      const aStarted = Promise.withResolvers();
      const model = Promise.withResolvers();
      const tracks = Promise.withResolvers();
      window.batchGates = { model, tracks };
      Input.prototype.getAudioTracks = async function (...args) {
        const result = await getAudioTracks.apply(this, args);
        if (this.source.file?.name === 'two.webm') await aStarted.promise;
        if (this.source.file?.name === 'three.webm') await tracks.promise;
        return result;
      };
      window.fetch = async function (...args) {
        const result = await originalFetch.apply(this, args);
        if (result.url.endsWith('/efficientsed/model.json')) {
          aStarted.resolve();
          await model.promise;
        }
        return result;
      };
      window.batchHistory = [];
      const queue = document.querySelector('#queue');
      const observer = new MutationObserver(() => {
        const rows = [...queue.querySelectorAll('.file')].map(row => {
          const badge = row.querySelector('.library-status-badge');
          return { name: row.querySelector('.library-filename').textContent, phase: badge.dataset.phase,
            label: badge.textContent, status: badge.dataset.status };
        });
        window.batchHistory.push(rows);
        if (rows.length === 3 && rows.every(row => row.status === 'ready')) {
          observer.disconnect();
          Input.prototype.getAudioTracks = getAudioTracks;
          window.fetch = originalFetch;
        }
      });
      observer.observe(queue, { childList: true, subtree: true, attributes: true });
    });
    const badge = (name: string) => browser.locator(`#queue .file[title="${name}"] .library-status-badge`);
    await browser.locator('#files').setInputFiles(paths);
    await expect(badge('two.webm')).toHaveAttribute('data-phase', 'queued');
    await expect(badge('one.webm')).toHaveAttribute('data-phase', 'model');
    await expect(badge('three.webm')).toHaveAttribute('data-phase', 'audioTracks');
    assert.doesNotMatch(await badge('two.webm').textContent(), /%/);
    await browser.evaluate(() => { window.batchGates.model.resolve(); });
    await expect(badge('one.webm')).toHaveAttribute('data-status', 'ready', { timeout: 120000 });
    await expect(badge('three.webm')).toHaveAttribute('data-phase', 'audioTracks');
    await browser.evaluate(() => { window.batchGates.tracks.resolve(); });
    await expect(browser.locator('#queue .library-status-badge[data-status="ready"]')).toHaveCount(3, { timeout: 120000 });
    const history = await browser.evaluate(() => window.batchHistory);
    const names = ['one.webm', 'three.webm', 'two.webm'];
    assert.ok(history.some(rows => rows.length === 3 && rows.every(row => row.phase === 'identifying' && row.label.trim()) &&
      rows.map(row => row.name).sort().join() === names.join()), 'three named files appear while identifying');
    for (const phase of ['video', 'audioTracks', 'audio', 'inference']) {
      assert.ok(history.some(rows => rows.some(row => row.phase === phase)), phase);
    }
    const diagnostics = await browser.evaluate(async () => {
      await window.reviewApp.queue.whenIdle();
      return (await window.reviewApp.collectDiagnostics()).workspace.sources;
    });
    assert.equal(diagnostics.length, 3);
    for (const [name, duration] of [['one.webm', 12], ['two.webm', 6], ['three.webm', 9]] as const) {
      await expect(badge(name)).toHaveAttribute('data-status', 'ready');
      const sources = diagnostics.filter(source => source.durationSec === duration);
      assert.equal(sources.length, 1, name);
      assert.equal(sources[0].status, 'complete', name);
      assert.equal(sources[0].phase, 'complete', name);
    }

    await browser.locator('#queue .file[title="one.webm"]').tap();
    // Use fixed ranges to check navigation independently of model scores on synthetic sound.
    await browser.evaluate(() => {
      const { workspace, activeSourceId } = window.reviewApp;
      workspace.publishCandidates(activeSourceId, [
        { id: 'one', start: 2, end: 5 }, { id: 'two', start: 8, end: 10 },
        { id: 'tail', start: 11, end: 11.5, provisional: true },
      ]);
    });
    await expect(browser.locator('#player-overview-markers [data-provisional="true"]')).toHaveCount(1);
    await browser.locator('#overview-markers [data-clip-id="auto:two"]').tap();
    await browser.locator('#play-pause').tap();
    await expect(browser.locator('#play-pause')).toHaveAttribute('data-playing', 'true');
    await browser.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 5000;
        function tick() {
          if (window.reviewApp.player.state.position >= 8.5) return resolve();
          if (performance.now() >= deadline) return reject(new Error('Player did not advance inside clip two'));
          requestAnimationFrame(tick);
        }
        tick();
      });
    });
    await browser.locator('#prev-candidate').tap();
    await expect(browser.locator('#prev-candidate')).toBeDisabled();
    const result = await browser.evaluate(() => {
      const { workspace, activeSourceId, player } = window.reviewApp;
      return { clip: workspace.getSource(activeSourceId).review.selectedClipId, position: player.state.position };
    });
    assert.equal(result.clip, 'auto:one');
    assert.ok(Math.abs(result.position - 2) < 0.12);

    const invalid = join(directory, 'invalid.webm');
    await writeFile(invalid, 'invalid video');
    await browser.locator('#files').setInputFiles([paths[0], invalid]);
    await expect(badge('invalid.webm')).toHaveAttribute('data-phase', 'failed');
    for (const name of names) await expect(badge(name)).toHaveAttribute('data-status', 'ready');
    await expect(browser.locator('#queue [data-phase="identifying"]')).toHaveCount(0);
    await expect(browser.locator('#queue .file')).toHaveCount(4);
    await expect(browser.locator('#queue .library-status-badge[data-status="ready"]')).toHaveCount(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
