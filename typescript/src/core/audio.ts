import {
  type AudioEvent,
  type AudioOptions,
  type Clip,
  type CurvePoint,
  round,
} from "../shared";

export function detectAudioEvents(
  rms: number[],
  o: AudioOptions,
): { threshold: number; events: AudioEvent[] } {
  if (!rms.length || rms.some((v) => !Number.isFinite(v)))
    throw new Error("没有有效音频采样");
  const sorted = [...rms].sort((a, b) => a - b),
    p = ((sorted.length - 1) * o.threshold_percentile) / 100;
  const threshold =
    sorted[Math.floor(p)] +
    (sorted[Math.ceil(p)] - sorted[Math.floor(p)]) * (p % 1);
  const events: AudioEvent[] = [];
  let first = -1,
    last = -1,
    count = 0,
    peak = -Infinity;
  const flush = () => {
    if (first >= 0)
      events.push({
        start: round((first * o.frame_ms) / 1000),
        end: round(((last + 1) * o.frame_ms) / 1000),
        peak_dbfs: round(peak, 3),
        active_frames: count,
      });
  };
  const bridge = Math.floor(o.event_bridge_ms / o.frame_ms);
  rms.forEach((value, index) => {
    if (value <= threshold) return;
    if (first < 0 || index - last - 1 > bridge) {
      flush();
      first = index;
      count = 0;
      peak = -Infinity;
    }
    last = index;
    count++;
    peak = Math.max(peak, value);
  });
  flush();
  return { threshold, events };
}

export function audioClips(
  events: AudioEvent[],
  duration: number,
  o: AudioOptions,
): Clip[] {
  const groups: AudioEvent[][] = [];
  for (const e of events) {
    const g = groups.at(-1);
    if (g && e.start - g.at(-1)!.end <= o.fight_gap_s) g.push(e);
    else groups.push([e]);
  }
  const clips: Clip[] = [];
  for (const g of groups) {
    if (g.length < o.min_events) continue;
    const c: Clip = {
      start: Math.max(0, g[0].start - o.before_s),
      end: Math.min(duration, g.at(-1)!.end + o.after_s),
      raw_start: g[0].start,
      raw_end: g.at(-1)!.end,
      event_count: g.length,
      peak_dbfs: Math.max(...g.map((e) => e.peak_dbfs)),
    };
    if (c.end <= c.start) continue;
    const previous = clips.at(-1);
    if (previous && c.start <= previous.end) {
      previous.end = Math.max(previous.end, c.end);
      previous.raw_end = Math.max(previous.raw_end, c.raw_end);
      previous.event_count += c.event_count;
      previous.peak_dbfs = Math.max(previous.peak_dbfs, c.peak_dbfs);
    } else clips.push(c);
  }
  return clips.map((c) => ({
    ...c,
    start: round(c.start, 3),
    end: round(c.end, 3),
    raw_start: round(c.raw_start, 3),
    raw_end: round(c.raw_end, 3),
    peak_dbfs: round(c.peak_dbfs, 3),
    exceeds_max_duration: round(c.end, 3) - round(c.start, 3) > o.max_clip_s,
  }));
}

export class RMSAccumulator {
  private samples = 0;
  private sum = 0;
  values: number[] = [];
  constructor(private frameSamples = 400) {}
  push(data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length % 4) throw new Error("音频字节未对齐");
    for (let i = 0; i < data.length; i += 4) {
      const value = view.getFloat32(i, true);
      if (!Number.isFinite(value)) throw new Error("音频采样非有限值");
      this.sum += value * value;
      this.samples++;
      if (this.samples === this.frameSamples) {
        this.values.push(
          Math.fround(
            20 *
              Math.log10(Math.max(Math.sqrt(this.sum / this.samples), 1e-12)),
          ),
        );
        this.samples = 0;
        this.sum = 0;
      }
    }
  }
}

export function audioCurve(
  values: number[],
  frameMS: number,
  limit = 1600,
): CurvePoint[] {
  const stride = Math.max(1, Math.ceil(values.length / limit)),
    curve: CurvePoint[] = [];
  for (let i = 0; i < values.length; i += stride) {
    let min = Infinity,
      max = -Infinity;
    for (let j = i; j < Math.min(i + stride, values.length); j++) {
      min = Math.min(min, values[j]);
      max = Math.max(max, values[j]);
    }
    curve.push({ time: round((i * frameMS) / 1000), min, max });
  }
  return curve;
}
