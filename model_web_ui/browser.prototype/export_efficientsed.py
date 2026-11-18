"""Developer-only fixed-window EfficientSED export; browser runtime needs no Python.

Use the official fmn10+tf-256_advanced-kd-weak-strong checkpoint and source.
Outputs must live on the mounted external experiment disk. No quantization.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import types

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F
from torchaudio.compliance.kaldi import get_mel_banks


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--waveform', type=Path, help='10 seconds mono 16kHz little-endian Float32')
    args = parser.parse_args()
    source, checkpoint, out = [p.resolve() for p in (args.source, args.checkpoint, args.output)]
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(source))
    os.chdir(source)
    # Upstream imports CUDA-only Mamba unconditionally. This TF-only export never
    # constructs it; fail loudly if a future change attempts to select Mamba.
    optional = types.ModuleType('mamba_ssm')
    class UnsupportedMamba:
        def __init__(self, *a, **kw):
            raise RuntimeError('This exporter supports only the TF sequence model')
    optional.Mamba2 = UnsupportedMamba
    sys.modules.setdefault('mamba_ssm', optional)
    from models.efficient_cnns.fmn.fmn_wrapper import FrameMNWrapper
    from models.prediction_wrapper import PredictionsWrapper
    from data_util.audioset_classes import as_strong_train_classes
    torch.set_num_threads(4)
    torch.manual_seed(42)
    with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet):
        base = FrameMNWrapper(1.0)
        model = PredictionsWrapper(base, embed_dim=960, seq_model_type='tf', seq_model_dim=256).eval()
    state = torch.load(checkpoint, map_location='cpu', weights_only=True)
    state = {k.removeprefix('net.'): v for k, v in state.items()}
    state = {('model.fmn.' + k[len('model.'):] if k.startswith('model.') else k): v for k, v in state.items()}
    model.load_state_dict(state, strict=True)

    class Scores(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model
        def forward(self, mel):
            return self.model(mel)[0].transpose(1, 2).sigmoid()
    exported = Scores().eval()
    waveform = torch.from_numpy(np.fromfile(args.waveform, dtype='<f4').copy()).reshape(1, -1) if args.waveform else torch.randn(1, 160000) * .03
    if waveform.shape != (1, 160000):
        raise ValueError('Reference must contain exactly 160000 mono samples')
    with torch.no_grad():
        mel = model.mel_forward(waveform)
        expected = exported(mel).numpy()
    target = out / 'fmn10-tf256.onnx'
    torch.onnx.export(exported, mel, str(target), input_names=['mel'], output_names=['probabilities'],
                      opset_version=17, dynamo=False, do_constant_folding=True)
    onnx.checker.check_model(str(target))
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    session = ort.InferenceSession(str(target), opts, providers=['CPUExecutionProvider'])
    actual = session.run(None, {'mel': mel.numpy()})[0]
    error = float(np.max(np.abs(actual - expected)))
    if error > 1e-3:
        raise RuntimeError(f'ONNX export error {error}')
    waveform.numpy().tofile(out / 'reference-waveform.f32')
    mel.numpy().tofile(out / 'reference-mel.f32')
    expected.tofile(out / 'reference-probabilities.f32')
    frontend = base.mel
    banks, _ = get_mel_banks(128, 512, 16000, frontend.fmin, frontend.fmax, 100, -500, 1)
    constants = {'fftSize': 512, 'hop': 160, 'samples': 160000, 'frames': 1000,
                 'window': F.pad(frontend.window_400, (56, 56)).tolist(),
                 'mel': F.pad(banks, (0, 1)).tolist(), 'logFloor': 1e-7,
                 'normalization': {'add': 4.5, 'divide': 5}, 'fmin': frontend.fmin, 'fmax': frontend.fmax}
    (out / 'frontend.json').write_text(json.dumps(constants))
    manifest = {'model': 'EfficientSED fmn10+tf-256 advanced KD', 'modelFile': target.name,
                'checkpoint': 'fmn10+tf-256_advanced-kd-weak-strong.pt',
                'checkpointSha256': digest(checkpoint), 'sha256': digest(target), 'bytes': target.stat().st_size,
                'classes': as_strong_train_classes, 'sampleRate': 16000, 'windowSeconds': 10,
                'strideSeconds': 5, 'frameSeconds': .04, 'scoreType': 'frame', 'activation': 'sigmoid',
                'inputName': 'mel', 'input': list(mel.shape), 'output': list(expected.shape),
                'parameters': sum(p.numel() for p in model.parameters()), 'onnxMaxError': error,
                'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'source': 'https://github.com/theMoro/EfficientSED',
                'reference': 'supplied waveform' if args.waveform else 'synthetic noise',
                'validation': 'Python vs ONNX numerical comparison only; no Apex accuracy claim'}
    (out / 'model.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    shutil.copyfile(source / 'LICENSE', out / 'LICENSE')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'classes'}, indent=2))


if __name__ == '__main__':
    main()
