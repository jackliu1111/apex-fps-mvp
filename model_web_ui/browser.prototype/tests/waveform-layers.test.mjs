import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_GROUPS, createDisplayGrouping } from '../lab-display-groups.mjs';
import { createAudioPeaks, appendAudioPeaks } from '../audio-peaks.mjs';
import {
  DEFAULT_DISPLAY_THRESHOLD,
  createGroupScorePyramid,
  updateGroupScorePyramid,
  selectScoreLevel,
  groupScoreColumns,
  layeredWaveColumns,
  overviewDistributionColumns,
  groupScoresAtTime,
} from '../waveform-layers.mjs';

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
}

function hueDegrees([r, g, b]) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

test('display groups define the five fixed groups with speech separated from selection sky-blue and max-per-group reduction', () => {
  assert.deepEqual(DISPLAY_GROUPS.map((g) => g.id), ['gunshot', 'speech', 'music', 'footsteps', 'impact']);
  assert.equal(DISPLAY_GROUPS[0].anchor, 'top');
  for (let i = 1; i < DISPLAY_GROUPS.length; i++) assert.equal(DISPLAY_GROUPS[i].anchor, 'bottom');

  // Speech color must stay well clear of selection sky-blue (#60a5fa / #3b82f6, hue ~215deg) and legacy #568bc8.
  const speechGroup = DISPLAY_GROUPS.find((g) => g.id === 'speech');
  assert.notEqual(speechGroup.color.toLowerCase(), '#568bc8');
  const speechHue = hueDegrees(hexToRgb(speechGroup.color));
  const selectionHue = hueDegrees(hexToRgb('#60a5fa'));
  const hueGap = Math.min(Math.abs(speechHue - selectionHue), 360 - Math.abs(speechHue - selectionHue));
  assert.ok(hueGap >= 60, `Expected speech hue (${speechHue}deg) >= 60deg away from selection sky-blue (${selectionHue}deg)`);

  // Distinct colors across all 5 groups
  assert.equal(new Set(DISPLAY_GROUPS.map((g) => g.color.toLowerCase())).size, 5);

  const classes = ['Other', 'Speech', 'Whispering', 'Gunshot, gunfire', 'Machine gun', 'Music', 'Run', 'Breaking'];
  const group = createDisplayGrouping(classes);
  const frame = new Float32Array([0.99, 0.15, 0.72, 0.4, 0.85, 0.3, 0.61, 0.25]);
  const out = group(frame);
  assert.ok(out instanceof Float32Array);
  assert.equal(out.length, 5);
  assert.ok(Math.abs(out[0] - 0.85) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.72) < 1e-6);
  assert.ok(Math.abs(out[2] - 0.30) < 1e-6);
  assert.ok(Math.abs(out[3] - 0.61) < 1e-6);
  assert.ok(Math.abs(out[4] - 0.25) < 1e-6);

  // Supports zero-allocation writing into a preallocated session buffer at frame offset.
  const target = new Float32Array(10);
  const returned = group(frame, target, 5);
  assert.equal(returned, target);
  assert.deepEqual([...target.subarray(0, 5)], [0, 0, 0, 0, 0]);
  assert.deepEqual([...target.subarray(5, 10)], [...out]);
});

test('groupScoreColumns aligns negative and positive audioOffset and preserves per-column peak scores', () => {
  const frameSeconds = 0.04;
  const frames = 250; // 10s audio
  const scores = new Float32Array(frames * 5);
  // Frame 10 (audio [0.40, 0.44)): gunshot spike 0.92; Frame 11..49 remain 0 -> must not dilute or overwrite.
  scores[10 * 5 + 0] = 0.92;
  // Frame 60 (audio [2.40, 2.44)): speech 0.70
  scores[60 * 5 + 1] = 0.70;

  // Negative audioOffset = -1.5s: audio [0..1.48) is before video t=0 and must clip; audio 2.40s -> video 0.90s.
  const negCols = groupScoreColumns({
    groupScores: scores,
    groupScoreFrames: frames,
    frameSeconds,
    audioOffset: -1.5,
    audioDuration: 10,
  }, 0, 2, 20); // 0.1s per column
  assert.equal(negCols.length, 20);
  assert.equal(negCols[0][0], 0); // frame 10 (video -1.10..-1.06s) clipped before t=0
  assert.ok(Math.abs(negCols[9][1] - 0.70) < 1e-6); // video [0.90, 1.00) includes frame 60 (audio 2.40s)

  // Positive audioOffset = +2.0s: video [0, 2.0) has no audio; frame 10 (audio 0.40s) shifts to video 2.40s.
  const posCols = groupScoreColumns({
    groupScores: scores,
    groupScoreFrames: frames,
    frameSeconds,
    audioOffset: 2.0,
    audioDuration: 10,
  }, 0, 5, 10); // 0.5s per column
  assert.equal(posCols[0], null);
  assert.equal(posCols[3], null); // [1.5, 2.0) before audioOffset
  assert.ok(Math.abs(posCols[4][0] - 0.92) < 1e-6); // [2.0, 2.5) contains frame 10 at 2.40s despite 11 frames of 0 after it
});

