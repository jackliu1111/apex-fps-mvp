export function displayWeights(scores, threshold, temperature = 1) {
  if (!(temperature > 0) || !(threshold >= 0 && threshold <= 1)) throw new Error('Invalid display parameters');
  const selected = Array.from(scores, (score, id) => ({ id, score })).filter(x => x.score >= threshold);
  const maximum = Math.max(...selected.map(x => x.score));
  const total = selected.reduce((n, x) => n + Math.exp((x.score - maximum) / temperature), 0);
  return selected.map(x => ({ ...x, weight: Math.exp((x.score - maximum) / temperature) / total }));
}

// 10s / 5s overlap: emit only frames no future window can change.
export class FrameOverlap {
  constructor(classes, totalFrames, windowFrames = 250, hopFrames = 125) {
    Object.assign(this, { classes, totalFrames, windowFrames, hopFrames, cursor: 0, pending: null });
    if (windowFrames !== 2 * hopFrames) throw new Error('Lab currently requires 50% window overlap');
  }
  push(values, last) {
    const { classes: c, hopFrames: h, windowFrames: w } = this;
    if (values.length !== w * c || values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('Invalid probability tensor');
    const count = Math.min(last ? w : h, this.totalFrames - this.cursor);
    const result = values.slice(0, count * c);
    if (this.pending) for (let i = 0; i < Math.min(count, h) * c; i++) result[i] = (result[i] + this.pending[i]) / 2;
    const block = { startFrame: this.cursor, frameCount: count, values: result };
    this.cursor += count;
    this.pending = last ? null : values.slice(h * c);
    return block;
  }
}

export class ScoreStatistics {
  constructor(classes, threshold, frameSeconds, duration) {
    Object.assign(this, { classes, threshold, frameSeconds, duration, frames: 0, seconds: 0 });
    this.rows = classes.map((name, id) => ({ id, name, coveredSeconds: 0, segments: 0, sumSeconds: 0, peak: 0, peakTime: 0, histogramSeconds: Array(10).fill(0) }));
    this.active = new Uint8Array(classes.length);
    this.pairs = new Map();
  }
  add(block) {
    const c = this.classes.length;
    if (block.startFrame !== this.frames) throw new Error('Non-contiguous score blocks');
    for (let f = 0; f < block.frameCount; f++) {
      const time = (block.startFrame + f) * this.frameSeconds;
      const dt = Math.max(0, Math.min(this.frameSeconds, this.duration - time));
      const hit = [];
      for (let id = 0; id < c; id++) {
        const p = block.values[f * c + id], row = this.rows[id];
        row.sumSeconds += p * dt;
        row.histogramSeconds[Math.min(9, Math.floor(p * 10))] += dt;
        if (p > row.peak) { row.peak = p; row.peakTime = time; }
        const yes = p >= this.threshold;
        if (yes) { row.coveredSeconds += dt; if (!this.active[id]) row.segments++; hit.push(id); }
        this.active[id] = Number(yes);
      }
      for (let i = 0; i < hit.length; i++) for (let j = i + 1; j < hit.length; j++) {
        const key = hit[i] * c + hit[j];
        this.pairs.set(key, (this.pairs.get(key) || 0) + dt);
      }
      this.seconds += dt;
    }
    this.frames += block.frameCount;
  }
  report() {
    return {
      threshold: this.threshold, frameSeconds: this.frameSeconds, frames: this.frames, analyzedSeconds: this.seconds,
      meaning: 'Model predictions, not verified sound frequency or accuracy. No smoothing; contiguous above-threshold frames form segments.',
      rows: this.rows.map(row => ({ ...row, mean: row.sumSeconds / (this.seconds || 1), coverage: row.coveredSeconds / (this.seconds || 1) })).sort((a, b) => b.coveredSeconds - a.coveredSeconds || b.peak - a.peak),
      cooccurrence: [...this.pairs].map(([key, seconds]) => ({ a: Math.floor(key / this.classes.length), b: key % this.classes.length, seconds })).sort((a, b) => b.seconds - a.seconds),
    };
  }
}

export async function writeFile(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(data); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}
export const writeJson = (directory, name, value) => writeFile(directory, name, JSON.stringify(value, null, 2));
