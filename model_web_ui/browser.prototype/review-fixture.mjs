// Saved 60-second combat audio evidence; candidate ranges are design fixtures.
export async function loadReviewFixture() {
  const response = await fetch('./selection-design/media/waveform.json');
  if (!response.ok) throw new Error('无法加载真实样本波形');
  const data = await response.json();
  return {
    duration: data.duration,
    frames: Array.from({ length: 12 }, (_, index) => ({ time: index * 5, image: `./selection-design/media/frame-${index * 5}.jpg` })),
    waveform: { version: 1, step: data.binSeconds, peaks: data.peaks, decodedUntil: data.duration, trackIndex: 0 },
    candidates: [[4, 8], [18.2, 20.1], [20.5, 22.4], [23, 24.6], [36, 42], [51, 56.5]].map(([start, end], i) => ({ id: `sample-${i}`, start, end })),
  };
}
