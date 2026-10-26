import * as ort from '/assets/vendor/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('/assets/vendor/', self.location).href;
ort.env.wasm.numThreads = 1;
let session;
self.onmessage = async ({ data }) => {
  try {
    if (!session) {
      self.postMessage({ type: 'status', message: '正在加载 BEATs 模型（约 356 MiB）…' });
      session = await ort.InferenceSession.create('/assets/beats.onnx', { executionProviders: ['wasm'] });
    }
    const input = new ort.Tensor('float32', data.waveform, [1, 160000]);
    let output;
    try { output = await session.run({ waveform: input }); }
    finally { input.dispose(); }
    const values = new Float32Array(output.probabilities.data);
    output.probabilities.dispose();
    self.postMessage({ id: data.id, type: 'result', values }, [values.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, type: 'error', message: String(error.stack || error) });
  }
};
