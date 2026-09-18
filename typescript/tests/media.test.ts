import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Cancelled, runMedia, streamVideoFrames, streamVideoWindow, tailFrameStart, toolsPath } from '../src/media';
import type { Region } from '../src/core/image';

const ffmpeg = Bun.which('ffmpeg');
const work = await mkdtemp(join(tmpdir(), 'apex-crop-test-'));
afterAll(() => rm(work, { recursive: true, force: true }));

test.skipIf(!ffmpeg)('decoder-side keyframes retain exact CFR/VFR timestamps and RGB across a cropped restart', async () => {
  for (const vfr of [false,true]) {
    const source=join(work,`keyframes-${vfr}.mkv`), tools=dirname(ffmpeg!);
    await runMedia(ffmpeg!,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=24:duration=3',
      '-f','lavfi','-i','sine=duration=3',
      ...(vfr ? ['-vf',"select='not(mod(n,2))+not(mod(n,7))'",'-fps_mode','vfr'] : []),
      '-c:v','libx264','-g','12','-keyint_min','12','-sc_threshold','0','-bf','2','-c:a','aac','-avoid_negative_ts','disabled',source]);
    // Full decoding provides an independent reference, including key_frame flags.
    const meta=JSON.parse(await runMedia(toolsPath(tools,'ffprobe'),['-v','error','-select_streams','v:0','-show_frames','-show_format',
      '-show_entries','frame=key_frame,best_effort_timestamp_time:format=start_time','-of','json',source]));
    const expected=meta.frames.filter((f:any)=>f.key_frame===1).map((f:any)=>Number(f.best_effort_timestamp_time)-Number(meta.format.start_time));
    const all=new Map<number,Uint8Array>();
    const common={width:128,height:96,start:0,end:4};
    await streamVideoWindow(source,tools,{...common,consume(f,t){all.set(Math.round(t*1e5),Uint8Array.from(f.data));}});
    const actual:number[]=[];
    const full=await streamVideoWindow(source,tools,{...common,keyframesOnly:true,consume(f,t){
      actual.push(t); expect(f.data).toEqual(all.get(Math.round(t*1e5))!);
    }});
    expect(actual.length).toBe(expected.length); actual.forEach((t,i)=>expect(t).toBeCloseTo(expected[i],4));
    expect(full.frames).toBeLessThan(all.size/5);
    const resumed:number[]=[], lifecycle:boolean[]=[];
    const first=await streamVideoWindow(source,tools,{...common,keyframesOnly:true,event(e){if(e.type==='pid')lifecycle.push(e.active);},consume(_f,t){resumed.push(t);return false;}});
    expect(first.frames).toBe(1); expect(lifecycle).toEqual([true,false]);
    const region={x:13,y:7,width:61,height:39};
    const cropped=await streamVideoWindow(source,tools,{...common,start:actual[0]+.00001,keyframesOnly:true,region,consume(f,t){
      resumed.push(t); const ref=all.get(Math.round(t*1e5))!;
      for(let y=0;y<region.height;y++) expect(f.data.subarray(y*region.width*3,(y+1)*region.width*3))
        .toEqual(ref.subarray(((y+region.y)*128+region.x)*3,((y+region.y)*128+region.x+region.width)*3));
    }});
    expect(resumed).toEqual(actual);
    expect(first.frames + cropped.frames).toBe(full.frames);
    const controller=new AbortController();
    await expect(streamVideoWindow(source,tools,{...common,keyframesOnly:true,signal:controller.signal,consume(){controller.abort();}})).rejects.toBeInstanceOf(Cancelled);
  }
},30000);

test('deliberate pipe stop cleans up the child; cancellation and tool failures propagate', async () => {
  const events: boolean[] = [];
  await runMedia(process.execPath, ['-e', 'setInterval(() => process.stdout.write("frame"), 5)'], {
    event(e) { if (e.type === 'pid') events.push(e.active); },
    consume() { return false; },
  });
  expect(events).toEqual([true, false]);
  const controller = new AbortController();
  await expect(runMedia(process.execPath, ['-e', 'setInterval(() => process.stdout.write("frame"), 5)'], {
    signal: controller.signal,
    consume() { controller.abort(); return false; },
  })).rejects.toBeInstanceOf(Cancelled);
  await expect(runMedia(process.execPath, ['-e', 'process.stderr.write("test failure");process.exit(7)']))
    .rejects.toThrow('test failure');
});

