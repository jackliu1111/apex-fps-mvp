import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  audioClips,
  detectAudioEvents,
  RMSAccumulator,
  audioCurve,
} from "../src/core/audio";
import {
  CounterTracker,
  HudLocator,
  banks,
  readLocatedCounter,
  damageClips,
  type HudFrame,
} from "../src/core/damage";
import { Matcher, resize, containsRegion, type Image, type Region } from "../src/core/image";
import { damageDefaults, audioDefaults, validateSettings } from "../src/shared";
import { frameInterval } from "../src/media";
const fixture = (name: string) =>
  Bun.file(join(import.meta.dir, "fixtures", name));
const rgb = new Uint8Array(await fixture("hud.rgb").arrayBuffer());
const hud = (index: number): Image => ({
  data: rgb.subarray(index * 54000, (index + 1) * 54000),
  width: 200,
  height: 90,
  channels: 3,
});
export function canvas(
  index: number,
  width: number,
  height: number,
  scale: number,
  x: number,
  y: number,
): Image {
  const data = new Uint8Array(width * height * 3).fill(35),
    image = resize(hud(index), Math.round(200 * scale), Math.round(90 * scale));
  for (let yy = 0; yy < image.height; yy++)
    for (let xx = 0; xx < image.width; xx++)
      for (let c = 0; c < 3; c++)
        data[((yy + y) * width + xx + x) * 3 + c] =
          image.data[(yy * image.width + xx) * 3 + c];
  return { data, width, height, channels: 3 };
}
function cropped(frame: Image, region: Region): HudFrame {
  const data = new Uint8Array(region.width * region.height * 3);
  for (let y = 0; y < region.height; y++) {
    const start = ((y + region.y) * frame.width + region.x) * 3;
    data.set(frame.data.subarray(start, start + region.width * 3), y * region.width * 3);
  }
  return { data, width: region.width, height: region.height, channels: 3, origin: region };
}
describe("existing detector golden evidence", () => {
  test("an icon without digits does not permanently lock out a later distant HUD", () => {
    const locator = new HudLocator(4);
    const emptyCounter = canvas(2, 640, 360, 1, 50, 220);
    // Preserve the actual icon but erase its entire adjacent digit band.
    for (let y = 220; y < 310; y++)
      emptyCounter.data.fill(35, (y * 640 + 140) * 3, (y * 640 + 250) * 3);
    expect(locator.locate(emptyCounter, 0)).toBeNull();
    expect(locator.searchRegion(640, 360)).toBeNull();
    const realCounter = canvas(2, 640, 360, 1, 400, 40);
    const anchor = locator.locate(realCounter, 4);
    expect(anchor).not.toBeNull();
    expect(readLocatedCounter(realCounter, anchor!)).toBe(103);
    expect(locator.searches).toBe(2);
  }, 30_000);
  test("native crop preserves global coordinates, missing frames, movement and scale recalibration", () => {
    const fullLocator = new HudLocator(4), cropLocator = new HudLocator(4);
    const first = canvas(2, 1920, 1080, 1, 1300, 450);
    expect(cropLocator.searchRegion(1920, 1080)).toBeNull();
    expect(cropLocator.locate(first, 0)).toEqual(fullLocator.locate(first, 0));
    const region = cropLocator.searchRegion(1920, 1080, true)!;
    expect(region.x).toBeGreaterThan(0);
    expect(region.y).toBeGreaterThan(0);
    const moved = canvas(3, 1920, 1080, 1, 1175, 575);
    const hidden = { ...first, data: new Uint8Array(first.data.length) };
    const scaled = canvas(4, 1920, 1080, 1.125, 1175, 575);
    const frames = [hidden, hidden, moved, moved, moved, scaled, scaled];
    for (let i = 0; i < frames.length; i++) {
      if (i === 5) { fullLocator.invalidate(); cropLocator.invalidate(); }
      expect(containsRegion(region, cropLocator.searchRegion(1920, 1080)!)).toBe(true);
      const frame = frames[i], crop = cropped(frame, region),
        actual = cropLocator.locate(crop, i + 1), expected = fullLocator.locate(frame, i + 1);
      expect(actual).toEqual(expected);
      expect(actual ? readLocatedCounter(crop, actual) : null)
        .toBe(expected ? readLocatedCounter(frame, expected) : null);
    }
    expect(cropLocator.searches).toBe(1);
    expect(cropLocator.localRecoveries).toBe(fullLocator.localRecoveries);
    expect(cropLocator.locatedFrames).toBe(fullLocator.locatedFrames);
    expect(() => new HudLocator(4).locate(cropped(first, region), 0)).toThrow("完整画面");
  }, 30_000);
  test("supply bounds include edge HUDs and signal when accumulated drift outgrows the margin", () => {
    const locator = new HudLocator(4);
    const first = canvas(2, 1280, 720, 0.5, 600, 300);
    expect(locator.locate(first, 0)).not.toBeNull();
    const region = locator.searchRegion(1280, 720, true)!;
    let exhausted = false;
    for (let i = 1; i <= 12; i++) {
      const frame = canvas(2, 1280, 720, 0.5, 600 + i * 20, 300);
      expect(locator.locate(cropped(frame, region), i)).not.toBeNull();
      if (!containsRegion(region, locator.searchRegion(1280, 720)!)) {
        exhausted = true;
        const next = canvas(3, 1280, 720, 0.5, 600 + (i + 1) * 20, 300);
        expect(readLocatedCounter(next, locator.locate(next, i + 1)!)).toBe(117);
        break;
      }
    }
    expect(exhausted).toBe(true);
    expect(locator.searches).toBe(1);
    const edge = new HudLocator(4);
    expect(edge.locate(canvas(2, 1280, 720, 0.5, 1150, 0), 0)).not.toBeNull();
    const bounded = edge.searchRegion(1280, 720, true)!;
    expect(bounded.y).toBe(0);
    expect(bounded.x + bounded.width).toBe(1280);
  }, 30_000);
  test("audio events and padded clips match all reference cases", async () => {
    const cases = await fixture("audio_golden.json").json();
    for (const c of cases) {
      const actual = detectAudioEvents(c.rms, c.options);
      // NumPy's original fixtures use float32 percentile arithmetic (same tolerance as the Go port).
      expect(Math.abs(actual.threshold - c.threshold)).toBeLessThanOrEqual(
        1e-5,
      );
      expect(actual.events).toEqual(c.events);
      expect(audioClips(actual.events, c.duration, c.options)).toEqual(c.clips);
    }
  });
  test("unknown and falling counts reset the baseline; transient digits do not cause rises", async () => {
    const c = await fixture("tracker_golden.json").json(),
      tracker = new CounterTracker();
    const events = c.values.flatMap((v: number | null, i: number) => {
      const e = tracker.update(i / 30, v);
      return e ? [e] : [];
    });
    expect(events).toEqual(c.events);
    // The historical golden fixture uses its original short-clip settings.
    const clips = damageClips(events, 1, {
      ...damageDefaults,
      gap_s: 0.3,
      before_s: 0.1,
      after_s: 0.2,
    });
    expect(clips).toHaveLength(c.clips.length);
    expect(clips[0].start).toBeCloseTo(c.clips[0].start, 8);
    expect(clips[0].end).toBeCloseTo(c.clips[0].end, 8);
  });
  test("damage candidates chain five-second gaps and retain context within video bounds", () => {
    const events = [0.5, 10, 15, 20, 26, 29].map((time, i) => ({
      time,
      previous: i * 10,
      value: (i + 1) * 10,
      increase: 10,
    }));
    const clips = damageClips(events, 30, damageDefaults);
    expect(clips.map((c) => [c.start, c.end, c.event_count])).toEqual([
      [0, 2.5, 1],
      [9, 22, 3],
      [25, 30, 2],
    ]);
    expect(clips.map((c) => [c.raw_start, c.raw_end])).toEqual([
      [0.5, 0.5],
      [10, 20],
      [26, 29],
    ]);
  });
  test("real HUD crops retain candidates with maximum-reading semantics", async () => {
    const expected: number[] = await fixture("hud_expected.json").json();
    // The true 64 crop also produces a weak 84 candidate; recall mode keeps 84.
    const recallExpected = expected.map((value, i) => i === 1 ? 84 : value);
    for (let i = 0; i < expected.length; i++) {
      const frame = hud(i),
        anchor = new HudLocator(30).locate(frame, 0);
      expect(anchor ? readLocatedCounter(frame, anchor) : null).toBe(
        recallExpected[i] < 0 ? null : recallExpected[i],
      );
    }
  }, 30_000);
  test("resolution, aspect ratio and HUD position vary independently", () => {
    const cases = [
      [3840, 2160, 1, 3100, 230],
      [2560, 1440, 2 / 3, 2050, 140],
      [1920, 1080, 0.5, 800, 500],
      [1280, 720, 1 / 3, 900, 100],
      [2560, 1080, 0.5, 2000, 80],
      [720, 1280, 0.5, 400, 600],
      [1280, 720, 1.5, 700, 300],
    ];
    for (const [width, height, scale, x, y] of cases) {
      const frame = canvas(2, width, height, scale, x, y),
        a = new HudLocator(30).locate(frame, 0);
      expect(a).not.toBeNull();
      expect(Math.abs(a!.x - (x + 26 * scale))).toBeLessThanOrEqual(4);
      expect(Math.abs(a!.y - (y + 20 * scale))).toBeLessThanOrEqual(3);
      expect(Math.abs(a!.scale - scale)).toBeLessThanOrEqual(0.06);
      expect(readLocatedCounter(frame, a!)).toBe(103);
    }
  }, 120_000);
  test("tracks moving digit widths, ignores a distant HUD, accepts the best duplicate anchor", () => {
    const locator = new HudLocator(4);
    expect(locator.locate(canvas(2, 640, 360, 0.5, 400, 40), 0)).not.toBeNull();
    const shifted = canvas(3, 640, 360, 0.5, 400, 40),
      a = locator.locate(shifted, 1);
    expect(readLocatedCounter(shifted, a!)).toBe(117);
    expect(locator.searches).toBe(1);
    expect(
      locator.locate(
        { ...shifted, data: new Uint8Array(shifted.data.length) },
        2,
      ),
    ).toBeNull();
    const moved = canvas(2, 640, 360, 0.5, 100, 220);
    expect(locator.locate(moved, 3)).toBeNull();
    expect(locator.locate(moved, 4)).toBeNull();
    expect(locator.searches).toBe(1);
    const duplicates = canvas(2, 640, 360, 1, 50, 30),
      second = hud(2);
    for (let y = 0; y < 90; y++)
      duplicates.data.set(
        second.data.subarray(y * 600, (y + 1) * 600),
        ((y + 200) * 640 + 400) * 3,
      );
    expect(new HudLocator(30).locate(duplicates, 0)).not.toBeNull();
  }, 60_000);
  test("weak digit shapes remain readable and empty bands remain unknown", () => {
    const data = new Uint8Array(200 * 90 * 3);
    const frame: Image = { data, width: 200, height: 90, channels: 3 };
    const anchor = { x: 20, y: 20, scale: 1, score: 0.6 };
    expect(readLocatedCounter(frame, anchor)).toBeNull();
    // A solid block is not a reliable digit template, but is a digit candidate.
    for (let y = 25; y < 53; y++)
      for (let x = 90; x < 105; x++)
        data.fill(255, (y * 200 + x) * 3, (y * 200 + x + 1) * 3);
    expect(readLocatedCounter(frame, anchor)).not.toBeNull();
  });
  test("conflicting binarizations select the largest reading", () => {
    const frame = hud(2), anchor = new HudLocator(30).locate(frame, 0)!;
    const bank = banks.gray_otsu;
    const one = bank[1], nine = bank[9];
    try {
      // This method reads 903 where the other methods read 103.
      bank[1] = nine; bank[9] = one;
      expect(readLocatedCounter(frame, anchor)).toBe(903);
    } finally { bank[1] = one; bank[9] = nine; }
  });
  test("four/five digit reads reject a clipped final glyph", () => {
    let frame: Image;
    for (const digits of [
      [1, 0, 1, 0],
      [1, 0, 1, 0, 1],
    ]) {
      const data = new Uint8Array(100 * 260 * 3);
      frame = { data, width: 260, height: 100, channels: 3 };
      digits.forEach((d, i) => {
        for (let y = 0; y < 30; y++)
          for (let x = 0; x < 20; x++)
            for (let c = 0; c < 3; c++)
              data[((24 + y) * 260 + 90 + i * 22 + x) * 3 + c] =
                banks.white_180[d][y * 20 + x] * 255;
      });
      expect(
        readLocatedCounter(frame, { x: 20, y: 20, scale: 1, score: 1 }),
      ).toBe(Number(digits.join("")));
    }
    const clipped = new Uint8Array(100 * 190 * 3);
    for (let y = 0; y < 100; y++)
      clipped.set(
        frame!.data.subarray(y * 260 * 3, (y * 260 + 190) * 3),
        y * 190 * 3,
      );
    expect(
      readLocatedCounter(
        { data: clipped, width: 190, height: 100, channels: 3 },
        { x: 20, y: 20, scale: 1, score: 1 },
      ),
    ).toBeNull();
  });
  test("recovers the nearby HUD on the next frame without bridging unknown readings", () => {
    const locator = new HudLocator(4),
      tracker = new CounterTracker();
    const first = canvas(2, 640, 360, 1, 400, 40);
    const hidden = { ...first, data: new Uint8Array(first.data.length) };
    const returned = canvas(3, 640, 360, 1, 406, 40);
    const increased = canvas(4, 640, 360, 1, 406, 40);
    const frames = [first, first, hidden, returned, returned, increased, increased];
    const readings: (number | null)[] = [],
      events = [];
    for (let i = 0; i < frames.length; i++) {
      const anchor = locator.locate(frames[i], i);
      const value = anchor ? readLocatedCounter(frames[i], anchor) : null;
      readings.push(value);
      const event = tracker.update(i / 4, value);
      if (event) events.push(event);
    }
    expect(readings).toEqual([103, 103, null, 117, 117, 160, 160]);
    expect(events.map((e) => [e.previous, e.value])).toEqual([[117, 160]]);
    expect(locator.searches).toBe(1);
    expect(locator.localRecoveries).toBe(1);
  }, 30_000);
  test("never searches globally after acquisition, even through a long outage or distant HUD", () => {
    const fps = 4,
      locator = new HudLocator(fps);
    const first = canvas(2, 640, 360, 0.5, 400, 40);
    expect(locator.locate(first, 0)).not.toBeNull();
    const hidden = { ...first, data: new Uint8Array(first.data.length) };
    for (let i = 1; i <= 60; i++)
      expect(locator.locate(hidden, i)).toBeNull();
    // Missing and relocated HUDs stay unknown without reopening global search.
    expect(locator.searches).toBe(1);
    const moved = canvas(3, 640, 360, 0.5, 60, 220);
    for (let i = 61; i <= 61 + 4 * fps; i++)
      expect(locator.locate(moved, i)).toBeNull();
    expect(locator.searches).toBe(1);
    // Return to the acquired area is detected immediately, despite retry delay.
    expect(readLocatedCounter(first, locator.locate(first, 78)!)).toBe(103);
    expect(locator.searches).toBe(1);
  }, 60_000);
  test("can widen the nearby search while retaining the global lock", () => {
    const locator = new HudLocator(4);
    const first = canvas(2, 640, 360, 1, 400, 40);
    expect(locator.locate(first, 0)).not.toBeNull();
    expect(
      locator.locate({ ...first, data: new Uint8Array(first.data.length) }, 1),
    ).toBeNull();
    // A HUD can shift by about two icon widths without changing screen region.
    const moved = canvas(3, 640, 360, 1, 275, 165);
    const anchor = locator.locate(moved, 4);
    expect(anchor).not.toBeNull();
    expect(readLocatedCounter(moved, anchor!)).toBe(117);
    expect(locator.searches).toBe(1);
    expect(locator.localRecoveries).toBe(1);
  }, 30_000);
  test("repeated unreadable-digit invalidation retains the acquired area", () => {
    const locator = new HudLocator(30);
    const first = canvas(2, 640, 360, 0.5, 400, 40);
    expect(locator.locate(first, 0)).not.toBeNull();
    const moved = canvas(3, 640, 360, 1, 50, 200);
    for (let i = 1; i <= 3; i++) {
      locator.invalidate();
      expect(locator.locate(moved, i)).toBeNull();
      expect(locator.searches).toBe(1);
    }
    const returned = canvas(3, 640, 360, 0.5, 406, 40);
    expect(readLocatedCounter(returned, locator.locate(returned, 4)!)).toBe(117);
    expect(locator.searches).toBe(1);
    expect(locator.localRecoveries).toBe(1);
  }, 30_000);
  test("retries initial acquisition once per second and starts fresh for another video", () => {
    const fps = 4, locator = new HudLocator(fps);
    const frame = canvas(2, 640, 360, 0.5, 400, 40);
    const hidden = { ...frame, data: new Uint8Array(frame.data.length) };
    for (let i = 0; i < fps; i++) expect(locator.locate(hidden, i)).toBeNull();
    expect(locator.searches).toBe(1);
    expect(readLocatedCounter(frame, locator.locate(frame, fps)!)).toBe(103);
    expect(locator.searches).toBe(2);
    for (let i = fps + 1; i <= 3 * fps; i++) expect(locator.locate(hidden, i)).toBeNull();
    expect(locator.searches).toBe(2);
    const other = new HudLocator(fps), moved = canvas(3, 640, 360, 0.5, 60, 220);
    expect(readLocatedCounter(moved, other.locate(moved, 0)!)).toBe(117);
    expect(other.searches).toBe(1);
  }, 30_000);
  test("unreadable digits recalibrate scale inside the known area", () => {
    const locator = new HudLocator(30);
    const first = canvas(2, 640, 360, 1, 350, 40);
    const firstAnchor = locator.locate(first, 0);
    expect(firstAnchor).not.toBeNull();
    locator.invalidate();
    const rescaled = canvas(3, 640, 360, 1.125, 350, 40);
    const anchor = locator.locate(rescaled, 1);
    expect(anchor).not.toBeNull();
    expect(readLocatedCounter(rescaled, anchor!)).toBe(117);
    expect(anchor!.scale).toBeGreaterThan(firstAnchor!.scale);
    expect(locator.searches).toBe(1);
  }, 30_000);
});
describe("streaming and numerical boundaries", () => {
  test("RMS keeps complete windows and discards a partial final window", () => {
    const pcm = new Float32Array(900).fill(0.5),
      accumulator = new RMSAccumulator(400);
    accumulator.push(new Uint8Array(pcm.buffer, 0, 1200));
    accumulator.push(new Uint8Array(pcm.buffer, 1200));
    expect(accumulator.values).toHaveLength(2);
    expect(accumulator.values[0]).toBeCloseTo(-6.0206, 4);
    const invalid = new RMSAccumulator();
    expect(() =>
      invalid.push(new Uint8Array(new Float32Array([NaN]).buffer)),
    ).toThrow();
  });
  test("overview retains narrow energy peaks", () => {
    const values = Array(10000).fill(-60);
    values[1234] = -1;
    const curve = audioCurve(values, 25, 100);
    expect(curve).toHaveLength(100);
    expect(curve[12].max).toBe(-1);
    expect(curve[12].min).toBe(-60);
  });
  test("FFT normalized correlation agrees with a direct calculation", () => {
    const data = Float32Array.from(
      { length: 200 * 180 },
      (_, i) => (Math.sin(i * 8.1) + Math.cos(i * 3.23)) * 50 + 100,
    );
    const template = {
      data: new Float32Array(21 * 19),
      width: 21,
      height: 19,
      channels: 1,
    };
    for (let y = 0; y < 19; y++)
      template.data.set(
        data.subarray((y + 50) * 200 + 70, (y + 50) * 200 + 91),
        y * 21,
      );
    const scores = new Matcher({
      data,
      width: 200,
      height: 180,
      channels: 1,
    }).scores(template);
    expect(scores.data[50 * scores.width + 70]).toBeCloseTo(1, 5);
    const zero = new Matcher({
      data: new Float32Array(data.length),
      width: 200,
      height: 180,
      channels: 1,
    }).scores(template);
    expect(zero.data.every((v) => v === 0)).toBe(true);
  });
  test("frame-aligned intervals and invalid settings", () => {
    const interval = frameInterval(
      {
        start: 0.101,
        end: 0.301,
        raw_start: 0,
        raw_end: 0,
        event_count: 1,
        peak_dbfs: 0,
      },
      {
        duration: 1,
        fps: 60,
        width: 1920,
        height: 1080,
        hasAudio: true,
        videoCodec: "h264",
      },
    );
    expect(interval.frames).toBe(12);
    expect(interval.start).toBeCloseTo(7 / 60, 9);
    expect(() =>
      validateSettings({
        mode: "damage",
        audio: audioDefaults,
        damage: { ...damageDefaults, gap_s: NaN },
      }),
    ).toThrow();
  });
});
