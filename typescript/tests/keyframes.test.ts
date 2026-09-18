import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counterRegion } from '../src/paddleocr';
import { keyframeWindows } from '../src/core/keyframes';
import { damageSegments } from '../src/core/damage-curve';
import { windowClips } from '../src/core/interval';
import { analyzeKeyframes } from '../src/keyframe-analysis';
import { damageDefaults, type Analysis } from '../src/shared';
import { Cancelled, type VideoWindowOptions } from '../src/media';

const result = (duration = 20): Analysis => ({ id: 'test', name: 'test', source: { path: '', sha256: '', size: 0, mtimeMs: 0 }, mode: 'damage', media: { duration, fps: 30, width: 200, height: 90, hasAudio: false, videoCodec: 'test' }, readings: [], clips: [], damageEvents: [], audioEvents: [], curve: [], stats: {}, warnings: [] });
test('irregular keyframes break on unknown/reset and never invent boundary observations', () => {
  const a = result();
  a.damage_strategy = 'keyframes-v1';
  a.readings = [64,103,null,117,160,20,30].map((value,i) => ({ time: [0.02,3,4,8,12.5,13,18][i], value, source: 'keyframe' }));
  a.damageWindows = keyframeWindows(a.readings,20);
  expect(a.damageWindows.filter(w => w.highlighted).map(w => [w.start,w.end,w.net_increase])).toEqual([[.02,3,39],[8,12.5,43],[13,18,10]]);
  expect(a.damageWindows.map(w => w.reason)).toEqual(['unknown','increase','unknown','unknown','increase','decrease','increase','unknown']);
  expect(damageSegments(a).filter(s => s.estimated).map(s => [s.start,s.end])).toEqual([[.02,3],[8,12.5],[13,18]]);
  expect(a.readings).toHaveLength(7);
});
test('keyframe candidates retain minimum duration, buffers, gap merging and video bounds', () => {
  const windows = (times: number[]) => keyframeWindows(times.map((time,i) => ({ time, value:i*10 })),20);
  expect(windowClips(windows([0,1]),20,damageDefaults)[0]).toMatchObject({raw_start:0,raw_end:5,start:0,end:7});
  expect(windowClips(windows([10,12]),20,damageDefaults)[0]).toMatchObject({raw_start:7,raw_end:12,start:6,end:14});
  expect(windowClips(windows([0,1]),3,damageDefaults)[0]).toMatchObject({start:0,end:3});
  expect(windowClips(windows([0,1,2]),20,damageDefaults)[0].window_count).toBe(2);
  expect(windowClips(keyframeWindows([{time:0,value:1}],3),3,damageDefaults)).toEqual([]);
});
const rgb = new Uint8Array(await Bun.file(new URL('./fixtures/hud.rgb', import.meta.url)).arrayBuffer());
async function simulate(samples: [number,number][], duration = 20) {
  const a = result(duration), calls: VideoWindowOptions[] = [];
  const debugDir = await mkdtemp(join(tmpdir(), 'apex-ocr-test-'));
  let current = -1, closed = false;
  const observations: {time: number; located: boolean}[] = [];
  try {
  await analyzeKeyframes(a,damageDefaults,'',new AbortController().signal,()=>{},()=>{},()=>{},async (_s,_t,o) => {
    calls.push(o);
    const selected=samples.filter(([t])=>t>=o.start && t<o.end);
    let frames=0;
    for (const [t,index] of selected) {
      frames++; current = index;
      const image={width:200,height:90,channels:3 as const,data:index<0?new Uint8Array(54000):rgb.subarray(index*54000,(index+1)*54000)};
      if (await o.consume(image,t) === false) break;
    }
    return {frames,bytesRead:frames*54000};
  }, { debugDir, createReader: async () => ({
    async read(image, anchor, time) {
      observations.push({time, located: !!anchor});
      const value = anchor && current >= 0 ? [0,64,103,117,160][current] : null;
      return { value, text: value === null ? '' : String(value), score: value === null ? null : .99,
        status: value === null ? 'no_region' : 'recognized', model: 'test',
        region: anchor ? counterRegion(image,anchor) : null,
        frame_path:'frame.png', input_path:anchor ? 'input.png' : null, metadata_path:'result.json', elapsed_ms:1 };
    }, async close() { closed = true; },
  }) });
  const manifest = (await Bun.file(join(debugDir,'frames.jsonl')).exists())
    ? (await Bun.file(join(debugDir,'frames.jsonl')).text()).trim().split('\n').map(line=>JSON.parse(line)) : [];
  expect(manifest).toHaveLength(a.readings.length);
  expect(closed).toBe(samples.length > 0);
  expect(calls.every(c=>c.region === undefined)).toBe(true);
  return {a,calls,observations};
  } finally { await rm(debugDir,{recursive:true,force:true}); }
}
test('one read per keyframe accepts growth immediately, including a single-frame spike', async () => {
  const {a,calls}=await simulate([[0,1],[3,2],[5,4],[8,2],[12,3]]);
  expect(calls).toHaveLength(1); expect(calls[0].keyframesOnly).toBe(true); expect(calls[0].fps).toBeUndefined();
  expect(a.readings.map(r=>r.value)).toEqual([64,103,160,103,117]);
  expect(a.damageWindows!.filter(w=>w.highlighted).map(w=>w.net_increase)).toEqual([39,57,14]);
  expect(a.damageEvents).toEqual([]); expect(a.damageProbes!.every(p=>p.frame_times.length===1)).toBe(true);
  expect(a.damage_parameters).toMatchObject({frame_selection:'keyframes',confirmation_frames:1});
  expect(a.stats.sampled_frames).toBe(5);
},30000);
test('constant, missing, reset and one-frame videos never trigger fallback decoding', async () => {
  const constant=await simulate([[0,1],[4,1],[8,1]]); expect(constant.a.clips).toEqual([]);
  const mixed=await simulate([[0,2],[3,1],[4,-1],[8,3],[12,4]]);
  expect(mixed.a.damageWindows!.filter(w=>w.highlighted).map(w=>[w.start,w.end,w.net_increase])).toEqual([[8,12,43]]);
  expect(mixed.calls).toHaveLength(1);
  expect(mixed.observations.some(o=>o.time===4 && !o.located)).toBe(true);
  const single=await simulate([[0,1]],.02); expect(single.a.readings[0].value).toBe(64); expect(single.a.clips).toEqual([]);
  const empty=await simulate([]); expect(empty.a.readings).toEqual([]); expect(empty.a.damageWindows![0].reason).toBe('unknown');
},30000);
test('keyframe analysis propagates cancellation and decoder failure', async () => {
  const controller=new AbortController(); controller.abort();
  await expect(analyzeKeyframes(result(),damageDefaults,'',controller.signal,()=>{},()=>{},()=>{},async()=>{throw new Error('unexpected decode');})).rejects.toBeInstanceOf(Cancelled);
  await expect(analyzeKeyframes(result(),damageDefaults,'',new AbortController().signal,()=>{},()=>{},()=>{},async()=>{throw new Error('decoder failure');})).rejects.toThrow('decoder failure');
});
