// Compact source-time evidence; never retain PCM or re-read media for display.
export function createAudioPeaks(duration, trackIndex = 0) {
  const step = Math.max(0.05, duration / 72000);
  const peaks = new Array(Math.ceil(duration / step)).fill(null);
  return { version: 1, step, peaks, decodedUntil: 0, trackIndex };
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
  wave.decodedUntil = Math.max(wave.decodedUntil, Math.min(duration, Math.max(0, bufferEnd)));
}

export function waveformColumns(wave, start, end, width) {
  const columns = new Array(width).fill(null);
  if (!wave || !(end > start)) return columns;
  for (let x = 0; x < width; x++) {
    const low = Math.max(0, Math.floor((start + x / width * (end - start)) / wave.step));
    const high = Math.min(wave.peaks.length, Math.ceil((start + (x + 1) / width * (end - start)) / wave.step));
    for (let i = low; i < high; i++) if (wave.peaks[i] !== null) columns[x] = Math.max(columns[x] ?? 0, wave.peaks[i]);
  }
  return columns;
}
