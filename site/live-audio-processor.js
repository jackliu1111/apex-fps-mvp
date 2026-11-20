// AudioWorkletProcessor: mono mixdown + linear resample to 32 kHz + 20 ms envelope + 10 s sliding window.
// Runs in the audio rendering thread so background tabs never stall inference scheduling.
class LiveAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.targetRate = opts.targetRate || 32000;
    this.windowSamples = this.targetRate * (opts.windowSeconds || 10);
    this.hopSamples = this.targetRate * (opts.hopSeconds || 2);
    this.envSamples = Math.round(this.targetRate * 0.02); // 20 ms -> 640 samples @ 32 kHz
    this.ring = new Float32Array(this.windowSamples);
    this.ringWrite = 0;
    this.totalTargetSamples = 0;
    this.sinceLastHop = 0;
    this.envPeak = 0;
    this.envSqSum = 0;
    this.envCount = 0;
    this.envBatch = [];
    this.silentBuckets = 0;
    this.resamplePos = 0;
    this.prevSample = 0;
    this.paused = false;

    this.port.onmessage = ({ data }) => {
      if (data?.type === 'pause') this.paused = !!data.value;
      else if (data?.type === 'reset') {
        this.ring.fill(0);
        this.ringWrite = 0;
        this.totalTargetSamples = 0;
        this.sinceLastHop = 0;
        this.envPeak = 0;
        this.envSqSum = 0;
        this.envCount = 0;
        this.envBatch = [];
        this.silentBuckets = 0;
      }
    };
  }

  emitEnvelope(peak, rms) {
    this.envBatch.push(peak, rms);
    if (peak < 1e-5) this.silentBuckets++;
    else this.silentBuckets = 0;
    // Flush every 5 buckets (~100 ms) to keep MessagePort traffic light while keeping waveform smooth.
    if (this.envBatch.length >= 10) {
      const payload = new Float32Array(this.envBatch);
      this.envBatch = [];
      this.port.postMessage({
        type: 'envelope',
        buckets: payload,
        silentSeconds: this.silentBuckets * 0.02,
      }, [payload.buffer]);
    }
  }

  emitWindow() {
    const out = new Float32Array(this.windowSamples);
    const tailLen = this.windowSamples - this.ringWrite;
    out.set(this.ring.subarray(this.ringWrite), 0);
    out.set(this.ring.subarray(0, this.ringWrite), tailLen);
    this.port.postMessage({
      type: 'window',
      waveform: out,
      coveredSeconds: Math.min(this.windowSamples, this.totalTargetSamples) / this.targetRate,
    }, [out.buffer]);
  }

  pushTargetSample(sample) {
    this.ring[this.ringWrite] = sample;
    this.ringWrite = (this.ringWrite + 1) % this.windowSamples;
    this.totalTargetSamples++;
    this.sinceLastHop++;

    const abs = Math.abs(sample);
    if (abs > this.envPeak) this.envPeak = abs;
    this.envSqSum += sample * sample;
    this.envCount++;
    if (this.envCount >= this.envSamples) {
      const rms = Math.sqrt(this.envSqSum / this.envCount);
      this.emitEnvelope(Math.min(1, this.envPeak), Math.min(1, rms));
      this.envPeak = 0;
      this.envSqSum = 0;
      this.envCount = 0;
    }

    if (this.sinceLastHop >= this.hopSamples && this.totalTargetSamples >= this.hopSamples) {
      this.sinceLastHop = 0;
      this.emitWindow();
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || this.paused) return true;
    const channels = input.length;
    const length = input[0].length;
    const step = sampleRate / this.targetRate;

    // Mix down to mono first.
    let pos = this.resamplePos;
    while (pos < length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      let s0 = 0;
      let s1 = 0;
      for (let ch = 0; ch < channels; ch++) {
        const buf = input[ch];
        s0 += idx >= 0 ? buf[idx] : this.prevSample;
        s1 += idx + 1 < length ? buf[idx + 1] : buf[length - 1];
      }
      s0 /= channels;
      s1 /= channels;
      this.pushTargetSample(s0 + (s1 - s0) * frac);
      pos += step;
    }

    let lastMono = 0;
    for (let ch = 0; ch < channels; ch++) lastMono += input[ch][length - 1];
    this.prevSample = lastMono / channels;
    this.resamplePos = pos - length;
    return true;
  }
}

registerProcessor('live-audio-processor', LiveAudioProcessor);
