import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import workerSource from './ocr/paddle_worker.py' with { type: 'text' };
import type { Anchor } from './core/damage';
import type { Image, Region } from './core/image';
import type { WorkerEvent } from './shared';
import { checkCancelled } from './media';

export interface OCRObservation {
  value: number | null;
  text: string;
  score: number | null;
  status: string;
  model: string;
  region: Region | null;
  frame_path: string;
  input_path: string | null;
  metadata_path: string;
  elapsed_ms: number;
}
export interface CounterReader {
  read(frame: Image, anchor: Anchor | null, time: number, frameIndex: number, attempt: number): Promise<OCRObservation>;
  close(): Promise<void>;
}

// Integer, half-open bounds in original pixels. The box, PNG and OCR input
// share these exact bounds; never rescale to the old 120x31 template grid.
export function counterRegion(frame: Image, anchor: Anchor): Region | null {
  const x = Math.max(0, Math.floor(anchor.x + 64 * anchor.scale));
  const y = Math.max(0, Math.floor(anchor.y + 4 * anchor.scale));
  let right = Math.min(frame.width, Math.ceil(anchor.x + 184 * anchor.scale));
  const bottom = Math.min(frame.height, Math.ceil(anchor.y + 35 * anchor.scale));
  // The old wide band can include the HUD's slanted border (OCR reads it as
  // '/'). Stop at a large blank gap after the first white text group. This is
  // only crop geometry: PaddleOCR still reads the original RGB string, with
  // no glyph classification, digit templates or masks supplied to the model.
  const occupied: number[] = [];
  if (frame.channels === 3) for (let xx = x; xx < right; xx++) {
    let count = 0;
    for (let yy = y; yy < bottom; yy++) {
      const p = (yy * frame.width + xx) * 3;
      const low = Math.min(frame.data[p], frame.data[p + 1], frame.data[p + 2]);
      const high = Math.max(frame.data[p], frame.data[p + 1], frame.data[p + 2]);
      if (low > 180 && high - low < 75) count++;
    }
    if (count > Math.max(2, Math.floor((bottom - y) * .1))) occupied.push(xx);
  }
  if (occupied.length && occupied[0] - x <= 12 * anchor.scale) {
    let end = occupied[0];
    for (const xx of occupied.slice(1)) {
      if (xx - end > 12 * anchor.scale) break;
      end = xx;
    }
    right = Math.min(right, end + 1 + Math.max(2, Math.ceil(2 * anchor.scale)));
  }
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export async function createPaddleReader(debugDir: string, signal: AbortSignal,
  emit: (event: WorkerEvent) => void): Promise<CounterReader> {
  checkCancelled(signal);
  const project = resolve(import.meta.dir, '..');
  const localPython = join(project, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const bundledPython = join(dirname(process.execPath), 'ocr-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.APEX_OCR_PYTHON || [localPython, bundledPython].find(existsSync);
  if (!python) throw new Error('PaddleOCR 环境未安装：请按 typescript/docs/paddleocr-debug.md 配置 .venv-ocr，或设置 APEX_OCR_PYTHON；不会回退到数字模板。');
  await mkdir(debugDir, { recursive: true });
  const script = join(debugDir, '_paddle_worker.py');
  await Bun.write(script, workerSource);
  const cache = process.env.APEX_OCR_CACHE_DIR || (existsSync(localPython)
    ? join(project, '.paddleocr-cache') : join(dirname(debugDir), 'paddleocr-cache'));
  const child = Bun.spawn([python, '-u', script, debugDir], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PADDLE_PDX_CACHE_HOME: cache,
      HF_HOME: join(cache, 'huggingface'), PADDLE_HOME: join(cache, 'paddle'),
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
      PADDLE_PDX_MODEL_SOURCE: process.env.PADDLE_PDX_MODEL_SOURCE || 'bos' },
  });
  emit({ type: 'pid', pid: child.pid, active: true });
  const kill = () => { try { child.kill(); } catch {} };
  signal.addEventListener('abort', kill, { once: true });
  if (signal.aborted) kill();
  let errors = '', pending = '', sequence = 0, closed = false;
  const decoder = new TextDecoder(), stdout = child.stdout.getReader();
  const stderr = (async () => {
    const decoder = new TextDecoder();
    for await (const bytes of child.stderr) {
      const text = decoder.decode(bytes, { stream: true });
      errors = (errors + text).slice(-16000);
      await appendFile(join(debugDir, 'engine.log'), text);
    }
  })();
  async function line(): Promise<any> {
    while (!pending.includes('\n')) {
      const { value, done } = await stdout.read();
      checkCancelled(signal);
      if (done) {
        await stderr;
        throw new Error(`PaddleOCR 进程退出：${errors || '未返回识别结果'}`);
      }
      pending += decoder.decode(value, { stream: true });
    }
    const end = pending.indexOf('\n'), text = pending.slice(0, end);
    pending = pending.slice(end + 1);
    return JSON.parse(text);
  }
  async function receive(timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([line(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { kill(); reject(new Error(`PaddleOCR 超时：${errors}`)); }, timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function close() {
    if (closed) return;
    closed = true;
    kill();
    await child.exited;
    await stderr;
    signal.removeEventListener('abort', kill);
    emit({ type: 'pid', pid: child.pid, active: false });
  }
  try {
    const ready = await receive(180_000);
    if (!ready.ready) throw new Error('PaddleOCR 初始化协议错误');
  } catch (error) { await close(); throw error; }
  return {
    async read(frame, anchor, time, frameIndex, attempt) {
      checkCancelled(signal);
      if (frame.channels !== 3 || frame.data.length !== frame.width * frame.height * 3)
        throw new Error('PaddleOCR 需要完整 RGB 原图');
      const id = ++sequence;
      const request = { id, width: frame.width, height: frame.height,
        rgb: Buffer.from(frame.data).toString('base64'), anchor,
        region: anchor ? counterRegion(frame, anchor) : null,
        time, frame_index: frameIndex, attempt };
      child.stdin.write(JSON.stringify(request) + '\n');
      await child.stdin.flush();
      const response = await receive(60_000);
      checkCancelled(signal);
      if (response.id !== id) throw new Error('PaddleOCR 帧序号不一致');
      if (response.error) throw new Error(`PaddleOCR 识别失败：${response.error}`);
      return response.result as OCRObservation;
    },
    close,
  };
}
