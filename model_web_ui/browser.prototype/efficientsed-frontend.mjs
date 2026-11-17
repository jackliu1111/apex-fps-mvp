// Official eval frontend: 16 kHz, preemphasis, reflect-centered 512 FFT,
// nonperiodic 400 Hann, Kaldi mel, log(clamp(power,1e-7)), (x+4.5)/5.
export function createSedFrontend(c) {
  const size = c.fftSize, bins = size / 2 + 1, frames = c.frames;
  const reverse = new Uint16Array(size);
  for (let i = 0; i < size; i++) {
    let n = i, r = 0;
    for (let j = 0; j < Math.log2(size); j++) { r = (r << 1) | (n & 1); n >>= 1; }
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < cos.length; i++) { cos[i] = Math.cos(-2 * Math.PI * i / size); sin[i] = Math.sin(-2 * Math.PI * i / size); }
  const bands = c.mel.map(row => row.flatMap((weight, bin) => weight ? [[bin, weight]] : []));
  return waveform => {
    if (waveform.length !== c.samples) throw new Error('EfficientSED requires 160000 samples');
    const emphasized = new Float32Array(waveform.length - 1);
    for (let i = 0; i < emphasized.length; i++) emphasized[i] = waveform[i + 1] - Math.fround(.97) * waveform[i];
    const real = new Float64Array(size), imag = new Float64Array(size), power = new Float32Array(bins);
    const result = new Float32Array(bands.length * frames);
    for (let frame = 0; frame < frames; frame++) {
      for (let i = 0; i < size; i++) {
        let index = frame * c.hop + i - size / 2;
        if (index < 0) index = -index;
        if (index >= emphasized.length) index = 2 * emphasized.length - index - 2;
        real[reverse[i]] = Math.fround(emphasized[index] * c.window[i]); imag[i] = 0;
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
        result[band * frames + frame] = (Math.log(Math.max(sum, c.logFloor)) + 4.5) / 5;
      }
    }
    return result;
  };
}
