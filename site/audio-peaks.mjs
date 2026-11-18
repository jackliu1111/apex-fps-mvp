import { buildLevelDescriptors, propagatePyramidRange, visitPyramidRange } from './pyramid-cache.mjs';

// Compact source-time evidence; never retain PCM or re-read media for display.
const maxPeak = (a, b) => (a === null ? b : b === null ? a : a > b ? a : b);

export function createAudioPeaks(duration, trackIndex = 0) {
  const step = Math.max(0.05, duration / 72000);
  const length = Math.ceil(duration / step);
  const peaks = new Array(length).fill(null);
  const descriptors = buildLevelDescriptors(length, step);
  const levels = descriptors.map((desc) => ({ ...desc, peaks: new Array(desc.length).fill(null) }));
  return { version: 1, step, peaks, pyramid: { factor: 2, levels }, decodedUntil: 0, trackIndex };
}

function updateAudioPeakPyramid(wave, firstBucket, lastBucket) {
  const levels = wave.pyramid?.levels;
  if (!levels?.length || !(lastBucket > firstBucket)) return;
  propagatePyramidRange(levels.length, firstBucket, lastBucket, (idx, start, end) => {
    const prev = idx === 0 ? wave.peaks : levels[idx - 1].peaks;
    const curr = levels[idx].peaks;
    const limit = Math.min(curr.length, end);
    for (let i = start; i < limit; i++) {
      const a = prev[i * 2];
      const b = i * 2 + 1 < prev.length ? prev[i * 2 + 1] : null;
      curr[i] = maxPeak(a, b);
    }
  });
}

export function appendAudioPeaks(wave, { buffer, timestamp }, origin, duration) {
  const start = timestamp - origin;
  const sampleRate = buffer.sampleRate;
  const bufferEnd = start + buffer.duration;

  // 计算此 buffer 覆盖的桶范围，避免遍历所有桶
  const firstBucket = Math.max(0, Math.floor(Math.max(0, start) / wave.step + 1e-8));
  const lastBucket = Math.min(wave.peaks.length - 1, Math.floor(Math.min(duration, bufferEnd) / wave.step - 1e-8 + 1));

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    // 逐桶扫描：每个桶只在自己的采样范围内找最大值，避免逐样本计算桶索引
    for (let bucket = firstBucket; bucket < lastBucket; bucket++) {
      const sampleStart = Math.max(0, Math.round((bucket * wave.step - start) * sampleRate));
      const sampleEnd = Math.min(samples.length, Math.round(((bucket + 1) * wave.step - start) * sampleRate));
      let max = wave.peaks[bucket] ?? 0;
      for (let i = sampleStart; i < sampleEnd; i++) {
        const v = Math.abs(samples[i]);
        if (v > max) max = v;
      }
      wave.peaks[bucket] = Math.min(1, max);
    }
  }
  updateAudioPeakPyramid(wave, firstBucket, lastBucket);
  wave.decodedUntil = Math.max(wave.decodedUntil, Math.min(duration, Math.max(0, bufferEnd)));
}

function queryPeakRange(wave, low, high) {
  const levels = wave.pyramid?.levels;
  let acc = null;
  visitPyramidRange(levels?.length || 0, low, high, (lvlIdx, index) => {
    const v = (lvlIdx < 0 ? wave.peaks : levels[lvlIdx].peaks)[index];
    if (v !== null && (acc === null || v > acc)) acc = v;
  });
  return acc;
}

export function waveformColumns(wave, start, end, width) {
  const columns = new Array(Math.max(0, width)).fill(null);
  if (!wave || !(end > start) || !(width > 0)) return columns;
  const span = end - start;
  for (let x = 0; x < width; x++) {
    const colStart = start + (x / width) * span;
    const colEnd = start + ((x + 1) / width) * span;
    const low = Math.max(0, Math.floor(colStart / wave.step + 1e-9));
    const high = Math.min(wave.peaks.length, Math.ceil(colEnd / wave.step - 1e-9));
    if (high > low) columns[x] = queryPeakRange(wave, low, high);
  }
  return columns;
}
