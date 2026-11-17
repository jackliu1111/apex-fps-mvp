import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPeaks, appendAudioPeaks, waveformColumns } from '../audio-peaks.mjs';
const block = (timestamp, channels, sampleRate = 20) => ({ timestamp, buffer: { numberOfChannels: channels.length, sampleRate, duration: channels[0].length / sampleRate, getChannelData: i => channels[i] } });
test('source-time peaks preserve channels, offsets, silence, gaps and progressive coverage beyond one minute', () => {
  const wave = createAudioPeaks(135, 1);
  appendAudioPeaks(wave, block(12, [[0, .2], [-.8, 0]]), 10, 135);
  assert.equal(wave.peaks[0], null);
  assert.equal(wave.peaks[40], .8);
  assert.equal(wave.peaks[41], .2);
  assert.equal(wave.decodedUntil, 2.1);
  appendAudioPeaks(wave, block(80, [[0, 0]]), 10, 135);
  assert.equal(wave.peaks[1400], 0);
  const columns = waveformColumns(wave, 0, 135, 1350);
  assert.ok(columns.some(v => v === .8));
  assert.equal(columns[1000], null);
  assert.equal(wave.trackIndex, 1);
});
test('negative audio offset clips at video origin and memory stays bounded for long recordings', () => {
  const wave = createAudioPeaks(1);
  appendAudioPeaks(wave, block(9.9, [[1, 1, .4, .2, 0]]), 10, 1);
  assert.ok(wave.peaks.every(v => v === null || v <= .4));
  assert.ok(createAudioPeaks(86400).peaks.length <= 72000);
});

test('multi-resolution peak pyramid updates incrementally, preserves brief spikes in 45-min view, keeps unanalyzed tail null, and preserves detail on zoom', () => {
  const duration = 2700; // 45 minutes
  const wave = createAudioPeaks(duration, 0);
  const sampleRate = 25;
  // Populate [0, 1500) with silence, except a 0.16s spike (4 samples @ 25Hz) at t = 1200.00..1200.16s.
  // Leave [1500, 2700) unanalyzed (null).
  const silentHead = new Float32Array(1200 * sampleRate);
  appendAudioPeaks(wave, block(0, [silentHead], sampleRate), 0, duration);
  const spikeAndTail = new Float32Array(300 * sampleRate);
  spikeAndTail[0] = 0.9;
  spikeAndTail[1] = 0.85;
  spikeAndTail[2] = 0.4;
  spikeAndTail[3] = 0.2;
  appendAudioPeaks(wave, block(1200, [spikeAndTail], sampleRate), 0, duration);

  assert.ok(wave.pyramid.levels.length > 0);

  // Full 45-min view preserves the 0.16s spike without dilution and keeps unanalyzed [1500, 2700) strictly null
  const fullCols = waveformColumns(wave, 0, duration, 1080); // 2.5s per col -> col 480 is [1200, 1202.5), col 600 is [1500, 1502.5)
  assert.equal(fullCols[479], 0);
  assert.ok(Math.abs(fullCols[480] - 0.9) < 1e-6);
  assert.equal(fullCols[481], 0);
  assert.equal(fullCols[599], 0);
  assert.equal(fullCols[600], null);
  assert.equal(fullCols[1079], null);

  // Overview width (270 cols -> 10s/col) also preserves the 0.16s spike and boundary
  const overviewCols = waveformColumns(wave, 0, duration, 270);
  assert.ok(Math.abs(overviewCols[120] - 0.9) < 1e-6);
  assert.equal(overviewCols[149], 0);
  assert.equal(overviewCols[150], null);

  // Zooming into [1199.5, 1200.5) at 0.05s detail matches exact peak without smearing
  const detailCols = waveformColumns(wave, 1199.5, 1200.5, 20); // 0.05s per col
  assert.equal(detailCols[9], 0);
  assert.ok(Math.abs(detailCols[10] - 0.9) < 1e-6);
  assert.equal(detailCols[13], 0);

  // Remains structuredClone-safe (no TypedArray crash if frozen in workspace)
  const cloned = structuredClone(wave);
  assert.equal(cloned.peaks.length, wave.peaks.length);
});
