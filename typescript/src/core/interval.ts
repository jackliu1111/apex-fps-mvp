import { type Clip, type DamageOptions, type DamageProbe, type DamageWindow, type DamageEvent, round } from '../shared';

export const PROBE_INTERVAL = 5;
export const DENSE_FPS = 10;
export const MIN_HIGHLIGHT_SECONDS = 5;
export function probeTimes(duration: number): number[] {
  const times: number[] = [];
  for (let t = 0; t < duration; t += PROBE_INTERVAL) times.push(t);
  times.push(duration);
  return times;
}
export function classifyWindows(probes: DamageProbe[]): DamageWindow[] {
  return probes.slice(1).map((right, i) => {
    const left = probes[i];
    const delta = left.value === null || right.value === null ? null : right.value - left.value;
    const reason = delta === null ? 'unknown' : delta > 0 ? 'increase' : delta === 0 ? 'equal' : 'decrease';
    return { start: left.time, end: right.time, start_value: left.value, end_value: right.value,
      net_increase: delta, highlighted: reason === 'increase',
      source: reason === 'unknown' || reason === 'decrease' ? 'dense' : 'endpoints', reason };
  });
}
export function anomalyRanges(windows: DamageWindow[]) {
  const ranges: { start: number; end: number }[] = [];
  for (const w of windows) {
    if (w.source !== 'dense') continue;
    const last = ranges.at(-1);
    if (last && Math.abs(last.end - w.start) < 1e-6) last.end = w.end;
    else ranges.push({ start: w.start, end: w.end });
  }
  return ranges;
}
// Half-open windows: a rise exactly at 5 seconds belongs to [5, 10).
// Confirmation may arrive after a boundary; ownership uses its first frame.
export function assignGrowth(windows: DamageWindow[], event: DamageEvent) {
  const w = windows.find(w => event.time >= w.start - 1e-6 && event.time < w.end - 1e-6);
  if (!w || w.source !== 'dense') return false;
  w.highlighted = true;
  w.confirmed_increase = (w.confirmed_increase ?? 0) + event.increase;
  return true;
}
export function windowClips(windows: DamageWindow[], duration: number, o: DamageOptions): Clip[] {
  const groups: Clip[] = [];
  for (const w of windows.filter(w => w.highlighted)) {
    const end = Math.min(duration, Math.max(w.end, MIN_HIGHLIGHT_SECONDS));
    const start = Math.max(0, Math.min(w.start, end - MIN_HIGHLIGHT_SECONDS));
    const last = groups.at(-1);
    if (last && start - last.raw_end <= o.gap_s + 1e-6) {
      last.raw_end = Math.max(last.raw_end, end); last.window_count!++;
    } else groups.push({ start, end, raw_start: start, raw_end: end, event_count: 0, window_count: 1, peak_dbfs: 0 });
  }
  const clips: Clip[] = [];
  for (const g of groups) {
    g.start = round(Math.max(0, g.raw_start - o.before_s));
    g.end = round(Math.min(duration, g.raw_end + o.after_s));
    const last = clips.at(-1);
    if (last && g.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, g.end); last.raw_end = Math.max(last.raw_end, g.raw_end);
      last.window_count! += g.window_count!;
    } else clips.push(g);
  }
  return clips;
}
