// One decoder iterator, bounded source blocks and reusable five-second mono hops.
// OfflineAudioContext retains browser channel mixing and band-limited resampling.
export function sequentialAudio(MB, track, origin, duration, rate, check, metrics) {
  const iterator = new MB.AudioBufferSink(track).buffers(origin, origin + duration)[Symbol.asyncIterator]();
  const hop = rate * 5, halo = Math.round(rate * 0.04);
  let blocks = [], done = false, closed = false, index = 0, previous;
  metrics.decoderPasses = 1;
  metrics.maxSourceBufferSeconds = 0;
  metrics.maxMonoBufferSamples = 0;
  async function chunk(part) {
    check();
    const begin = part * 5, end = Math.min(begin + 5, duration);
    const output = new Float32Array(hop);
    if (begin >= duration) return output;
    const from = Math.max(0, begin - halo / rate), to = Math.min(duration, end + halo / rate);
    while (!done && (!blocks.length || blocks.at(-1).timestamp + blocks.at(-1).buffer.duration < origin + to)) {
      check();
      const result = await iterator.next();
      check();
      done = result.done;
      if (!done) blocks.push(result.value);
    }
    metrics.maxSourceBufferSeconds = Math.max(metrics.maxSourceBufferSeconds, blocks.reduce((n, b) => n + b.buffer.duration, 0));
    const rendered = await renderContinuous(blocks, origin + from, to - from, rate);
    check();
    const offset = Math.round((begin - from) * rate);
    output.set(rendered.subarray(offset, offset + Math.min(hop, Math.round((end - begin) * rate))));
    blocks = blocks.filter((b) => b.timestamp + b.buffer.duration > origin + end - halo / rate);
    return output;
  }
  return {
    async next() {
      const started = performance.now();
      check();
      if (closed) throw new Error('解码流已关闭');
      if (!previous) previous = await chunk(0);
      const following = await chunk(index + 1);
      const waveform = new Float32Array(hop * 2);
      waveform.set(previous); waveform.set(following, hop);
      previous = following; index++;
      metrics.maxMonoBufferSamples = Math.max(metrics.maxMonoBufferSamples, hop * 4);
      metrics.decodeMs += performance.now() - started;
      return waveform;
    },
    async close() {
      closed = true;
      await iterator.return?.();
      blocks = []; previous = null;
    },
  };
}

// Place decoded packets on their native sample grid before resampling once.
// Separate AudioBufferSource nodes reset interpolation at every packet boundary.
export async function renderContinuous(blocks, start, duration, rate) {
  const first = blocks[0]?.buffer;
  if (!first) throw new Error('音轨未解码出音频');
  const nativeRate = first.sampleRate;
  const channels = first.numberOfChannels;
  const joined = new AudioBuffer({ numberOfChannels: channels, sampleRate: nativeRate, length: Math.ceil(duration * nativeRate) });
  for (const { buffer, timestamp } of blocks) {
    if (buffer.sampleRate !== nativeRate || buffer.numberOfChannels !== channels) throw new Error('音轨采样率或声道数在途中改变，当前原型不支持');
    const at = Math.round((timestamp - start) * nativeRate);
    const offset = Math.max(0, -at), target = Math.max(0, at);
    const length = Math.min(buffer.length - offset, joined.length - target);
    if (length <= 0) continue;
    for (let channel = 0; channel < channels; channel++) joined.getChannelData(channel).set(buffer.getChannelData(channel).subarray(offset, offset + length), target);
  }
  const context = new OfflineAudioContext(1, Math.ceil(duration * rate), rate);
  const source = context.createBufferSource(); source.buffer = joined;
  source.connect(context.destination); source.start(0);
  return (await context.startRendering()).getChannelData(0);
}
