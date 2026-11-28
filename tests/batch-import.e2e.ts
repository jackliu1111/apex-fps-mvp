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
    const file = await createSyntheticFile();
    const reader = new FileReader();
    const data = new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
    });
    reader.readAsDataURL(file);
    return data;
  });
  const directory = await mkdtemp(join(tmpdir(), 'apex-batch-e2e-'));
  try {
    const paths = ['one.webm', 'two.webm', 'three.webm'].map(name => join(directory, name));
    for (const path of paths) await writeFile(path, Buffer.from(encoded, 'base64'));
    await browser.evaluate(() => {
      window.batchHistory = [];
      const queue = document.querySelector('#queue');
      const observer = new MutationObserver(() => {
        const badges = [...queue.querySelectorAll('.library-status-badge')];
        window.batchHistory.push(badges.map(b => ({ phase: b.dataset.phase, label: b.textContent })));
        if (badges.length === 3 && badges.every(b => b.dataset.status === 'ready')) observer.disconnect();
      });
      observer.observe(queue, { childList: true, subtree: true, attributes: true });
    });
    await browser.locator('#files').setInputFiles(paths);
    await expect(browser.locator('#queue .library-status-badge[data-status="ready"]')).toHaveCount(3, { timeout: 120000 });
    const history = await browser.evaluate(() => window.batchHistory);
    assert.ok(history.some(rows => rows.length === 3 && rows.every(row => row.phase === 'identifying')));
    assert.ok(history.some(rows => rows.some(row => row.phase === 'queued') &&
      rows.some(row => ['audio', 'model', 'inference'].includes(row.phase) &&
        row.label !== rows.find(other => other.phase === 'queued').label)));
    for (const phase of ['video', 'audioTracks', 'audio', 'inference']) {
      assert.ok(history.some(rows => rows.some(row => row.phase === phase)), phase);
    }

    await browser.locator('#queue .file').first().tap();
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
    await expect(browser.locator('#queue [data-phase="failed"]')).toHaveCount(1);
    await expect(browser.locator('#queue [data-phase="identifying"]')).toHaveCount(0);
    await expect(browser.locator('#queue .file')).toHaveCount(4);
    await expect(browser.locator('#queue .library-status-badge[data-status="ready"]')).toHaveCount(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