test('layeredWaveColumns computes sqrt(peak) contour, 3 visual states, top-down gunshot foreground, and non-softmax independence', () => {
  const wave = createAudioPeaks(10, 0);
  // Decode only [0, 5) seconds: col 0..4 analyzed, col 5..9 unanalyzed (null)
  appendAudioPeaks(wave, {
    timestamp: 0,
    buffer: { numberOfChannels: 1, sampleRate: 10, duration: 5, getChannelData: () => new Float32Array(50).fill(0.25) },
  }, 0, 10);

  const scores = new Float32Array(125 * 5); // 5s analyzed frames
  // [0, 1) -> below threshold (neutral)
  scores[0 * 5 + 0] = DEFAULT_DISPLAY_THRESHOLD - 0.05;
  scores[0 * 5 + 1] = 0.08;
  // [2, 3) (frames 50..74) -> gunshot 0.60 + speech 0.80 + footsteps 0.50
  scores[55 * 5 + 0] = 0.60;
  scores[55 * 5 + 1] = 0.80;
  scores[55 * 5 + 3] = 0.50;

  const base = { wave, start: 0, end: 10, width: 10, canvasHeight: 68, pad: 8, minBar: 1 };
  const cols = layeredWaveColumns({
    ...base,
    scoreData: { groupScores: scores, groupScoreFrames: 125, frameSeconds: 0.04, audioOffset: 0, audioDuration: 10 },
  });

  // State 1: unanalyzed region
  assert.equal(cols[7].state, 'unanalyzed');
  assert.equal(cols[7].waveHeight, 0);
  assert.deepEqual(cols[7].layers, []);

  // State 2: analyzed below display threshold -> opaque neutral sqrt(0.25) * 60 = 30px
  assert.equal(cols[0].state, 'neutral');
  assert.equal(cols[0].waveHeight, 30);
  assert.equal(cols[0].waveTop, 38);
  assert.deepEqual(cols[0].layers, []);

  // State 3: active overlays stay inside [waveTop, canvasHeight], gunshot is last & top-down, others bottom-up
  const active = cols[2];
  assert.equal(active.state, 'active');
  assert.equal(active.waveHeight, 30);
  assert.equal(active.waveTop, 38);
  assert.deepEqual(active.layers.map((l) => l.id), ['speech', 'footsteps', 'gunshot']);
  const [speech, footsteps, gunshot] = active.layers;
  assert.equal(speech.anchor, 'bottom');
  assert.equal(speech.height, 24); // round(0.80 * 30)
  assert.equal(speech.y, 68 - 24);
  assert.equal(footsteps.anchor, 'bottom');
  assert.equal(footsteps.height, 15); // round(0.50 * 30)
  assert.equal(footsteps.y, 68 - 15);
  assert.equal(gunshot.anchor, 'top');
  assert.equal(gunshot.height, 18); // round(0.60 * 30)
  assert.equal(gunshot.y, active.waveTop);

  // Non-softmax independence: changing speech & footsteps or disabling speech never alters gunshot or footsteps height
  const mutedScores = scores.slice();
  mutedScores[55 * 5 + 1] = 0; // drop speech to 0
  mutedScores[55 * 5 + 2] = 0.95; // add loud music
  const mutedCols = layeredWaveColumns({
    ...base,
    scoreData: { groupScores: mutedScores, groupScoreFrames: 125, frameSeconds: 0.04, audioOffset: 0, audioDuration: 10 },
  });
  const gunshotAfter = mutedCols[2].layers.find((l) => l.id === 'gunshot');
  const footstepsAfter = mutedCols[2].layers.find((l) => l.id === 'footsteps');
  assert.equal(gunshotAfter.height, gunshot.height);
  assert.equal(footstepsAfter.height, footsteps.height);

  // Toggling speech off leaves gunshot and footsteps heights identical
  const filteredCols = layeredWaveColumns({
    ...base,
    enabledGroups: new Set(['gunshot', 'footsteps']),
    scoreData: { groupScores: scores, groupScoreFrames: 125, frameSeconds: 0.04, audioOffset: 0, audioDuration: 10 },
  });
  assert.deepEqual(filteredCols[2].layers.map((l) => [l.id, l.height]), [['footsteps', 15], ['gunshot', 18]]);

  // Missing scoreData (reviewPreview or EfficientAT) falls back gracefully to neutral contour
  const previewCols = layeredWaveColumns({ ...base, scoreData: null });
  assert.equal(previewCols[2].state, 'neutral');
  assert.equal(previewCols[2].waveHeight, 30);
  assert.deepEqual(previewCols[2].layers, []);
});

