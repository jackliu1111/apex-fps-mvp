// Matches pinned EfficientAT AugmentMelSTFT.eval(): 32 kHz, 128 Mel,
// preemphasis, centered reflect-padded 1024 FFT, 800 Hann window, 320 hop.
// Ordinary radix-2 FFT avoids a large dense DFT matrix in the model graph.
export function createFrontend(constants) {
  const size = 1024, bins = 513, frames = 1000;
  const reverse = new Uint16Array(size);
  for (let i = 0; i < size; i++) {
    let n = i, r = 0;
    for (let j = 0; j < 10; j++) { r = (r << 1) | (n & 1); n >>= 1; }
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < cos.length; i++) { cos[i] = Math.cos(-2 * Math.PI * i / size); sin[i] = Math.sin(-2 * Math.PI * i / size); }
  const bands = constants.mel.map((row) => row.flatMap((weight, bin) => weight ? [[bin, weight]] : []));
  return (waveform) => {
    if (waveform.length !== 320000) throw new Error('EfficientAT 需要 10 秒 / 32 kHz 输入');
    const emphasized = new Float32Array(waveform.length - 1);
    for (let i = 0; i < emphasized.length; i++) emphasized[i] = waveform[i + 1] - Math.fround(0.97) * waveform[i];
    const real = new Float64Array(size), imag = new Float64Array(size), power = new Float32Array(bins);
    const result = new Float32Array(128 * frames);
    for (let frame = 0; frame < frames; frame++) {
      for (let i = 0; i < size; i++) {
        let index = frame * 320 + i - 512;
        if (index < 0) index = -index;
        if (index >= emphasized.length) index = 2 * emphasized.length - index - 2;
        real[reverse[i]] = Math.fround(emphasized[index] * constants.window[i]); imag[i] = 0;
      }
      for (let length = 2; length <= size; length *= 2) {
        const half = length / 2, step = size / length;
        for (let base = 0; base < size; base += length) for (let j = 0; j < half; j++) {
          const a = base + j, b = a + half, twiddle = j * step;
          const r = real[b] * cos[twiddle] - imag[b] * sin[twiddle];
          const im = real[b] * sin[twiddle] + imag[b] * cos[twiddle];
          real[b] = real[a] - r; imag[b] = imag[a] - im;
          real[a] += r; imag[a] += im;
        }
      }
      for (let i = 0; i < bins; i++) power[i] = real[i] ** 2 + imag[i] ** 2;
      for (let band = 0; band < bands.length; band++) {
        let sum = 0;
        for (const [bin, weight] of bands[band]) sum += power[bin] * weight;
        result[band * frames + frame] = (Math.log(sum + 0.00001) + 4.5) / 5;
      }
    }
    return result;
  };
}
