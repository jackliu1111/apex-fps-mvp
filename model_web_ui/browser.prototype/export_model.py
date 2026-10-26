"""Throwaway, developer-only export. Runtime users need only a browser.

Run with the existing inference Python and PYTHONPATH pointing at ONNX deps.
--output must point to approved artifact storage (never commit the weights).
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torchaudio.compliance import kaldi


class Fbank(torch.nn.Module):
    """Fixed 10 s Kaldi frontend using real DFT matrices, exportable to ONNX."""

    def __init__(self):
        super().__init__()
        indices = torch.arange(998)[:, None] * 160 + torch.arange(400)[None, :]
        self.register_buffer('indices', indices)
        self.register_buffer('window', torch.hann_window(400, periodic=False).pow(0.85))
        phase = 2 * math.pi * torch.arange(400, dtype=torch.float64)[:, None] * torch.arange(257, dtype=torch.float64)[None, :] / 512
        self.register_buffer('cos', phase.cos().float())
        self.register_buffer('sin', phase.sin().float())
        mel, _ = kaldi.get_mel_banks(128, 512, 16000, 20, 0, 100, -500, 1)
        self.register_buffer('mel', torch.nn.functional.pad(mel, (0, 1)).T)

    def forward(self, waveform):
        frames = waveform[0, self.indices] * 32768
        frames = frames - frames.mean(dim=1, keepdim=True)
        previous = torch.cat([frames[:, :1], frames[:, :-1]], dim=1)
        frames = (frames - 0.97 * previous) * self.window
        power = (frames @ self.cos).square() + (frames @ self.sin).square()
        mel = torch.clamp(power @ self.mel, min=torch.finfo(torch.float32).eps).log()
        return ((mel - 15.41663) / (2 * 6.55582)).T.unsqueeze(0).unsqueeze(0)


class BrowserModel(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.frontend = Fbank()
        # Exact adaptive_avg_pool1d(496 -> 250), expressed as a constant matrix.
        pool = torch.zeros(250, 496)
        for i in range(250):
            start, end = math.floor(i * 496 / 250), math.ceil((i + 1) * 496 / 250)
            pool[i, start:end] = 1 / (end - start)
        self.register_buffer('pool', pool)

    def forward(self, waveform):
        features = self.model.model(self.frontend(waveform))
        features = self.pool @ features
        return torch.sigmoid(self.model.strong_head(self.model.seq_model(features)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    torch.manual_seed(42)
    spec = importlib.util.spec_from_file_location('apex_loader', args.workspace / 'scripts/infer_apex_audio.py')
    loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loader)
    checkpoint = args.workspace / 'checkpoints/BEATs_strong_1.pt'
    model, classes = loader.load_model(checkpoint, torch.device('cpu'))
    browser = BrowserModel(model).eval()
    waveform = torch.randn(1, 160000) * 0.03
    with torch.inference_mode():
        mel = model.mel_forward(waveform)
        reference = torch.sigmoid(model(mel)[0]).transpose(1, 2).numpy()
        frontend_error = (mel - browser.frontend(waveform)).abs().max().item()
        python_error = float(np.max(np.abs(browser(waveform).numpy() - reference)))
    print('Frontend / rewritten model max errors:', frontend_error, python_error, flush=True)
    target = args.output / 'beats.onnx'
    torch.onnx.export(browser, waveform, str(target), input_names=['waveform'], output_names=['probabilities'],
                      opset_version=17, dynamo=False, do_constant_folding=True)
    onnx.checker.check_model(str(target))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(target), options, providers=['CPUExecutionProvider'])
    actual = session.run(None, {'waveform': waveform.numpy()})[0]
    error = float(np.max(np.abs(actual - reference)))
    if error > 1e-3:
        raise RuntimeError(f'Export differs from baseline: {error}')
    waveform.numpy().tofile(args.output / 'reference-waveform.f32')
    reference.tofile(args.output / 'reference-probabilities.f32')
    metadata = {'model': 'BEATs_strong_1', 'classes': classes, 'input': [1, 160000], 'output': [1, 250, 447],
                'sampleRate': 16000, 'windowSeconds': 10, 'strideSeconds': 5, 'frameSeconds': 0.04,
                'frontendMaxError': frontend_error, 'pythonMaxError': python_error, 'onnxMaxError': error,
                'bytes': target.stat().st_size, 'sha256': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest(),
                'checkpointSha256': hashlib.file_digest(checkpoint.open('rb'), 'sha256').hexdigest(),
                'validation': 'Synthetic noise only; browser and Apex quality require separate validation.'}
    (args.output / 'model.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in metadata.items() if k != 'classes'}, indent=2), flush=True)


if __name__ == '__main__':
    main()
