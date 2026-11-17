import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_GROUPS, createDisplayGrouping } from '../lab-display-groups.mjs';
import { createAudioPeaks, appendAudioPeaks } from '../audio-peaks.mjs';
import { DEFAULT_DISPLAY_THRESHOLD, groupScoreColumns, layeredWaveColumns } from '../waveform-layers.mjs';

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
