import { expect, test } from 'bun:test';
import { counterRegion } from '../src/paddleocr';
import { HudLocator } from '../src/core/damage';

test('OCR crop uses native pixels and clips right/bottom to original frame', () => {
  const frame = {width:400,height:200,channels:3,data:new Uint8Array(400*200*3)};
  expect(counterRegion(frame,{x:10,y:20,scale:2,score:.9})).toEqual({x:138,y:28,width:240,height:62});
  expect(counterRegion(frame,{x:300,y:170,scale:1,score:.9})).toEqual({x:364,y:174,width:36,height:26});
  expect(counterRegion(frame,{x:390,y:20,scale:1,score:.9})).toBeNull();
});

test('OCR acquisition uses supplied reading and never substitutes a digit-template value', async () => {
  const rgb = new Uint8Array(await Bun.file(new URL('./fixtures/hud.rgb',import.meta.url)).arrayBuffer());
  const frame = {width:200,height:90,channels:3,data:rgb.subarray(54000,108000)};
  const locator = new HudLocator(30);
  expect(await locator.locateAndRead(frame,0,async()=>null)).toBeNull();
  expect(locator.anchor).toBeNull();
  // This crop's legacy reader returns 84. The new path must use OCR's 64.
  expect((await locator.locateAndRead(frame,30,async()=>64))?.value).toBe(64);
  expect((await locator.locateAndRead(frame,60,async()=>0))?.value).toBe(0);
  const unreadable=await locator.locateAndRead(frame,90,async()=>null);
  expect(unreadable?.anchor).toBeDefined();
  expect(unreadable?.value).toBeNull();
  await expect(locator.locateAndRead(frame,120,async()=>{throw new Error('OCR failure');})).rejects.toThrow('OCR failure');
});

test('crop excludes a separated HUD border without masking the digit string', () => {
  const frame = {width:300,height:100,channels:3,data:new Uint8Array(90000)};
  for (const [left,right] of [[69,77],[83,100],[105,123],[148,165]])
    for (let x=left;x<=right;x++) for(let y=6;y<32;y++)
      frame.data.fill(240,(y*300+x)*3,(y*300+x)*3+3);
  expect(counterRegion(frame,{x:0,y:0,scale:1,score:1})).toEqual({x:64,y:4,width:62,height:31});
});