test.skipIf(!ffmpeg)('crop stream resumes the exact RGB samples on CFR and VFR videos, including odd origins', async () => {
  const region: Region = { x: 13, y: 7, width: 61, height: 39 };
  for (const vfr of [false, true]) {
    const source = join(work, vfr ? 'vfr.mkv' : 'cfr.mkv');
    await runMedia(ffmpeg!, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=1.5',
      ...(vfr ? ['-vf', "select='not(mod(n,2))+not(mod(n,7))'", '-fps_mode', 'vfr'] : []),
      '-c:v', 'ffv1', source,
    ]);
    const common = { width: 128, height: 96, fps: 17 };
    const full: Uint8Array[] = [];
    await streamVideoFrames(source, dirname(ffmpeg!), { ...common, consume(frame) {
      full.push(Uint8Array.from(frame.data));
    }});
    expect(full.length).toBeGreaterThan(20);
    const indices: number[] = [];
    // Switch after sample 6. The new stream must start at sample 7, not 6 or 8.
    await streamVideoFrames(source, dirname(ffmpeg!), { ...common, consume(frame, index) {
      indices.push(index);
      expect(frame.data).toEqual(full[index]);
      if (index === 6) return false;
    }});
    const cropped = await streamVideoFrames(source, dirname(ffmpeg!), {
      ...common, region, startFrame: 7,
      consume(frame, index) {
        indices.push(index);
        const expected = new Uint8Array(region.width * region.height * 3);
        for (let y = 0; y < region.height; y++) {
          const start = ((y + region.y) * common.width + region.x) * 3;
          expected.set(full[index].subarray(start, start + region.width * 3), y * region.width * 3);
        }
        if (!Buffer.from(frame.data).equals(expected)) {
          const differences = full.map((candidate, i) => {
            let count = 0;
            for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width * 3; x++)
              if (candidate[((y + region.y) * common.width + region.x) * 3 + x] !== frame.data[y * region.width * 3 + x]) count++;
            return { i, count };
          }).sort((a, b) => a.count - b.count).slice(0, 3);
          throw new Error(JSON.stringify({ vfr, index, fullCount: full.length, differences }));
        }
        expect(Buffer.from(frame.data).equals(expected)).toBe(true);
      },
    });
    expect(indices).toEqual(Array.from({ length: full.length }, (_, i) => i));
    expect(cropped.frames).toBe(full.length - 7);
    expect(cropped.bytesRead).toBe(cropped.frames * region.width * region.height * 3);
    const eof = await streamVideoFrames(source, dirname(ffmpeg!), {
      ...common, region, startFrame: full.length, consume() { throw new Error('extra sample'); },
    });
    expect(eof.frames).toBe(0);
    const controller = new AbortController();
    await expect(streamVideoFrames(source, dirname(ffmpeg!), {
      ...common, region, startFrame: 7, signal: controller.signal,
      consume() { controller.abort(); },
    })).rejects.toBeInstanceOf(Cancelled);
  }
}, 30_000);


