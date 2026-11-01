// Track 1: real browser media, focus handling and prediction-window seeking.
const assert = require('node:assert/strict');
const { statSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Observe native gain parameters without replacing the graph or audio processing.
  await page.addInitScript(() => {
    window.playbackTestGains = [];
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function (...args) {
      const gain = createGain.apply(this, args);
      window.playbackTestGains.push(gain);
      return gain;
    };
  });
  const source = () => page.evaluate(() => reviewApp.workspace.getSource(reviewApp.activeSourceId));
  const player = () => page.evaluate(() => reviewApp.player.state);
  const settled = () => page.waitForFunction(() => reviewApp.player.state.status === 'paused');
  const closeTo = (actual, expected, tolerance = 0.025) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be within ${tolerance} of ${expected}`);
  const clickWave = async ratio => {
    const axis = page.locator('.prediction-shared-axis');
    await axis.scrollIntoViewIfNeeded();
    const box = await axis.boundingBox();
    await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2);
    await settled();
  };
  try {
    await page.goto(process.env.REVIEW_URL || 'http://127.0.0.1:18808/');
    await page.waitForFunction(() => window.reviewApp);
    if (process.env.REVIEW_MEDIA_PATH) {
      const stat = statSync(process.env.REVIEW_MEDIA_PATH);
      assert.ok(stat.isFile() && stat.size > 0, 'REVIEW_MEDIA_PATH must be a nonempty existing media file');
      await page.evaluate(() => reviewApp.ready);
      await page.locator('#files').setInputFiles(process.env.REVIEW_MEDIA_PATH);
      await page.evaluate(bytes => { window.playbackFixtureBytes = bytes; }, stat.size);
    } else {
      await page.evaluate(async () => {
        await reviewApp.ready;
        const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
        const file = await createSyntheticFile();
        if (file.size >= 100 * 1048576) throw new Error('Playback fixture unexpectedly exceeds the local artifact limit');
        window.playbackFixtureBytes = file.size;
        await reviewApp.importFiles([file]);
      });
    }
    await page.waitForFunction(() => reviewApp.queue.records[0]?.status === 'complete', null, { timeout: 120000 });
    await page.locator('#queue [data-action=review]').first().click();
    await settled();
    await page.evaluate(() => reviewApp.workspace.publishCandidates(reviewApp.activeSourceId, [
      { id: 'one', start: 2, end: 3.1 }, { id: 'two', start: 8, end: 10 },
    ]));
    assert.equal(await page.locator('#play-selection').isDisabled(), true);
    await page.locator('#overview-markers button').first().click();
    await settled();
    await page.locator('.selection-details > summary').click();
    const initial = await source();
    const firstId = initial.review.selectedClipId;
    const secondId = initial.clips.find(clip => clip.id !== firstId).id;
    const firstRow = () => page.locator(`#clips [data-clip-id="${firstId}"]`);
    const secondRow = () => page.locator(`#clips [data-clip-id="${secondId}"]`);
    assert.equal(await firstRow().locator('.clip-badge').textContent(), '[1]');
    assert.equal(await secondRow().locator('.clip-badge').textContent(), '[2]');
    const exportBg = await page.locator('#export').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.ok(!exportBg.includes('176, 42, 36'), 'Export CTA should not use crimson');
    assert.equal(await page.locator('#status').evaluate(node => getComputedStyle(node).position), 'fixed');
    assert.equal(await page.locator('#play-selection').isEnabled(), true);
    // Waveform and candidate buttons occupy the same complete, 64 px-high row.
    const sharedBox = await page.locator('.prediction-shared-axis').boundingBox();
    const waveBox = await page.locator('#prediction-wave').boundingBox();
    const markersBox = await page.locator('#overview-markers').boundingBox();
    const markerBox = await page.locator('#overview-markers button').first().boundingBox();
    closeTo(sharedBox.height, 64, .5);
    for (const box of [waveBox, markersBox]) {
      closeTo(box.x, sharedBox.x, .5); closeTo(box.y, sharedBox.y, .5);
      closeTo(box.width, sharedBox.width, .5); closeTo(box.height, 64, .5);
    }
    closeTo(markerBox.y, sharedBox.y, .5); closeTo(markerBox.height, 64, .5);

    // Set the slider before the first AudioContext is created, using a real pointer.
    await page.locator('#player-volume').scrollIntoViewIfNeeded();
    const volumeBox = await page.locator('#player-volume').boundingBox();
    await page.mouse.click(volumeBox.x + volumeBox.width * .25, volumeBox.y + volumeBox.height / 2);
    const volume = (await player()).volume;
    assert.ok(volume > .15 && volume < .35, `slider should reduce volume, got ${volume}`);
    await page.locator('#player-mute').click();
    assert.equal((await player()).muted, true);
    assert.equal(await page.locator('#player-mute').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('m');
    assert.equal((await player()).muted, false);
    closeTo((await player()).volume, volume);
    await page.evaluate(() => reviewApp.openReview(reviewApp.activeSourceId));
    await settled();
    closeTo((await player()).volume, volume);
    assert.equal((await player()).muted, false);

    // Blank space and list-button focus both control playback without native scrolling
    // or the focused candidate button firing a second click on keyup.
    for (const target of [page.locator('.workspace-footer'), firstRow().locator('.clip-jump')]) {
      await target.click();
      await settled();
      const before = await page.evaluate(() => ({ scroll: scrollY, selected: reviewApp.workspace.getSource(reviewApp.activeSourceId).review.selectedClipId }));
      await page.keyboard.press('Space');
      await page.waitForFunction(() => reviewApp.player.state.playing);
      await page.keyboard.press('Space');
      await settled();
      assert.equal(await page.evaluate(() => scrollY), before.scroll);
      assert.equal((await source()).review.selectedClipId, before.selected);
    }

    // The live native graph follows the controls while sound is being scheduled.
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => reviewApp.player.state.playing);
    await page.locator('#player-volume').scrollIntoViewIfNeeded();
    const playingVolumeBox = await page.locator('#player-volume').boundingBox();
    await page.mouse.click(playingVolumeBox.x + playingVolumeBox.width * .65, playingVolumeBox.y + playingVolumeBox.height / 2);
    const playingVolume = (await player()).volume;
    assert.ok(playingVolume > .55 && playingVolume < .75);
    await page.waitForFunction(() => {
      const gain = playbackTestGains.at(-1);
      return reviewApp.player.state.playing && gain?.context.state === 'running' && Math.abs(gain.gain.value - reviewApp.player.state.volume) < .001;
    });
    const nativeGainVolume = await page.evaluate(() => playbackTestGains.at(-1).gain.value);
    await page.locator('#player-mute').click();
    await page.waitForFunction(() => reviewApp.player.state.playing && reviewApp.player.state.muted && playbackTestGains.at(-1).gain.value === 0);
    const nativeGainMuted = await page.evaluate(() => playbackTestGains.at(-1).gain.value);
    await page.keyboard.press('m');
    await page.waitForFunction(() => reviewApp.player.state.playing && !reviewApp.player.state.muted && Math.abs(playbackTestGains.at(-1).gain.value - reviewApp.player.state.volume) < .001);
    const nativeGainRestored = await page.evaluate(() => playbackTestGains.at(-1).gain.value);
    closeTo(nativeGainVolume, playingVolume, .001);
    closeTo(nativeGainRestored, playingVolume, .001);
    // A playing clock can be ahead of the periodically saved review position.
    await page.evaluate(() => {
      window.playbackTestPause = reviewApp.player.pause;
      reviewApp.player.pause = (...args) => {
        const state = playbackTestPause.apply(reviewApp.player, args);
        window.playbackTestPausedPosition = state.position;
        return state;
      };
    });
    await page.waitForFunction(() => {
      const lag = reviewApp.player.state.position - reviewApp.workspace.getSource(reviewApp.activeSourceId).review.position;
      return lag > .08 && lag < .2;
    });
    await page.keyboard.press('ArrowRight'); await settled();
    const precisePausedPosition = await page.evaluate(() => {
      const position = playbackTestPausedPosition;
      reviewApp.player.pause = playbackTestPause;
      delete window.playbackTestPause; delete window.playbackTestPausedPosition;
      return position;
    });
    closeTo((await player()).position, Math.round((precisePausedPosition + .1) * 100) / 100, .001);

    // An unselected export checkbox does not invalidate the active clip for listening.
    await firstRow().locator('.clip-selected').uncheck();
    await firstRow().locator('.clip-jump').click();
    await settled();
    await page.keyboard.press('Shift+Space');
    await page.waitForFunction(() => reviewApp.player.state.playing && reviewApp.player.state.position >= 2 && reviewApp.player.state.position < 2.7);
    await page.waitForFunction(() => !reviewApp.player.state.playing && Math.abs(reviewApp.player.state.position - 3.1) < .001);
    assert.equal((await player()).status, 'paused');
    closeTo((await source()).review.position, 3.1, .001);
    assert.equal((await source()).clips.find(clip => clip.id === firstId).selected, false);
    // The explicit button restarts at the same clip start, then normal pause cancels it.
    await page.locator('#play-selection').click();
    await page.waitForFunction(() => reviewApp.player.state.playing && reviewApp.player.state.position < 2.7);
    await page.keyboard.press('Space');
    await settled();
    assert.equal((await player()).playRange, null);
    await firstRow().locator('.clip-selected').check();

    // Global navigation works from the list and moves exactly once per key event.
    await firstRow().locator('.clip-jump').click(); await settled();
    await page.keyboard.press(']'); await settled();
    closeTo((await source()).review.position, 8);
    assert.notEqual((await source()).review.selectedClipId, firstId);
    await page.keyboard.press('['); await settled();
    closeTo((await source()).review.position, 2);
    await page.keyboard.press('ArrowRight'); await settled();
    closeTo((await source()).review.position, 2.1);
    await page.keyboard.press('Shift+ArrowLeft'); await settled();
    closeTo((await source()).review.position, 1.1);
    await page.locator('#source-head').focus();
    await page.keyboard.press('ArrowRight'); await settled();
    closeTo((await source()).review.position, 1.2);

    // Existing fields, select and editable regions retain their own keyboard behavior.
    await page.locator('.precise-editor > summary').click();
    for (const selector of ['#range-start', '#player-volume', '#source-select']) {
      const before = await player();
      await page.locator(selector).focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('m');
      await page.keyboard.press('ArrowRight');
      const after = await player();
      assert.equal(after.playing, before.playing);
      assert.equal(after.muted, before.muted);
      assert.equal(after.position, before.position);
    }
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'playback-editable-test';
      host.innerHTML = '<textarea aria-label="快捷键输入测试"></textarea><div contenteditable="true" tabindex="0">编辑测试</div>';
      document.querySelector('#review-page').append(host);
    });
    for (const selector of ['#playback-editable-test textarea', '#playback-editable-test [contenteditable]']) {
      await page.locator(selector).focus();
      const before = await player();
      await page.keyboard.press('Space'); await page.keyboard.press('m'); await page.keyboard.press('ArrowRight');
      assert.equal((await player()).playing, false);
      assert.equal((await player()).muted, before.muted);
      assert.equal((await player()).position, before.position);
    }
    await page.evaluate(() => document.querySelector('#playback-editable-test').remove());
    const ignoredEvents = await page.evaluate(() => {
      const before = reviewApp.player.state;
      const events = [
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', isComposing: true, bubbles: true, cancelable: true }),
        new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }),
        new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true, cancelable: true }),
      ];
      for (const event of events) document.body.dispatchEvent(event);
      return { before, after: reviewApp.player.state, prevented: events.map(event => event.defaultPrevented) };
    });
    assert.equal(ignoredEvents.after.position, ignoredEvents.before.position);
    assert.equal(ignoredEvents.after.muted, ignoredEvents.before.muted);
    assert.equal(ignoredEvents.after.playing, false);
    assert.deepEqual(ignoredEvents.prevented, [false, false, false]);

    // Seek against the shared wave coordinates, in both whole-source and local views.
    if (await page.locator('#prediction-fit').isEnabled()) await page.locator('#prediction-fit').click();
    const waveBefore = await page.evaluate(() => ({
      pixels: document.querySelector('#prediction-wave').toDataURL(),
      waveform: reviewApp.workspace.getSource(reviewApp.activeSourceId).waveform,
    }));
    const beforeSeek = await source();
    await clickWave(.6);
    closeTo((await source()).review.position, beforeSeek.duration * .6);
    assert.equal((await source()).review.selectedClipId, beforeSeek.review.selectedClipId);
    assert.deepEqual((await source()).decisions, beforeSeek.decisions);
    assert.deepEqual(await page.evaluate(() => ({ pixels: document.querySelector('#prediction-wave').toDataURL(), waveform: reviewApp.workspace.getSource(reviewApp.activeSourceId).waveform })), waveBefore);
    // Wheel zoom gesture smoothly magnifies the prediction window
    const fitWidth = await page.evaluate(() => document.querySelector('#overview-markers button').getBoundingClientRect().width);
    const sharedAxisEl = page.locator('.prediction-shared-axis');
    await sharedAxisEl.hover({ position: { x: 100, y: 32 } });
    await page.mouse.wheel(0, -200);
    await page.waitForFunction(w => {
      const el = document.querySelector('#overview-markers button');
      return el && el.getBoundingClientRect().width > w * 1.1;
    }, fitWidth);
    await page.locator('#prediction-fit').click();
    await page.locator('#prediction-zoom').click();
    // The first candidate is near the source start; half-source zoom clamps to zero.
    await clickWave(.75);
    closeTo((await source()).review.position, beforeSeek.duration / 2 * .75);
    assert.equal((await source()).review.selectedClipId, firstId);
    assert.deepEqual((await source()).decisions, beforeSeek.decisions);
    await page.locator('#overview-markers button').first().click(); await settled();
    closeTo((await source()).review.position, 2);
    assert.equal((await source()).review.selectedClipId, firstId);

    // Delete, undo and redo remain explicit and globally available after list focus.
    await firstRow().locator('.clip-jump').click(); await settled();
    await page.keyboard.press('Delete');
    const excluded = await source();
    assert.equal(excluded.review.selectedClipId, null);
    assert.equal(await page.locator('#play-selection').isDisabled(), true);
    await page.keyboard.press('Delete');
    assert.deepEqual((await source()).decisions, excluded.decisions);
    await page.keyboard.press('Meta+z');
    assert.equal((await source()).clips.find(clip => clip.id === firstId).excluded, false);
    await page.keyboard.press('Control+Shift+z');
    assert.equal((await source()).clips.find(clip => clip.start === 2 && clip.end === 3.1).excluded, true);
    await page.keyboard.press('Control+z');
    assert.equal((await source()).clips.find(clip => clip.id === firstId).excluded, false);

    // Focused trim handles still adjust the boundary rather than moving only the head.
    await page.locator('#overview-markers button').first().click(); await settled();
    await page.locator('#selection-left').focus();
    await page.keyboard.press('ArrowRight'); await settled();
    closeTo((await source()).clips.find(clip => clip.manual).start, 2.1);
    await page.keyboard.press('Control+z');
    closeTo((await source()).clips.find(clip => clip.id === firstId).start, 2);

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('#play-selection').isVisible(), true);
      assert.equal(await page.locator('#player-mute').isVisible(), true);
      assert.equal(await page.locator('#player-volume').isVisible(), true);
      if (process.env.REVIEW_SCREENSHOT_DIR) {
        await page.locator('.player-panel').screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/playback-${width}.png`, animations: 'disabled' });
        await page.locator('.prediction-track-box').screenshot({ path: `${process.env.REVIEW_SCREENSHOT_DIR}/waveform-${width}.png`, animations: 'disabled' });
      }
    }
    await page.locator('#nav-analysis').click();
    const offPage = await source(), offPagePlayer = await player();
    const offPagePrevented = await page.evaluate(() => {
      const events = [' ', 'm', 'Delete', 'ArrowRight', ']'].map(key => new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : '', bubbles: true, cancelable: true }));
      for (const event of events) document.body.dispatchEvent(event);
      return events.map(event => event.defaultPrevented);
    });
    assert.deepEqual(offPagePrevented, [false, false, false, false, false]);
    assert.deepEqual(await source(), offPage);
    assert.equal((await player()).muted, offPagePlayer.muted);
    assert.equal((await player()).playing, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ media: process.env.REVIEW_MEDIA_PATH ? 'existing-recording' : 'synthetic', fixtureBytes: await page.evaluate(() => playbackFixtureBytes), singleRowWaveAndMarkers: { height: sharedBox.height, waveformHeight: waveBox.height, markerHeight: markerBox.height }, volumeAndMute: 'passed', sessionVolume: 'passed', nativeGainWhilePlaying: { volume: nativeGainVolume, muted: nativeGainMuted, restored: nativeGainRestored }, activePlaybackArrow: 'passed', rangeShortcutAndButton: 'passed', rangeEnd: 3.1, globalFocusAndScroll: 'passed', editableAndPageGuards: 'passed', candidateAndTrimShortcuts: 'passed', fullAndZoomWaveSeeking: 'passed', immutableWaveEvidence: 'passed', responsiveWidths: [1440, 768, 390], pageErrors: errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
