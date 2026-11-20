import * as ort from '/assets/vendor/ort.wasm.min.mjs';
import { createSedFrontend } from './efficientsed-frontend.mjs';
import { loadCachedModel } from './model-cache.mjs';
import { assetRecoveryHint, getModelSpec, resolveModelAssets } from './model-registry.mjs';

ort.env.wasm.wasmPaths = new URL('/assets/vendor/', self.location).href;
ort.env.wasm.numThreads = 1;

const FRONTEND_LOADERS = {
  efficientsed: createSedFrontend,
};

let session, frontend, loadedKey;

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
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const rawLength = response.headers.get('Content-Length');
    const hasLength = rawLength !== null;
    const total = hasLength ? Number(rawLength) : null;
    if (hasLength && (!Number.isSafeInteger(total) || total <= 0)) throw new Error('模型响应缺少有效文件大小');
    const reader = response.body.getReader();
    const bytes = hasLength ? new Uint8Array(total) : null;
    const chunks = hasLength ? null : [];
    let received = 0, lastUpdate = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetDeadline();
      if (hasLength) {
        if (received + value.length > total) throw new Error('模型文件大小与响应不一致');
        bytes.set(value, received);
      } else {
        chunks.push(value);
      }
      received += value.length;
      if (performance.now() - lastUpdate > 250 || (hasLength && received === total)) {
        self.postMessage({ type: 'status', progress: hasLength ? received / total : null,
          message: hasLength
            ? `正在下载模型：${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`
            : `正在下载模型：${(received / 1048576).toFixed(1)} MiB` });
        lastUpdate = performance.now();
      }
    }
    if (hasLength && received !== total) throw new Error(`模型读取不完整：${received} / ${total} 字节`);
    if (hasLength) return bytes;
    const assembled = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { assembled.set(chunk, offset); offset += chunk.length; }
    return assembled;
  } catch (error) {
    controller.abort();
    const hint = error.status === 404
      ? assetRecoveryHint(404, url)
      : '请确认静态预览服务仍在运行，然后重试。';
    throw new Error(`模型文件读取失败：${error.name === 'AbortError' ? '连续 30 秒未收到数据' : error.message}。${hint}`);
  } finally { clearTimeout(timer); }
}

self.onmessage = async ({ data }) => {
  try {
    const spec = data.spec || getModelSpec(data.model);
    const assets = resolveModelAssets(spec, data.manifest, self.location.href);
    const createFrontend = FRONTEND_LOADERS[spec.frontendType];
    if (!createFrontend) throw new Error(`未知前处理类型：${spec.frontendType}`);
    const requestKey = `${spec.id}:${data.manifest?.sha256 || ''}:${assets.onnxUrl}`;
    const cold = !session || loadedKey !== requestKey;
    const timings = { readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0, cold };
    if (cold) {
      await session?.release?.().catch(() => {});
      session = null;
      frontend = null;
      loadedKey = null;
      let started = performance.now();
      const bytes = await loadCachedModel({
        url: assets.onnxUrl,
        manifest: data.manifest,
        download: readModel,
        onStatus: message => self.postMessage({ type: 'status', progress: null, message }),
      });
      if (assets.frontendUrl) {
        const response = await fetch(assets.frontendUrl);
        if (!response.ok) {
          throw new Error(`无法读取模型前处理常量（HTTP ${response.status}）：${assets.frontendUrl}。${assetRecoveryHint(response.status)}`);
        }
        frontend = createFrontend(await response.json());
      } else {
        frontend = createFrontend();
      }
      timings.readMs = performance.now() - started;
      self.postMessage({ type: 'status', progress: null, message: '模型读取完成，正在初始化 WASM 推理引擎…' });
      started = performance.now();
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      loadedKey = requestKey;
      timings.initializeMs = performance.now() - started;
    }
    self.postMessage({ type: 'status', progress: null, message: '模型已就绪，正在计算当前音频窗口…' });
    const frontendStarted = performance.now();
    const features = frontend(data.waveform);
    timings.frontendMs = assets.frontendUrl ? performance.now() - frontendStarted : 0;
    const input = new ort.Tensor('float32', features, [...spec.inputShape]);
    let output;
    const started = performance.now();
    try { output = await session.run({ [spec.inputName]: input }); }
    finally { input.dispose(); }
    timings.inferenceMs = performance.now() - started;
    const outputName = spec.outputName || 'probabilities';
    const tensor = output?.[outputName];
    if (!tensor) throw new Error(`模型输出缺少 ${outputName} 张量`);
    const dims = Array.from(tensor.dims || []);
    const values = new Float32Array(tensor.data);
    tensor.dispose();
    self.postMessage({ id: data.id, type: 'result', values, dims, timings }, [values.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, type: 'error', message: error?.message || String(error) });
  }
};
