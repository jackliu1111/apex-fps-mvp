import type { DamageWindow, Reading } from '../shared';

export function keyframeWindows(readings: Reading[], duration: number): DamageWindow[] {
  // Boundary placeholders describe unobserved coverage, never actual readings.
  const endpoints = [...readings];
  if (!endpoints.length || endpoints[0].time > 0) endpoints.unshift({ time: 0, value: null });
  if (endpoints.at(-1)!.time < duration) endpoints.push({ time: duration, value: null });
  return endpoints.slice(1).map((right, i) => {
    const left = endpoints[i];
    const delta = left.value === null || right.value === null ? null : right.value - left.value;
    const reason = delta === null ? 'unknown' : delta > 0 ? 'increase' : delta === 0 ? 'equal' : 'decrease';
    return { start: left.time, end: right.time, start_value: left.value, end_value: right.value,
      net_increase: delta, highlighted: reason === 'increase', source: 'keyframes', reason };
  });
}
