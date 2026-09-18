import { expect, test } from 'bun:test';
import { probeTimes, classifyWindows, anomalyRanges, assignGrowth, windowClips } from '../src/core/interval';
import { CounterTracker } from '../src/core/damage';
import { damageSegments } from '../src/core/damage-curve';
import { analyzeIntervals } from '../src/interval-analysis';
import { audioDefaults, damageDefaults, validateSettings, type Analysis } from '../src/shared';
import type { VideoWindowOptions } from '../src/media';
const windows = (values: (number | null)[], duration = (values.length - 1) * 5) => classifyWindows(values.map((value, i) => ({ time: Math.min(i * 5, duration), value, frame_times: [] })));
const result = (duration = 20): Analysis => ({ id: 'test', name: 'test', source: { path: '', sha256: '', size: 0, mtimeMs: 0 }, mode: 'damage', media: { duration, fps: 30, width: 200, height: 90, hasAudio: false, videoCodec: 'test' }, readings: [], clips: [], damageEvents: [], audioEvents: [], curve: [], stats: {}, warnings: [] });
test('probe grid includes tail once for short and exact multiple durations', () => {
  expect(probeTimes(12)).toEqual([0, 5, 10, 12]); expect(probeTimes(10)).toEqual([0, 5, 10]); expect(probeTimes(.01)).toEqual([0, .01]);
});
test('only decreasing or unknown endpoints queue merged anomalies', () => {
  const w = windows([0, 0, 20, 5, null, null, 30, 30]);
  expect(w.map(w => [w.source, w.highlighted])).toEqual([['endpoints', false], ['endpoints', true], ['dense', false], ['dense', false], ['dense', false], ['dense', false], ['endpoints', false]]);
  expect(anomalyRanges(w)).toEqual([{ start: 10, end: 30 }]);
});
test('candidate windows merge by gap then padding, short tail extends backwards', () => {
  expect(windowClips(windows([0, 0, 10, 10]), 15, damageDefaults)).toEqual([{ start: 4, end: 12, raw_start: 5, raw_end: 10, event_count: 0, window_count: 1, peak_dbfs: 0 }]);
  const w = windows([0, 10, 10, 20, 20, 20, 30]);
  expect(windowClips(w, 30, damageDefaults).map(c => [c.start, c.end, c.window_count])).toEqual([[0, 17, 2], [24, 30, 1]]);
  expect(windowClips(w, 30, { gap_s: 0, before_s: 3, after_s: 3 })[0].window_count).toBe(2);
  expect(windowClips(windows([0, 0, 0, 10], 12), 12, damageDefaults)[0]).toMatchObject({ start: 6, end: 12, raw_start: 7 });
  expect(windowClips(windows([0, 10], 3), 3, damageDefaults)[0]).toMatchObject({ start: 0, end: 3 });
});
test('dense confirmations break on decreases and unknowns; single misreads cannot grow', () => {
  const tracker = new CounterTracker(true), values = [20,20,99,20,20,10,40,40,50,50,null,70,70,80,80];
  expect(values.flatMap((v,i) => tracker.update(i/10,v) ?? []).map(e => [e.previous,e.value])).toEqual([[40,50],[70,80]]);
  const w = windows([null,null,null]);
  expect(assignGrowth(w, {time:5,previous:0,value:10,increase:10})).toBe(true);
  expect(w.map(w => w.confirmed_increase ?? 0)).toEqual([0,10]);
  expect(assignGrowth(w, {time:10,previous:10,value:20,increase:10})).toBe(false);
});
test('legacy settings discard sampling rate; old curves still load and new unknowns break lines', () => {
  const settings = { mode: 'damage' as const, audio: audioDefaults, damage: { ...damageDefaults, gap_s: 7, sampling_fps: NaN } };
  validateSettings(settings); expect(settings.damage as import("../src/shared").DamageOptions).toEqual({ gap_s: 7, before_s: 1, after_s: 2 });
  const a = result(); a.readings = [{time:0,value:1},{time:1,value:null},{time:2,value:3}];
  expect(damageSegments(a)).toEqual([{start:0,end:1,from:1,to:1,estimated:false},{start:2,end:20,from:3,to:3,estimated:false}]);
  a.damage_strategy='interval-v1'; a.damageWindows=windows([1,3,null,9,9]);
  a.readings=[{time:5,value:3,source:'dense'},{time:5.1,value:null,source:'dense'},{time:5.2,value:9,source:'dense'}];
  const curve=damageSegments(a); expect(curve.filter(s=>s.estimated)).toHaveLength(2);
  expect(curve.some(s=>!s.estimated && s.end>s.start)).toBe(false);
});
const rgb = new Uint8Array(await Bun.file(new URL('./fixtures/hud.rgb', import.meta.url)).arrayBuffer());
async function simulate(duration: number, at: (time: number) => number, oneFrame = false) {
  const a = result(duration), calls: VideoWindowOptions[] = [];
  await analyzeIntervals(a, damageDefaults, '', new AbortController().signal, () => {}, () => {}, () => {}, async (_s,_t,o) => {
    calls.push(o); const step = o.fps ? 1/o.fps : 1/30;
    const n = Math.min(o.limit ?? Infinity, Math.ceil((o.end-o.start)/step), oneFrame ? 1 : Infinity);
    for (let i=0;i<n;i++) {
      const t=o.start+i*step; if(t>=duration)break;
      const index=at(t), image={width:200,height:90,channels:3 as const,data:index<0?new Uint8Array(54000):rgb.subarray(index*54000,(index+1)*54000)};
      await o.consume(image,t);
    }
    return {frames:n,bytesRead:n*54000};
  }, async () => Math.max(0, duration - 2/30));
  return {a,calls};
}
test('constant and rising probes never request interior sampling or invent precise events', async () => {
  const constant=await simulate(10,()=>1); expect(constant.a.clips).toEqual([]);expect(constant.calls.every(c=>!c.fps)).toBe(true);
  const rising=await simulate(10,t=>t<5?1:t<9?2:3);
  expect(rising.a.damageWindows!.map(w=>w.highlighted)).toEqual([true,true]); expect(rising.a.damageEvents).toEqual([]);
  expect(rising.a.clips[0].window_count).toBe(2); expect(rising.calls.filter(c=>c.fps)).toHaveLength(0); expect(rising.a.readings).toHaveLength(6);
},30000);
test('adjacent anomalies use one continuous stream and no growth across unknowns', async () => {
  const {a,calls}=await simulate(10,t=>t<1?-1:t<3?1:t<5?2:t<6?-1:t<8?3:4);
  expect(calls.filter(c=>c.fps)).toHaveLength(1); expect(calls.at(-1)!.fps).toBe(10);
  expect(a.damageWindows!.every(w=>w.source==='dense')).toBe(true);
  expect(a.damageEvents.map(e=>[e.previous,e.value])).toEqual([[84,103],[117,160]]);
  expect(new Set(a.readings.map(r=>r.time)).size).toBe(a.readings.length); expect(a.readings.every(r=>r.source==='dense')).toBe(true);
  const short=await simulate(.02,()=>1,true); expect(short.a.damageProbes!.every(p=>p.value===null)).toBe(true); expect(short.a.clips).toEqual([]);
},30000);

test('a disagreeing probe pair is unknown, and a boundary confirmation belongs to its first-frame window', async () => {
  const mismatch = await simulate(10, t => t > 5.02 && t < 5.05 ? 4 : 1);
  expect(mismatch.a.damageProbes![1].value).toBeNull();
  expect(mismatch.calls.filter(c => c.fps)).toHaveLength(1);
  expect(mismatch.a.clips).toEqual([]);
  const boundary = await simulate(10, t => t < 1 ? -1 : t < 4.85 ? 1 : 3);
  expect(boundary.a.damageEvents.map(e => [e.time, e.increase])).toEqual([[4.9, 33]]);
  expect(boundary.a.damageWindows!.map(w => w.highlighted)).toEqual([true, false]);
  expect(boundary.a.clips[0]).toMatchObject({ raw_start: 0, raw_end: 5, window_count: 1 });
}, 30000);