test('group score pyramid updates incrementally over 45-min audio, preserves 0.16s gunshot without dilution/overwrite, switches zoom levels, and stays O(width log N)', () => {
  const duration = 2700; // 45 minutes
  const frameSeconds = 0.04;
  const totalFrames = Math.ceil(duration / frameSeconds); // 67,500
  const groupCount = 5;
  const groupScores = new Float32Array(totalFrames * groupCount);
  const pyramid = createGroupScorePyramid(groupScores, totalFrames, groupCount, frameSeconds);

  // Brief 0.16s gunshot burst (4 frames at 1200.00..1200.16s) followed by zeros in same column
  const burstStart = 1200 / frameSeconds; // 30,000
  for (let f = burstStart; f < burstStart + 4; f++) {
    groupScores[f * groupCount + 0] = 0.88;
  }
  // Brief speech burst at 600.00..600.08s
  const speechStart = 600 / frameSeconds; // 15,000
  groupScores[speechStart * groupCount + 1] = 0.76;

  // Incremental updates in 5s (125-frame) batches up to 1500s (37,500 frames), leaving [1500, 2700) unanalyzed
  const analyzedFrames = 1500 / frameSeconds;
  for (let start = 0; start < analyzedFrames; start += 125) {
    updateGroupScorePyramid(pyramid, start, 125);
  }
  assert.equal(pyramid.analyzedFrames, analyzedFrames);

  // Level switching between 40ms frame zoom and full-recording overview
  const detailLevel = selectScoreLevel(pyramid, 0.04);
  const fullLevel = selectScoreLevel(pyramid, 2700 / 1200);
  const overviewLevel = selectScoreLevel(pyramid, 2700 / 200);
  assert.equal(detailLevel.stride, 1);
  assert.equal(detailLevel.step, 0.04);
  assert.ok(fullLevel.stride > 1 && fullLevel.step <= 2.25);
  assert.ok(overviewLevel.stride > fullLevel.stride);

  const scoreData = {
    groupScores,
    groupScoreFrames: analyzedFrames,
    groupScorePyramid: pyramid,
    groupCount,
    frameSeconds,
    audioOffset: 0,
    audioDuration: duration,
  };

  // Full 45-min view (1080 cols -> 2.5s/col): col 480 [1200, 1202.5) preserves 0.88 gunshot; col 240 preserves 0.76 speech
  const fullCols = groupScoreColumns(scoreData, 0, duration, 1080);
  assert.ok(Math.abs(fullCols[480][0] - 0.88) < 1e-6);
  assert.equal(fullCols[479][0], 0);
  assert.equal(fullCols[481][0], 0);
  assert.ok(Math.abs(fullCols[240][1] - 0.76) < 1e-6);
  assert.equal(fullCols[600], null); // unanalyzed tail starts at 1500s

  // Zoomed 40ms frame detail [1199.88, 1200.28) across 10 columns (0.04s/col) matches exact frame layout
  const frameCols = groupScoreColumns(scoreData, 1199.88, 1200.28, 10);
  assert.equal(frameCols[2][0], 0);
  for (let i = 3; i <= 6; i++) assert.ok(Math.abs(frameCols[i][0] - 0.88) < 1e-6);
  assert.equal(frameCols[7][0], 0);

  // Bounded zoom/pan latency across 60 full-recording 1200-column frames
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    groupScoreColumns(scoreData, i * 0.5, duration - (59 - i) * 0.5, 1200);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 250, `Expected 60 45-min pyramid renders < 250ms, took ${elapsedMs.toFixed(1)}ms`);
});

