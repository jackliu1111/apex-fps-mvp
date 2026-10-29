// Compact source-time evidence; never retain PCM or re-read media for display.
export function createAudioPeaks(duration, trackIndex = 0) {
  const step = Math.max(0.05, duration / 72000);
  const peaks = new Array(Math.ceil(duration / step)).fill(null);
  return { version: 1, step, peaks, decodedUntil: 0, trackIndex };
}

export function appendAudioPeaks(wave, { buffer, timestamp }, origin, duration) {
  const start = timestamp - origin;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      const time = start + i / buffer.sampleRate;
      if (time < 0 || time >= duration) continue;
      const bucket = Math.floor(time / wave.step + 1e-8);
      wave.peaks[bucket] = Math.max(wave.peaks[bucket] ?? 0, Math.min(1, Math.abs(samples[i])));
    }
  }
  wave.decodedUntil = Math.max(wave.decodedUntil, Math.min(duration, Math.max(0, start + buffer.duration)));
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
