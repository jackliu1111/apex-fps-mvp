import * as ort from '/assets/vendor/ort.wasm.min.mjs';
import { createFrontend } from './efficientat-frontend.js';

ort.env.wasm.wasmPaths = new URL('/assets/vendor/', self.location).href;
ort.env.wasm.numThreads = 1;
let session;
let frontend;
async function readModel(url) {
  const controller = new AbortController();
  let timer;
  const resetDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 30000);
  };
  resetDeadline();
  try {
    self.postMessage({ type: 'status', message: '正在连接模型文件…' });
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('模型响应缺少有效文件大小');
    const bytes = new Uint8Array(total);
    const reader = response.body.getReader();
    let received = 0, lastUpdate = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetDeadline();
      if (received + value.length > total) throw new Error('模型文件大小与响应不一致');
      bytes.set(value, received); received += value.length;
      if (performance.now() - lastUpdate > 250 || received === total) {
        self.postMessage({ type: 'status', progress: received / total,
          message: `正在读取模型：${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB` });
        lastUpdate = performance.now();
      }
    }
    if (received !== total) throw new Error(`模型读取不完整：${received} / ${total} 字节`);
    return bytes;
  } catch (error) {
    controller.abort();
    throw new Error(`模型文件读取失败：${error.name === 'AbortError' ? '连续 30 秒未收到数据' : error.message}。请确认静态预览服务仍在运行，然后重试。`);
  } finally { clearTimeout(timer); }
}
self.onmessage = async ({ data }) => {
  try {
    const small = data.model === 'efficientat';
    const timings = { readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0, cold: !session };
    if (!session) {
      let started = performance.now();
      const bytes = await readModel(small ? '/assets/efficientat/mn04.onnx' : '/assets/beats.onnx');
      if (small) {
        const response = await fetch('/assets/efficientat/frontend.json');
        if (!response.ok) throw new Error('无法读取 EfficientAT 前处理常量');
        frontend = createFrontend(await response.json());
      }
      timings.readMs = performance.now() - started;
      self.postMessage({ type: 'status', progress: null, message: '模型读取完成，正在初始化 WASM 推理引擎…' });
      started = performance.now();
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      timings.initializeMs = performance.now() - started;
    }
    self.postMessage({ type: 'status', progress: null, message: '模型已就绪，正在计算当前音频窗口…' });
    const frontendStarted = performance.now();
    const features = small ? frontend(data.waveform) : data.waveform;
    timings.frontendMs = small ? performance.now() - frontendStarted : 0;
    const input = new ort.Tensor('float32', features, small ? [1, 1, 128, 1000] : [1, 160000]);
    let output;
    const started = performance.now();
    try { output = await session.run(small ? { mel: input } : { waveform: input }); }
    finally { input.dispose(); }
    timings.inferenceMs = performance.now() - started;
    const values = new Float32Array(output.probabilities.data);
    output.probabilities.dispose();
    self.postMessage({ id: data.id, type: 'result', values, timings }, [values.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, type: 'error', message: String(error.stack || error) });
  }
};
