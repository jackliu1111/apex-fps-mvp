"""Developer-only mn04_as export; browser runtime has no Python dependency.

Use the pinned upstream checkout and an explicitly downloaded official checkpoint.
See README for commands. All model assets go to --output, outside Git.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F
from torchaudio.compliance.kaldi import get_mel_banks


class Scores(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, mel):
        return self.model(mel)[0].sigmoid()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, checkpoint, output = (p.resolve() for p in (args.source, args.checkpoint, args.output))
    if digest(checkpoint) != '899a8c6217063f6941793102a2780b3dd788ab11fce468d9cf5f0577c453321c':
        raise ValueError('Checkpoint differs from the verified official mn04_as release')
    output.mkdir(parents=True, exist_ok=True)
    os.chdir(source)  # Upstream helpers read metadata relative to cwd.
    sys.path.insert(0, str(source))
    from models.mn.model import get_model
    from models.preprocess import AugmentMelSTFT
    torch.set_num_threads(4)
    torch.manual_seed(42)
    model = get_model(width_mult=0.4)
    model.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True), strict=True)
    model = Scores(model.float().eval()).eval()
    frontend = AugmentMelSTFT().eval()
    waveform = torch.randn(1, 320000) * 0.03
    with torch.inference_mode():
        mel = frontend(waveform).unsqueeze(1)
        expected = model(mel).numpy()
    mel = mel.clone()
    target = output / 'mn04.onnx'
    torch.onnx.export(model, mel, str(target), input_names=['mel'], output_names=['probabilities'],
                      opset_version=17, dynamo=False, do_constant_folding=True)
    onnx.checker.check_model(str(target))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(target), options, providers=['CPUExecutionProvider'])
    error = float(np.max(np.abs(session.run(None, {'mel': mel.numpy()})[0] - expected)))
    if error > 1e-3:
        raise RuntimeError(f'Export error: {error}')
    waveform.numpy().tofile(output / 'reference-waveform.f32')
    mel.numpy().tofile(output / 'reference-mel.f32')
    expected.tofile(output / 'reference-probabilities.f32')
    # Export exact frontend constants; JS implements preemphasis + reflect STFT + Mel.
    window = F.pad(frontend.window, (112, 112))
    banks, _ = get_mel_banks(128, 1024, 32000, 0, 15000, 100, -500, 1)
    banks = F.pad(banks, (0, 1))
    (output / 'frontend.json').write_text(json.dumps({'window': window.tolist(), 'mel': banks.tolist()}))
    with (source / 'metadata/class_labels_indices.csv').open() as stream:
        classes = [row['display_name'] for row in csv.DictReader(stream)]
    metadata = {'model': 'EfficientAT mn04_as', 'modelFile': 'mn04.onnx', 'classes': classes,
                'input': list(mel.shape), 'output': [1, 527], 'sampleRate': 32000,
                'windowSeconds': 10, 'strideSeconds': 5, 'scoreType': 'window',
                'parameters': sum(p.numel() for p in model.parameters()),
                'bytes': target.stat().st_size, 'sha256': digest(target),
                'checkpointBytes': checkpoint.stat().st_size, 'checkpointSha256': digest(checkpoint),
                'onnxMaxError': error, 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'source': 'https://github.com/fschmid56/EfficientAT',
                'checkpointUrl': 'https://github.com/fschmid56/EfficientAT/releases/download/v0.0.1/mn04_as_mAP_432.pt',
                'validation': 'Synthetic numerical reference only; Apex quality requires human review.'}
    (output / 'model.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    shutil.copyfile(source / 'LICENSE', output / 'EfficientAT-LICENSE')
    print(json.dumps({k: v for k, v in metadata.items() if k != 'classes'}, indent=2))


if __name__ == '__main__':
    main()
