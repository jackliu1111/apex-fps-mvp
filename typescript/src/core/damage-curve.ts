import type { Analysis } from '../shared';
export interface DamageSegment { start: number; end: number; from: number; to: number; estimated: boolean }
// Pure geometry shared by the UI and deterministic compatibility tests.
export function damageSegments(a: Analysis): DamageSegment[] {
  const result: DamageSegment[] = [];
  const add = (start: number, end: number, from: number, to: number, estimated = false) => {
    if (end >= start) result.push({ start, end, from, to, estimated });
  };
  if (a.damage_strategy === 'keyframes-v1') {
    for (const w of a.damageWindows ?? []) {
      if (w.start_value !== null && w.end_value !== null && w.end_value >= w.start_value)
        add(w.start, w.end, w.start_value, w.end_value, true);
    }
    // Actual observations are points; never hold them across a missing value,
    // reset, or unobserved tail. The UI renders these points independently.
    for (const r of a.readings) if (r.value !== null) add(r.time, r.time, r.value, r.value);
    return result;
  }
  if (a.damage_strategy !== 'interval-v1') {
    a.readings.forEach((r, i) => {
      const next = a.readings[i + 1];
      if (r.value === null) return;
      add(r.time, next?.time ?? a.media.duration, r.value, r.value);
      if (next && next.value !== null) add(next.time, next.time, r.value, next.value);
    });
    return result;
  }
  // Exclude the padding used to confirm dense boundary observations as well.
  const padding = Math.max(.2, 2 / a.media.fps);
  const denseRanges = (a.damageWindows ?? []).filter(w => w.source === 'dense')
    .map(w => ({ start: Math.max(0, w.start - padding), end: Math.min(a.media.duration, w.end + padding) }));
  for (const w of a.damageWindows ?? []) {
    if (w.source !== 'endpoints' || w.start_value === null || w.end_value === null) continue;
    let parts = [{ start: w.start, end: w.end }];
    for (const d of denseRanges) parts = parts.flatMap(p => d.end <= p.start || d.start >= p.end ? [p] :
      [{ start: p.start, end: Math.min(p.end, d.start) }, { start: Math.max(p.start, d.end), end: p.end }].filter(p => p.end > p.start));
    const value = (t: number) => w.start_value! + (w.end_value! - w.start_value!) * (t - w.start) / (w.end - w.start);
    for (const p of parts) add(p.start, p.end, value(p.start), value(p.end), true);
  }
  const dense = a.readings.filter(r => r.source === 'dense');
  for (let i = 0; i < dense.length; i++) {
    const r = dense[i], next = dense[i + 1];
    if (r.value === null) continue;
    // Never hold a known reading through a missing frame, a reset, or a gap.
    if (!next || next.value === null || next.value < r.value || next.time - r.time > Math.max(.25, 2 / a.media.fps)) {
      add(r.time, r.time, r.value, r.value); continue;
    }
    add(r.time, next.time, r.value, r.value);
    if (next.value !== r.value) add(next.time, next.time, r.value, next.value);
  }
  return result;
}