test.skipIf(!ffmpeg)('time-window seeks preserve actual CFR/VFR frame timestamps, crop pixels and frame limits', async () => {
  for (const vfr of [false, true]) {
    const source = join(work, `window-${vfr}.mkv`);
    await runMedia(ffmpeg!, ['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=24:duration=2',
      ...(vfr ? ['-vf', "select='not(mod(n,2))+not(mod(n,7))'",'-fps_mode','vfr'] : []), '-c:v','ffv1',source]);
    const frames: {time:number; data:Uint8Array}[] = [];
    await streamVideoWindow(source, dirname(ffmpeg!), {width:128,height:96,start:0,end:2,consume(f,time){frames.push({time,data:Uint8Array.from(f.data)});}});
    const tailStart = await tailFrameStart(source, dirname(ffmpeg!), 2);
    const tail: number[] = [];
    await streamVideoWindow(source, dirname(ffmpeg!), {width:128,height:96,start:tailStart,end:2,limit:2,consume(_f,t){tail.push(t);}});
    expect(tail).toHaveLength(2);
    tail.forEach((t,i)=>expect(t).toBeCloseTo(frames.at(i-2)!.time,4));
    const expected=frames.filter(f=>f.time>=.71).slice(0,2), actual:number[]=[];
    const region={x:13,y:7,width:61,height:39};
    const got=await streamVideoWindow(source,dirname(ffmpeg!),{width:128,height:96,start:.71,end:2,limit:2,region,consume(f,time){
      const ref=expected[actual.length]; expect(time).toBeCloseTo(ref.time,4);actual.push(time);
      for(let y=0;y<region.height;y++) expect(f.data.subarray(y*region.width*3,(y+1)*region.width*3))
        .toEqual(ref.data.subarray(((y+region.y)*128+region.x)*3,((y+region.y)*128+region.x+region.width)*3));
    }});
    expect(got.frames).toBe(2); expect(got.bytesRead).toBe(2*region.width*region.height*3);
    const sampled:number[]=[];
    await streamVideoWindow(source,dirname(ffmpeg!),{width:128,height:96,start:.71,end:1.75,fps:10,consume(_f,time){sampled.push(time);}});
    expect(sampled.length).toBeGreaterThan(5); expect(new Set(sampled).size).toBe(sampled.length);
    expect(sampled.filter(t=>!(t>=.71 && t<1.75 && frames.some(f=>Math.abs(f.time-t)<.0001)))).toEqual([]);
    const controller=new AbortController(), lifecycle:boolean[]=[];
    await expect(streamVideoWindow(source,dirname(ffmpeg!),{width:128,height:96,start:0,end:2,signal:controller.signal,
      event(e){if(e.type==='pid')lifecycle.push(e.active);},consume(){controller.abort();}})).rejects.toBeInstanceOf(Cancelled);
    expect(lifecycle).toEqual([true,false]);
  }
  await expect(streamVideoWindow(join(work,'missing.mkv'),dirname(ffmpeg!),{width:128,height:96,start:0,end:1,consume(){}})).rejects.toThrow('执行失败');
},30000);

test.skipIf(!ffmpeg)('a one-frame recording cannot be doubled into a confirmed reading', async () => {
  const source = join(work, 'one-frame.mkv');
  await runMedia(ffmpeg!, ['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=1','-frames:v','1','-c:v','ffv1',source]);
  const start = await tailFrameStart(source, dirname(ffmpeg!), 1);
  const actual:number[]=[];
  await streamVideoWindow(source, dirname(ffmpeg!), {width:128,height:96,start,end:1,fps:10,limit:2,consume(_f,t){actual.push(t);}});
  expect(actual).toEqual([0]);
}, 30000);

test.skipIf(!ffmpeg)('tail pair uses the same bounds with negative audio preroll and reordered video packets', async () => {
  const source = join(work, 'preroll.mkv');
  await runMedia(ffmpeg!, ['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=60:duration=1',
    '-f','lavfi','-i','sine=duration=1','-c:v','libx264','-bf','2','-c:a','aac','-avoid_negative_ts','disabled',source]);
  const { probe } = await import('../src/media');
  const media = await probe(source, dirname(ffmpeg!));
  const all:number[]=[], tail:number[]=[];
  await streamVideoWindow(source,dirname(ffmpeg!),{width:128,height:96,start:0,end:media.duration,consume(_f,t){all.push(t);}});
  const start = await tailFrameStart(source,dirname(ffmpeg!),media.duration);
  await streamVideoWindow(source,dirname(ffmpeg!),{width:128,height:96,start,end:media.duration,limit:2,consume(_f,t){tail.push(t);}});
  expect(tail).toEqual(all.slice(-2)); expect(tail).toHaveLength(2);
}, 30000);

test.skipIf(!ffmpeg)('slow frame consumers backpressure the decoder instead of draining one huge buffer', async () => {
  const frameBytes = 1280 * 720 * 3, count = 48;
  let bytesRead = 0, maxChunk = 0, first = true;
  await runMedia(ffmpeg!, ['-v','error','-f','lavfi','-i','color=size=1280x720:rate=60',
    '-frames:v',String(count),'-pix_fmt','rgb24','-f','rawvideo','pipe:1'], {
    streamOutput: true,
    async consume(bytes) {
      bytesRead += bytes.length;
      maxChunk = Math.max(maxChunk, bytes.length);
      // Give the producer enough time to finish if the pipe keeps buffering.
      if (first) { first = false; await Bun.sleep(1500); }
    },
  });
  expect(bytesRead).toBe(frameBytes * count);
  expect(maxChunk).toBeLessThan(32 * 1024 * 1024);
}, 15000);

test('missing media executable rejects without an unhandled child error', async () => {
  await expect(runMedia('/definitely-missing-apex-ffmpeg', [])).rejects.toThrow();
});