test('overviewDistributionColumns shares video-time coordinates, aligns positive/negative audioOffset, and marks unanalyzed tails', () => {
  const duration = 2700;
  const frameSeconds = 0.04;
  const totalFrames = 10000; // 400s analyzed audio
  const scores = new Float32Array(totalFrames * 5);
  // Gunshot at audio 100.00..100.16s
  const burst = 100 / frameSeconds;
  for (let f = burst; f < burst + 4; f++) scores[f * 5 + 0] = 0.91;
  // Early gunshot at audio 2.00..2.16s (will be clipped when audioOffset = -5s)
  for (let f = 50; f < 54; f++) scores[f * 5 + 0] = 0.95;

  const pyramid = createGroupScorePyramid(scores, totalFrames, 5, frameSeconds);
  updateGroupScorePyramid(pyramid, 0, totalFrames);

  // Positive offset +500s: [0, 500) unanalyzed/before audio, audio 100s -> video 600s, [900, 2700) unanalyzed tail
  const wavePos = createAudioPeaks(duration, 0);
  appendAudioPeaks(wavePos, {
    timestamp: 500,
    buffer: { numberOfChannels: 1, sampleRate: 10, duration: 400, getChannelData: () => new Float32Array(4000).fill(0.04) },
  }, 0, duration);
  const posOverview = overviewDistributionColumns({
    wave: wavePos,
    scoreData: {
      groupScores: scores,
      groupScoreFrames: totalFrames,
      groupScorePyramid: pyramid,
      frameSeconds,
      audioOffset: 500,
      audioDuration: 400,
    },
    duration,
    width: 270, // 10s per col
    canvasHeight: 16,
  });
  assert.equal(posOverview[0].state, 'unanalyzed');
  assert.equal(posOverview[49].state, 'unanalyzed');
  assert.equal(posOverview[50].state, 'active'); // 2s + 500s = 502s in [500, 510)
  assert.equal(posOverview[51].state, 'neutral');
  assert.equal(posOverview[60].state, 'active'); // 100s + 500s = 600s in [600, 610)
  assert.ok(posOverview[60].gunshotHeight >= 10);
  assert.equal(posOverview[90].state, 'unanalyzed'); // tail after 900s

  // Negative offset -5s: audio [0, 5) clipped before video t=0; audio 100s -> video 95s (col 9)
  const negOverview = overviewDistributionColumns({
    wave: null,
    scoreData: {
      groupScores: scores,
      groupScoreFrames: totalFrames,
      groupScorePyramid: pyramid,
      frameSeconds,
      audioOffset: -5,
      audioDuration: 400,
    },
    duration,
    width: 270, // 10s per col
    canvasHeight: 16,
  });
  assert.equal(negOverview[0].state, 'neutral'); // [0, 10) corresponds to audio [5, 15) -> early 2s gunshot clipped!
  assert.equal(negOverview[9].state, 'active'); // [90, 100) contains audio 100s - 5s = 95s
  assert.equal(negOverview[40].state, 'unanalyzed'); // [400, 410) past 395s video limit
});

