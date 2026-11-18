import * as ort from '/assets/vendor/ort.wasm.min.mjs';
import { createSedFrontend } from './efficientsed-frontend.mjs';
ort.env.wasm.wasmPaths = '/assets/vendor/';
ort.env.wasm.numThreads = 1;
let session, frontend;
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; }
self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'init') {
      const start = performance.now();
      const manifest = await (await get('/assets/efficientsed/model.json')).json();
      const bytes = await (await get(`/assets/efficientsed/${manifest.modelFile}`)).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== manifest.sha256 || bytes.byteLength !== manifest.bytes) throw new Error('Model checksum mismatch');
      frontend = createSedFrontend(await (await get('/assets/efficientsed/frontend.json')).json());
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      self.postMessage({ id, manifest, initializeMs: performance.now() - start });
    } else {
      const start = performance.now(), mel = frontend(data.waveform), frontendMs = performance.now() - start;
      const input = new ort.Tensor('float32', mel, [1, 1, 128, 1000]);
      const begin = performance.now();
      let output;
      try { output = await session.run({ mel: input }); } finally { input.dispose(); }
      const values = new Float32Array(output.probabilities.data), inferenceMs = performance.now() - begin;
      output.probabilities.dispose();
      self.postMessage({ id, values, frontendMs, inferenceMs }, [values.buffer]);
    }
  } catch (error) { self.postMessage({ id, error: String(error.stack || error) }); }
};
