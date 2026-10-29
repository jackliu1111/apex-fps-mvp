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