test('overviewDistributionColumns respects enabledGroups when gunshot is toggled off without altering neutral contour or non-gunshot toggles', () => {
  const duration = 20;
  const frameSeconds = 0.04;
  const totalFrames = 500;
  const scores = new Float32Array(totalFrames * 5);
  // Gunshot at 4.00..4.16s (col 2 in width 10 -> 2s/col), speech at 8.00s
  for (let f = 100; f < 104; f++) scores[f * 5 + 0] = 0.85;
  scores[200 * 5 + 1] = 0.75;

  const wave = createAudioPeaks(duration, 0);
  appendAudioPeaks(wave, {
    timestamp: 0,
    buffer: { numberOfChannels: 1, sampleRate: 10, duration, getChannelData: () => new Float32Array(200).fill(0.25) },
  }, 0, duration);

  const scoreData = { groupScores: scores, groupScoreFrames: totalFrames, frameSeconds, audioOffset: 0, audioDuration: duration };
  const speechDisabled = overviewDistributionColumns({
    wave,
    scoreData,
    duration,
    width: 10,
    canvasHeight: 16,
    enabledGroups: new Set(['gunshot', 'music', 'footsteps', 'impact']),
  });
  assert.equal(speechDisabled[2].state, 'active');
  assert.ok(speechDisabled[2].gunshotHeight > 0);

  const gunshotDisabled = overviewDistributionColumns({
    wave,
    scoreData,
    duration,
    width: 10,
    canvasHeight: 16,
    enabledGroups: new Set(['speech', 'music', 'footsteps', 'impact']),
  });
  assert.equal(gunshotDisabled[2].state, 'neutral');
  assert.equal(gunshotDisabled[2].gunshotHeight, 0);
  assert.equal(gunshotDisabled[2].gunshotY, null);
  assert.equal(gunshotDisabled[2].waveHeight, speechDisabled[2].waveHeight);
});

test('groupScoresAtTime applies audioOffset, returns all 5 raw scores including sub-threshold values, and marks unanalyzed/out-of-range cleanly', () => {
  const frameSeconds = 0.04;
  const analyzedFrames = 125; // [0, 5.0)s of a 10s audio track analyzed
  const scores = new Float32Array(analyzedFrames * 5);
  // Frame 50 -> audio [2.00, 2.04)s
  scores[50 * 5 + 0] = 0.12; // below 0.2 display threshold
  scores[50 * 5 + 1] = 0.74;
  scores[50 * 5 + 2] = 0.03;
  scores[50 * 5 + 3] = 0.19;
  scores[50 * 5 + 4] = 0.00;

  // Missing scoreData -> unanalyzed
  const missing = groupScoresAtTime(null, 2.5);
  assert.equal(missing.status, 'unanalyzed');
  assert.equal(missing.scores, null);

  // Positive offset +2.0s: video [0, 2.0) is before audio; video 4.01s -> audio 2.01s -> frame 50; video 7.5s -> audio 5.5s (unanalyzed tail < audioDuration 10)
  const posScoreData = {
    groupScores: scores,
    groupScoreFrames: analyzedFrames,
    frameSeconds,
    audioOffset: 2.0,
    audioDuration: 10,
  };
  const beforeAudio = groupScoresAtTime(posScoreData, 1.5);
  assert.equal(beforeAudio.status, 'out-of-range');
  assert.equal(beforeAudio.scores, null);

  const hit = groupScoresAtTime(posScoreData, 4.01);
  assert.equal(hit.status, 'ok');
  assert.equal(hit.frameIndex, 50);
  assert.ok(Math.abs(hit.audioTime - 2.01) < 1e-6);
  assert.equal(hit.scores.length, 5);
  assert.ok(Math.abs(hit.scores[0] - 0.12) < 1e-6);
  assert.ok(Math.abs(hit.scores[1] - 0.74) < 1e-6);
  assert.ok(Math.abs(hit.scores[2] - 0.03) < 1e-6);
  assert.ok(Math.abs(hit.scores[3] - 0.19) < 1e-6);
  assert.equal(hit.scores[4], 0);

  const unanalyzedTail = groupScoresAtTime(posScoreData, 7.5);
  assert.equal(unanalyzedTail.status, 'unanalyzed');
  assert.equal(unanalyzedTail.scores, null);

  const pastAudioEnd = groupScoresAtTime(posScoreData, 12.1);
  assert.equal(pastAudioEnd.status, 'out-of-range');
  assert.equal(pastAudioEnd.scores, null);

  // Negative offset -1.0s: video 1.02s -> audio 2.02s -> frame 50
  const negHit = groupScoresAtTime({
    groupScores: scores,
    groupScoreFrames: analyzedFrames,
    frameSeconds,
    audioOffset: -1.0,
    audioDuration: 10,
  }, 1.02);
  assert.equal(negHit.status, 'ok');
  assert.equal(negHit.frameIndex, 50);
  assert.ok(Math.abs(negHit.scores[1] - 0.74) < 1e-6);
});
