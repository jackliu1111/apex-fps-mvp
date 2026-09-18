import templates from "../assets/templates.json";
import {
  type Image,
  type Region,
  Matcher,
  resize,
  sample,
  cropGray,
  grayscale,
} from "./image";
import {
  type DamageEvent,
  type Clip,
  type DamageOptions,
  round,
} from "../shared";

export const methods = ["white_180", "gray_otsu", "white_otsu"] as const;
type Method = (typeof methods)[number];
export const banks: Record<string, Uint8Array[]> = Object.fromEntries(
  methods.map((method) => [
    method,
    Array.from({ length: 10 }, (_, n) => {
      const hex =
          templates.TEMPLATES[
            `${method}_${n}` as keyof typeof templates.TEMPLATES
          ],
        bytes = Buffer.from(hex, "hex");
      return Uint8Array.from(
        { length: 600 },
        (_, i) => (bytes[i >> 3] >> (7 - (i % 8))) & 1,
      );
    }),
  ]),
);
const icons: Image[] = templates.LOCATION_ICONS.map((hex) => ({
  data: new Uint8Array(Buffer.from(hex, "hex")),
  width: 64,
  height: 38,
  channels: 1,
}));
export interface Anchor {
  x: number;
  y: number;
  scale: number;
  score: number;
}
// Anchors stay in original-video coordinates when FFmpeg supplies only a crop.
export interface HudFrame extends Image {
  origin?: { x: number; y: number };
}
// Favor recall: a plausible icon is enough to attempt reading the digits.
const ICON_MIN_SCORE = 0.60;
const resized = new Map<string, Image>();
function search(
  gray: Image,
  scales: number[],
  origin = { x: 0, y: 0 },
  peaks = 1,
): Anchor[] {
  const matcher = new Matcher(gray),
    hits: Anchor[] = [],
    seen = new Set<string>();
  for (const scale of scales) {
    const w = Math.round(64 * scale),
      h = Math.round(38 * scale),
      size = `${w}:${h}`;
    if (w < 8 || h < 5 || seen.has(size) || w > gray.width || h > gray.height)
      continue;
    seen.add(size);
    for (let k = 0; k < icons.length; k++) {
      const key = `${k}:${size}`;
      if (!resized.has(key)) resized.set(key, resize(icons[k], w, h));
      const scores = matcher.scores(resized.get(key)!, key);
      for (let p = 0; p < peaks && scores.data.length; p++) {
        let best = 0;
        for (let i = 1; i < scores.data.length; i++)
          if (scores.data[i] > scores.data[best]) best = i;
        const x = best % scores.width,
          y = Math.floor(best / scores.width);
        hits.push({
          x: x + origin.x,
          y: y + origin.y,
          scale: w / 64,
          score: scores.data[best],
        });
        for (
          let yy = Math.max(0, y - h);
          yy <= Math.min(scores.height - 1, y + h);
          yy++
        )
          scores.data.fill(
            -1,
            yy * scores.width + Math.max(0, x - w),
            yy * scores.width + Math.min(scores.width, x + w + 1),
          );
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}
export class HudLocator {
  anchor: Anchor | null = null;
  private lastAnchor: Anchor | null = null;
  private recalibrateScale = false;
  private nextSearch = 0;
  private missedSearches = 0;
  searches = 0;
  localRecoveries = 0;
  locatedFrames = 0;
  constructor(private fps: number) {}
  seed(anchor: Anchor) {
    this.anchor = this.lastAnchor = { ...anchor };
  }
  // Covers every local search and the digit band. An extra search radius gives
  // the supply crop room for nearby movement without changing matching bounds.
  searchRegion(width: number, height: number, withMargin = false): Region | null {
    const a = this.lastAnchor;
    if (!a) return null;
    const radius = Math.max(24, 192 * a.scale) * (withMargin ? 2 : 1),
      x = Math.max(0, Math.floor(a.x - radius)),
      y = Math.max(0, Math.floor(a.y - radius)),
      // A recovered icon may sit at the rightmost search position. Include
      // its complete digit band at the largest scale the local retry can test.
      right = Math.min(width, Math.ceil(a.x + 64 * a.scale + radius +
        120 * Math.min(2, a.scale * 1.15) + 2)),
      bottom = Math.min(height, Math.ceil(a.y + 38 * a.scale + radius));
    return { x, y, width: right - x, height: bottom - y };
  }
  // Unreadable digits can drop the active track, but the acquired area stays
  // locked for this video. Recovery must never enable another global search.
  invalidate() {
    this.anchor = null;
    this.recalibrateScale = true;
    this.nextSearch = 0;
    this.missedSearches = 0;
  }
  private accept(anchor: Anchor): Anchor {
    this.anchor = this.lastAnchor = anchor;
    this.missedSearches = 0;
    this.locatedFrames++;
    return anchor;
  }
  private refine(
    frame: HudFrame,
    anchor: Anchor,
    radius: number,
    varyScale = true,
  ): Anchor | undefined {
    const s = anchor.scale,
      ox = frame.origin?.x ?? 0,
      oy = frame.origin?.y ?? 0,
      x = Math.max(ox, Math.floor(anchor.x - radius)),
      y = Math.max(oy, Math.floor(anchor.y - radius));
    const x1 = Math.min(ox + frame.width, Math.ceil(anchor.x + 64 * s + radius)),
      y1 = Math.min(oy + frame.height, Math.ceil(anchor.y + 38 * s + radius));
    if (x1 <= x || y1 <= y) return undefined;
    const scales = (
      varyScale
        ? Array.from({ length: 13 }, (_, i) => s * (0.85 + (0.3 * i) / 12))
        : [s]
    ).filter((v) => v >= 0.25 && v <= 2);
    return search(cropGray(frame, x - ox, y - oy, x1 - x, y1 - y), scales, { x, y })[0];
  }
  locate(frame: HudFrame, index: number): Anchor | null {
    for (const hit of this.candidateAnchors(frame, index)) {
      if (this.lastAnchor || readLocatedCounter(frame, hit) !== null)
        return this.accept(hit);
    }
    return null;
  }
  // Production OCR acquisition validates candidates with the supplied reader;
  // digit templates are only retained for the legacy detector above.
  async locateAndRead(frame: HudFrame, index: number,
    read: (anchor: Anchor) => Promise<number | null>): Promise<{ anchor: Anchor; value: number | null } | null> {
    for (const hit of this.candidateAnchors(frame, index)) {
      const value = await read(hit);
      if (this.lastAnchor || value !== null)
        return { anchor: this.accept(hit), value };
    }
    return null;
  }
  private *candidateAnchors(frame: HudFrame, index: number): Generator<Anchor> {
    if (frame.origin && !this.lastAnchor)
      throw new Error("首次 HUD 定位需要完整画面");
    const tracking = this.anchor !== null;
    if (this.anchor) {
      const hit = this.refine(
        frame,
        this.anchor,
        Math.max(12, 64 * this.anchor.scale),
        false,
      );
      if (hit && hit.score >= ICON_MIN_SCORE) {
        yield hit;
        return;
      }
      this.anchor = null;
    }
    // Keep the last location through missing HUD frames. Check it at the
    // sampling rate, even while a wider local retry is deferred.
    if (!tracking && this.lastAnchor) {
      // If the icon matched but digits stayed unreadable, recheck its scale
      // locally instead of accepting the same stale scale indefinitely.
      const hit = this.refine(
        frame,
        this.lastAnchor,
        Math.max(12, 64 * this.lastAnchor.scale),
        this.recalibrateScale,
      );
      this.recalibrateScale = false;
      if (hit && hit.score >= ICON_MIN_SCORE) {
        this.localRecoveries++;
        this.nextSearch = index + Math.max(1, Math.round(this.fps));
        yield hit;
        return;
      }
    }
    if (index < this.nextSearch) return;
    // Once acquired, stay near the known HUD for the rest of this video.
    // Wider local retries back off, while the narrow check above runs per frame.
    if (this.lastAnchor) {
      const retrySeconds = 2 ** Math.min(this.missedSearches, 2);
      this.nextSearch = index + Math.max(1, Math.round(this.fps * retrySeconds));
      this.missedSearches++;
      const hit = this.refine(
        frame,
        this.lastAnchor,
        Math.max(24, 192 * this.lastAnchor.scale),
      );
      if (hit && hit.score >= ICON_MIN_SCORE) {
        this.localRecoveries++;
        this.nextSearch = index + Math.max(1, Math.round(this.fps));
        yield hit;
        return;
      }
      return;
    }
    // Global search is only used until the first successful acquisition.
    this.nextSearch = index + Math.max(1, Math.round(this.fps));
    this.searches++;
    const ratio = Math.min(1, 960 / Math.max(frame.width, frame.height));
    const gray = grayscale(
      resize(
        frame,
        Math.round(frame.width * ratio),
        Math.round(frame.height * ratio),
      ),
    );
    const scales = [
      ...new Set([
        ...Array.from({ length: 29 }, (_, i) => 0.25 * 8 ** (i / 28)),
        1 / 3,
        0.5,
        2 / 3,
        1,
        1.5,
        2,
      ]),
    ].sort((a, b) => a - b);
    const candidates = search(
        gray,
        scales.map((s) => s * ratio),
        undefined,
        2,
      ),
      distinct: Anchor[] = [];
    for (const c of candidates) {
      if (
        !distinct.some(
          (h) => Math.abs(c.x - h.x) + Math.abs(c.y - h.y) < 24 * h.scale,
        )
      )
        distinct.push(c);
      if (distinct.length === 6) break;
    }
    const refined: Anchor[] = [];
    for (const c of distinct) {
      if (c.score < 0.4) break;
      const hit = this.refine(
        frame,
        { ...c, x: c.x / ratio, y: c.y / ratio, scale: c.scale / ratio },
        Math.max(6, 4 / ratio),
      );
      if (hit && hit.score >= ICON_MIN_SCORE) refined.push(hit);
    }
    refined.sort((a, b) => b.score - a.score);
    // Acquiring an icon permanently locks the search area for this video.
    // Require a digit candidate before committing: scenery/UI can resemble an
    // icon while its adjacent band is empty. Try every refined candidate so an
    // unreadable higher-scoring lookalike cannot hide the real counter.
    this.nextSearch = index + Math.max(1, Math.round(this.fps));
    yield* refined;
  }
}
function otsu(values: Float64Array): number {
  const histogram = new Float64Array(256);
  for (const value of values)
    histogram[Math.max(0, Math.min(255, Math.floor(value)))]++;
  let mean = 0;
  for (let i = 0; i < 256; i++) mean += (i * histogram[i]) / values.length;
  let w = 0,
    mu = 0,
    best = -1,
    threshold = 0;
  for (let i = 0; i < 256; i++) {
    const p = histogram[i] / values.length;
    w += p;
    mu += p * i;
    const score = (mean * w - mu) ** 2 / Math.max(w * (1 - w), 1e-10);
    if (score > best) {
      best = score;
      threshold = i;
    }
  }
  return threshold;
}
function binary(image: Image, method: Method): Uint8Array {
  const n = image.width * image.height,
    low = new Float64Array(n),
    gray = new Float64Array(n),
    chroma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = image.data[i * 3],
      g = image.data[i * 3 + 1],
      b = image.data[i * 3 + 2];
    low[i] = Math.min(r, g, b);
    gray[i] = (r + g + b) / 3;
    chroma[i] = Math.max(r, g, b) - low[i];
  }
  const threshold =
    method === "white_180"
      ? 180
      : method === "gray_otsu"
        ? otsu(gray)
        : Math.max(140, otsu(low));
  return Uint8Array.from({ length: n }, (_, i) =>
    Number(
      method === "gray_otsu"
        ? gray[i] > threshold
        : low[i] > threshold && chroma[i] < 75,
    ),
  );
}
function normalize(
  mask: Uint8Array,
  width: number,
  height: number,
  left: number,
  right: number,
): Uint8Array | null {
  let top = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = left; x <= right; x++) count += mask[y * width + x];
    if (count >= 4) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;
  let x0 = right,
    x1 = left,
    y0 = bottom,
    y1 = top,
    count = 0;
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++)
      if (mask[y * width + x]) {
        count++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (count < 8) return null;
  const glyph = new Uint8Array(600);
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 20; x++)
      glyph[y * 20 + x] =
        mask[
          (y0 + Math.floor((y * (y1 - y0)) / 29)) * width +
            x0 +
            Math.floor((x * (x1 - x0)) / 19)
        ];
  return glyph;
}
export function readLocatedCounter(
  frame: HudFrame,
  anchor: Anchor,
): number | null {
  const ys = Array.from(
    { length: 31 },
    (_, i) => anchor.y + (i + 4.5) * anchor.scale - 0.5 - (frame.origin?.y ?? 0),
  );
  const xs = Array.from(
    { length: 120 },
    (_, i) => anchor.x + (i + 64.5) * anchor.scale - 0.5 - (frame.origin?.x ?? 0),
  ).filter((x) => x <= frame.width - 1);
  if (ys[0] < 0 || ys.at(-1)! > frame.height - 1 || xs.length < 6 || xs[0] < 0)
    return null;
  const sampled = sample(frame, xs, ys),
    band = {
      ...sampled,
      data: Uint8Array.from(sampled.data, (v) => Math.max(0, Math.min(255, v))),
    };
  const votes = new Set<number>();
  for (const method of methods) {
    const mask = binary(band, method),
      runs: number[][] = [];
    for (let x = 0; x < band.width; x++) {
      let count = 0;
      for (let y = 0; y < band.height; y++) count += mask[y * band.width + x];
      if (count <= 2) continue;
      const last = runs.at(-1);
      if (last && last[1] === x - 1) last[1] = x;
      else runs.push([x, x]);
    }
    const digits: number[] = [];
    let previousEnd = 0,
      valid = true;
    for (const [start, end] of runs) {
      if (digits.length && start - previousEnd > 12) break;
      if (
        (!digits.length && start > 12) ||
        end === band.width - 1 ||
        end - start + 1 < 6 ||
        end - start + 1 > 21
      ) {
        valid = false;
        break;
      }
      const g = normalize(mask, band.width, band.height, start, end);
      if (!g) {
        valid = false;
        break;
      }
      const scores = banks[method]
        .map((t, digit) => {
          let intersection = 0,
            union = 0;
          for (let i = 0; i < 600; i++) {
            intersection += g[i] & t[i];
            union += g[i] | t[i];
          }
          return { digit, score: intersection / Math.max(1, union) };
        })
        .sort((a, b) => b.score - a.score || b.digit - a.digit);
      // A segmented glyph counts as a match even when its best template is weak
      // or ambiguous. The candidate is for review, not a verified damage total.
      digits.push(scores[0].digit);
      previousEnd = end;
    }
    if (valid && digits.length >= 1 && digits.length <= 5)
      votes.add(Number(digits.join("")));
  }
  // Different binarizations may disagree; retain the largest complete reading.
  return votes.size ? Math.max(...votes) : null;
}
export class CounterTracker {
  constructor(private breakOnDecrease = false) {}
  private baseline: number | null = null;
  private pending: number | null = null;
  private repeats = 0;
  private pendingTime = 0;
  update(time: number, value: number | null): DamageEvent | null {
    if (value === null) {
      this.baseline = null;
      this.pending = null;
      this.repeats = 0;
      return null;
    }
    if (this.breakOnDecrease && ((this.baseline !== null && value < this.baseline) ||
        (this.pending !== null && value < this.pending)))
      this.baseline = null;
    if (this.pending === value) this.repeats++;
    else {
      this.pending = value;
      this.pendingTime = time;
      this.repeats = 1;
    }
    if (this.repeats !== 2) return null;
    const previous = this.baseline;
    this.baseline = value;
    return previous !== null && value > previous
      ? {
          time: round(this.pendingTime),
          previous,
          value,
          increase: value - previous,
        }
      : null;
  }
}
export function damageClips(
  events: DamageEvent[],
  duration: number,
  options: DamageOptions & { sampling_fps?: number },
): Clip[] {
  const groups: DamageEvent[][] = [];
  for (const e of events) {
    const g = groups.at(-1);
    if (g && e.time - g.at(-1)!.time <= options.gap_s + 1e-8) g.push(e);
    else groups.push([e]);
  }
  const clips: Clip[] = [];
  for (const g of groups) {
    const a = g[0].time,
      b = g.at(-1)!.time;
    const clip: Clip = {
      start: Math.max(0, a - options.before_s),
      end: Math.min(
        duration,
        Math.max(b + options.after_s, a + 1 / (options.sampling_fps ?? 30)),
      ),
      raw_start: a,
      raw_end: b,
      event_count: g.length,
      peak_dbfs: 0,
    };
    if (clip.end <= clip.start) continue;
    const previous = clips.at(-1);
    if (previous && clip.start <= previous.end + 1e-8) {
      previous.end = Math.max(previous.end, clip.end);
      previous.raw_end = b;
      previous.event_count += g.length;
    } else clips.push(clip);
  }
  return clips;
}
