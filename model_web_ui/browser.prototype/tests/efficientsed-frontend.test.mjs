import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSedFrontend } from '../../../site/efficientsed-frontend.mjs';
import { getModelSpec, validateInferenceOutput, validateModelManifest } from '../../../site/model-registry.mjs';

const REPO_SITE_ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../site/assets');

function readFloat32File(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.byteLength % 4, 0, `Expected Float32 byte alignment in ${filePath}`);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function resolveReferenceAssetsDir() {
  if (process.env.ASSETS_DIR) {
    return { dir: path.resolve(process.env.ASSETS_DIR), explicit: true };
  }
  for (const candidate of [REPO_SITE_ASSETS, '/tmp/apex-spec-38-assets', '/private/tmp/apex-browser-prototype-20261026/assets']) {
    if (fs.existsSync(path.join(candidate, 'efficientsed', 'reference-mel.f32'))) {
      return { dir: candidate, explicit: false };
    }
  }
  return { dir: null, explicit: false };
}

test('createSedFrontend rejects wrong sample count and normalizes silence to exact log floor', () => {
  const cfg = {
    fftSize: 8,
    hop: 4,
    samples: 16,
    frames: 3,
    window: new Array(8).fill(1),
    mel: [
      [1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
    ],
    logFloor: 1e-7,
  };
  const frontend = createSedFrontend(cfg);
  assert.throws(() => frontend(new Float32Array(15)), /EfficientSED requires 160000 samples/);

  const silenceOut = frontend(new Float32Array(16));
  assert.ok(silenceOut instanceof Float32Array);
  assert.equal(silenceOut.length, 2 * 3);
  const expectedSilence = Math.fround((Math.log(1e-7) + 4.5) / 5);
  for (let i = 0; i < silenceOut.length; i++) {
    assert.ok(Math.abs(silenceOut[i] - expectedSilence) < 1e-6);
  }
});

test('createSedFrontend matches analytical preemphasis, reflect padding, DFT power, and weighted mel log output', () => {
  // 8-point DFT with unit window and identity Mel rows for DC (bin 0), bin 2 (f = Fs/4), and Nyquist (bin 4).
  const cfg = {
    fftSize: 8,
    hop: 4,
    samples: 16,
    frames: 4,
    window: new Array(8).fill(1),
    mel: [
      [1, 0, 0, 0, 0],
      [0, 0, 0.5, 0, 0],
      [0, 0, 0, 0, 1],
    ],
    logFloor: 1e-7,
  };
  // Construct waveform so preemphasized signal equals cos(2*pi*2*n/8) = [1, 0, -1, 0, ...] across all 15 samples.
  const targetEmphasized = Array.from({ length: 15 }, (_, i) => [1, 0, -1, 0][i % 4]);
  const waveform = new Float32Array(16);
  for (let i = 0; i < targetEmphasized.length; i++) {
    waveform[i + 1] = targetEmphasized[i] + Math.fround(0.97) * waveform[i];
  }

  const mel = createSedFrontend(cfg)(waveform);
  assert.equal(mel.length, 3 * 4);

  // For x[n] = cos(2*pi*2*n/8) on all frames (even symmetric at n=0 and n=14 reflect boundaries):
  // |X[2]|^2 = (N/2)^2 = 16 -> weighted by 0.5 => 8 -> (ln(8) + 4.5) / 5
  const expectedBin2 = (Math.log(8) + 4.5) / 5;
  const expectedZero = (Math.log(1e-7) + 4.5) / 5;
  for (let frame = 0; frame < 4; frame++) {
    assert.ok(Math.abs(mel[0 * 4 + frame] - expectedZero) < 1e-4, `DC band at frame ${frame}`);
    assert.ok(Math.abs(mel[1 * 4 + frame] - expectedBin2) < 1e-4, `Bin-2 band at frame ${frame}: got ${mel[1 * 4 + frame]}`);
    assert.ok(Math.abs(mel[2 * 4 + frame] - expectedZero) < 1e-4, `Nyquist band at frame ${frame}`);
  }
});

const assets = resolveReferenceAssetsDir();
test('createSedFrontend matches PyTorch reference-mel.f32 and reference manifest/probabilities when EfficientSED assets are present', {
  skip: !assets.dir && 'EfficientSED reference assets not present (set ASSETS_DIR to enforce)',
}, () => {
  const sedDir = path.join(assets.dir, 'efficientsed');
  for (const required of ['frontend.json', 'model.json', 'reference-waveform.f32', 'reference-mel.f32', 'reference-probabilities.f32']) {
    const filePath = path.join(sedDir, required);
    assert.equal(fs.existsSync(filePath), true, `Missing required EfficientSED reference asset: ${filePath}`);
  }

  const frontendCfg = JSON.parse(fs.readFileSync(path.join(sedDir, 'frontend.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(sedDir, 'model.json'), 'utf8'));
  const waveform = readFloat32File(path.join(sedDir, 'reference-waveform.f32'));
  const expectedMel = readFloat32File(path.join(sedDir, 'reference-mel.f32'));
  const referenceProbs = readFloat32File(path.join(sedDir, 'reference-probabilities.f32'));

  assert.equal(waveform.length, 160000);
  assert.equal(expectedMel.length, 128 * 1000);
  assert.equal(referenceProbs.length, 250 * 447);

  const spec = getModelSpec('efficientsed');
  const validated = validateModelManifest(spec, manifest);
  assert.equal(validated.gunshotIndices.length, 2);
  validateInferenceOutput(spec, manifest, { values: referenceProbs, dims: [1, 250, 447] });

  const actualMel = createSedFrontend(frontendCfg)(waveform);
  assert.equal(actualMel.length, expectedMel.length);
  let maxErr = 0;
  for (let i = 0; i < expectedMel.length; i++) {
    const err = Math.abs(actualMel[i] - expectedMel[i]);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 1e-4, `Expected createSedFrontend maxErr < 1e-4 against reference-mel.f32, got ${maxErr}`);
});
