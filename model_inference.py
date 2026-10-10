"""Persistent BEATs CPU process. NDJSON stdout is reserved for service events."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import os
import uuid


def emit(**event):
    print(json.dumps(event, ensure_ascii=False, allow_nan=False), file=sys.__stdout__, flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class BeatsEngine:
    def __init__(self):
        self.model = None
        self.instance_id = uuid.uuid4().hex
        self.inference_index = 0

    def analyze(self, request):
        import numpy as np
        import soundfile as sf
        import torch
        import torchaudio

        checkpoint = Path(request['checkpoint'])
        workspace = Path(request['model_workspace'])
        started = time.perf_counter()
        reused = self.model is not None
        if self.model is None:
            if not checkpoint.is_file() or checkpoint.name != 'BEATs_strong_1.pt':
                raise ValueError('需要本地 BEATs_strong_1.pt 权重')
            script = workspace / 'scripts/infer_apex_audio.py'
            spec = importlib.util.spec_from_file_location('apex_beats_baseline', script)
            runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runner)
            torch.set_num_threads(4)
            # The existing loader uses local upstream code and weights_only=True.
            self.model, self.classes = runner.load_model(checkpoint, torch.device('cpu'))
            self.metadata = {
                'name': 'BEATs_strong_1', 'checkpoint': str(checkpoint),
                'checkpoint_sha256': sha256(checkpoint),
                'preprocessing_version': 'beats-16k-mono-10s-5s-mean-v1',
                'adapter_sha256': sha256(__file__), 'loader_sha256': sha256(script),
                'device': 'cpu', 'threads': 4, 'sample_rate': 16000, 'channels': 1,
                'window_s': 10, 'stride_s': 5, 'frame_step_s': 0.04,
                'window_fusion': 'arithmetic-mean-of-sigmoid-probabilities',
                'versions': {'torch': torch.__version__, 'torchaudio': torchaudio.__version__,
                             'numpy': np.__version__, 'soundfile': sf.__version__},
            }
        load_seconds = time.perf_counter() - started
        self.inference_index += 1
        runtime = {'engine_instance_id': self.instance_id, 'process_id': os.getpid(),
                   'inference_index': self.inference_index, 'model_reused': reused,
                   'load_count': 1, 'reported_by': 'engine'}
        emit(type='progress', stage='inference', progress=0, model=self.metadata,
             engine_runtime=runtime,
             timings={'model_loading': load_seconds})
        self.stage = 'inference'
        started = time.perf_counter()
        with sf.SoundFile(request['audio']) as audio, torch.inference_mode():
            if audio.samplerate != 16000 or audio.channels != 1 or audio.frames <= 0:
                raise ValueError('模型输入须为非空 16 kHz 单声道音频')
            samples = audio.frames
            frame_count = (samples + 639) // 640
            sums = np.zeros((frame_count, len(self.classes)), dtype=np.float32)
            counts = np.zeros(frame_count, dtype=np.uint16)
            last_index = (max(0, samples - 160000) + 79999) // 80000
            starts = range(0, last_index * 80000 + 1, 80000)
            for index, sample_start in enumerate(starts):
                audio.seek(sample_start)
                waveform = np.zeros((1, 160000), dtype=np.float32)
                actual = audio.read(160000, dtype='float32')
                if not np.isfinite(actual).all():
                    raise ValueError('音频含无效采样')
                waveform[0, :len(actual)] = actual
                mel = self.model.mel_forward(torch.from_numpy(waveform))
                logits, _ = self.model(mel)
                if tuple(logits.shape) != (1, len(self.classes), 250):
                    raise ValueError('模型未返回预期的 40 ms 时间网格')
                probabilities = torch.sigmoid(logits).transpose(1, 2).float().cpu().numpy()[0]
                first = sample_start // 640
                stop = min(first + 250, frame_count)
                sums[first:stop] += probabilities[:stop - first]
                counts[first:stop] += 1
                emit(type='progress', stage='inference', progress=(index + 1) / len(starts),
                     processed_windows=index + 1, total_windows=len(starts),
                     covered_seconds=min(samples, sample_start + 160000) / 16000)
        if (counts == 0).any():
            raise ValueError('预测时间网格存在缺口')
        probabilities = sums / counts[:, None]
        if not np.isfinite(probabilities).all():
            raise ValueError('模型返回非有限分数')
        onsets = np.arange(frame_count, dtype=np.int64) * 640 / 16000
        offsets = np.minimum((np.arange(frame_count, dtype=np.int64) + 1) * 640, samples) / 16000
        np.savez_compressed(request['scores_path'], probabilities=probabilities,
                            frame_onsets=onsets, frame_offsets=offsets,
                            class_names=np.asarray(self.classes), window_counts=counts)
        emit(type='result', model=self.metadata, runtime=runtime, valid_duration_s=samples / 16000,
             covered_samples=samples, padded_samples_last_window=max(0, starts[-1] + 160000 - samples),
             processed_windows=len(starts), timings={'model_loading': load_seconds,
                                                     'inference': time.perf_counter() - started})


def main():
    engine = BeatsEngine()
    for line in sys.stdin:
        engine.stage = 'model_loading'
        try:
            request = json.loads(line)
            # Upstream model diagnostics must never enter protocol stdout.
            with redirect_stdout(sys.stderr):
                # emit writes to sys.__stdout__; upstream print remains on stderr.
                engine.analyze(request)
        except Exception as exc:
            emit(type='error', code='model_load_failed' if engine.stage == 'model_loading'
                 else 'model_inference_failed', message=str(exc))


if __name__ == '__main__':
    main()
