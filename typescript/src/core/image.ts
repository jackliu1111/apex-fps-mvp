import FFT from "fft.js";
export interface Image {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  channels: number;
}
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function containsRegion(outer: Region, inner: Region): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}
export function sample(image: Image, xs: number[], ys: number[]): Image {
  const { data, width, height, channels } = image,
    out = new Float32Array(xs.length * ys.length * channels);
  for (let j = 0; j < ys.length; j++) {
    const y = Math.max(0, Math.min(height - 1, ys[j])),
      y0 = Math.floor(y),
      y1 = Math.min(y0 + 1, height - 1),
      wy = y - y0;
    for (let i = 0; i < xs.length; i++) {
      const x = Math.max(0, Math.min(width - 1, xs[i])),
        x0 = Math.floor(x),
        x1 = Math.min(x0 + 1, width - 1),
        wx = x - x0;
      for (let c = 0; c < channels; c++)
        out[(j * xs.length + i) * channels + c] =
          (data[(y0 * width + x0) * channels + c] * (1 - wx) +
            data[(y0 * width + x1) * channels + c] * wx) *
            (1 - wy) +
          (data[(y1 * width + x0) * channels + c] * (1 - wx) +
            data[(y1 * width + x1) * channels + c] * wx) *
            wy;
    }
  }
  return { data: out, width: xs.length, height: ys.length, channels };
}
export function resize(image: Image, width: number, height: number): Image {
  return sample(
    image,
    Array.from(
      { length: width },
      (_, i) => ((i + 0.5) * image.width) / width - 0.5,
    ),
    Array.from(
      { length: height },
      (_, i) => ((i + 0.5) * image.height) / height - 0.5,
    ),
  );
}
export function grayscale(image: Image): Image {
  if (image.channels === 1) return image;
  const data = new Float32Array(image.width * image.height);
  for (let i = 0; i < data.length; i++)
    data[i] =
      (image.data[i * 3] + image.data[i * 3 + 1] + image.data[i * 3 + 2]) / 3;
  return { data, width: image.width, height: image.height, channels: 1 };
}
export function cropGray(
  image: Image,
  x: number,
  y: number,
  width: number,
  height: number,
): Image {
  const data = new Float32Array(width * height),
    channels = image.channels;
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const p = ((j + y) * image.width + x + i) * channels;
      data[j * width + i] =
        channels === 1
          ? image.data[p]
          : (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
    }
  return { data, width, height, channels: 1 };
}
function power2(n: number) {
  let x = 2;
  while (x < n) x *= 2;
  return x;
}
class Fourier2D {
  w: number;
  h: number;
  private row: FFT;
  private column: FFT;
  constructor(width: number, height: number) {
    this.w = power2(width);
    this.h = power2(height);
    this.row = new FFT(this.w);
    this.column = new FFT(this.h);
  }
  transform(values: Float64Array, inverse = false): Float64Array {
    const intermediate = new Float64Array(values.length),
      out = new Float64Array(values.length);
    const a = new Float64Array(this.h * 2),
      b = new Float64Array(this.h * 2);
    for (let y = 0; y < this.h; y++) {
      const from = values.subarray(y * this.w * 2, (y + 1) * this.w * 2),
        to = intermediate.subarray(y * this.w * 2, (y + 1) * this.w * 2);
      if (inverse) this.row.inverseTransform(to, from);
      else this.row.transform(to, from);
    }
    for (let x = 0; x < this.w; x++) {
      for (let y = 0; y < this.h; y++) {
        a[y * 2] = intermediate[(y * this.w + x) * 2];
        a[y * 2 + 1] = intermediate[(y * this.w + x) * 2 + 1];
      }
      if (inverse) this.column.inverseTransform(b, a);
      else this.column.transform(b, a);
      for (let y = 0; y < this.h; y++) {
        out[(y * this.w + x) * 2] = b[y * 2];
        out[(y * this.w + x) * 2 + 1] = b[y * 2 + 1];
      }
    }
    return out;
  }
  forward(image: Image): Float64Array {
    const values = new Float64Array(this.w * this.h * 2);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        values[(y * this.w + x) * 2] = image.data[y * image.width + x];
    return this.transform(values);
  }
}
const templateTransforms = new Map<string, Float64Array>();
let cacheBytes = 0;
export class Matcher {
  private sums: Float64Array;
  private squares: Float64Array;
  private fft?: Fourier2D;
  private spectrum?: Float64Array;
  constructor(private gray: Image) {
    const stride = gray.width + 1;
    this.sums = new Float64Array(stride * (gray.height + 1));
    this.squares = new Float64Array(this.sums.length);
    for (let y = 0; y < gray.height; y++) {
      let s = 0,
        q = 0;
      for (let x = 0; x < gray.width; x++) {
        const v = gray.data[y * gray.width + x];
        s += v;
        q += Math.fround(v * v);
        const p = (y + 1) * stride + x + 1;
        this.sums[p] = this.sums[p - stride] + s;
        this.squares[p] = this.squares[p - stride] + q;
      }
    }
  }
  scores(
    template: Image,
    key?: string,
  ): { data: Float32Array; width: number; height: number } {
    const { width: tw, height: th } = template,
      width = this.gray.width - tw + 1,
      height = this.gray.height - th + 1;
    if (width <= 0 || height <= 0)
      return { data: new Float32Array(), width: 0, height: 0 };
    const count = tw * th,
      centered = new Float32Array(count);
    let mean = 0;
    for (const v of template.data) mean += v;
    mean /= count;
    let energy = 0;
    for (let i = 0; i < count; i++) {
      centered[i] = template.data[i] - mean;
      energy += centered[i] * centered[i];
    }
    const direct = width * height * count <= 4_000_000;
    let corr: Float64Array | undefined;
    if (!direct) {
      if (!this.fft) {
        this.fft = new Fourier2D(this.gray.width, this.gray.height);
        this.spectrum = this.fft.forward(this.gray);
      }
      const cacheKey = key ? `${this.fft.w}:${this.fft.h}:${key}` : "";
      let tf = templateTransforms.get(cacheKey);
      if (!tf) {
        tf = this.fft.forward({
          data: centered,
          width: tw,
          height: th,
          channels: 1,
        });
        if (cacheKey && tf.byteLength <= 8_000_000) {
          while (
            cacheBytes + tf.byteLength > 32_000_000 &&
            templateTransforms.size
          ) {
            const first = templateTransforms.keys().next().value!;
            cacheBytes -= templateTransforms.get(first)!.byteLength;
            templateTransforms.delete(first);
          }
          templateTransforms.set(cacheKey, tf);
          cacheBytes += tf.byteLength;
        }
      }
      const product = new Float64Array(tf.length),
        f = this.spectrum!;
      for (let i = 0; i < product.length; i += 2) {
        product[i] = f[i] * tf[i] + f[i + 1] * tf[i + 1];
        product[i + 1] = f[i + 1] * tf[i] - f[i] * tf[i + 1];
      }
      corr = this.fft.transform(product, true);
    }
    const data = new Float32Array(width * height),
      stride = this.gray.width + 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const tl = y * stride + x,
          tr = tl + tw,
          bl = (y + th) * stride + x,
          br = bl + tw;
        const sum =
          this.sums[br] - this.sums[tr] - this.sums[bl] + this.sums[tl];
        const variance =
          this.squares[br] -
          this.squares[tr] -
          this.squares[bl] +
          this.squares[tl] -
          (sum * sum) / count;
        if (variance <= count * 4 || energy <= 0) continue;
        let numerator = 0;
        if (direct) {
          for (let j = 0; j < th; j++)
            for (let i = 0; i < tw; i++)
              numerator +=
                this.gray.data[(y + j) * this.gray.width + x + i] *
                centered[j * tw + i];
        } else numerator = corr![(y * this.fft!.w + x) * 2];
        data[y * width + x] =
          numerator / Math.max(Math.sqrt(variance * energy), 1e-6);
      }
    return { data, width, height };
  }
}
