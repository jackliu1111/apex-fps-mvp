#!/usr/bin/env python3
"""Compare real source HTTP inference with the frozen IPC smoke through public score reads."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from test_model_dual_contract import HttpAdapter
from model_service import ModelService
import numpy as np


def main():
    import argparse
    import subprocess
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sample', type=Path, required=True)
    parser.add_argument('--model-workspace', type=Path, required=True)
    parser.add_argument('--frozen-evidence', type=Path, required=True)
    parser.add_argument('--audio-stream', type=int, required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    args = parser.parse_args()
    native_result = json.loads((args.frozen_evidence / 'result.json').read_text())
    with tempfile.TemporaryDirectory(prefix='source-http-model-') as folder:
        service = ModelService(data_dir=folder, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
            model_workspace=args.model_workspace)
        http = HttpAdapter(service)
        try:
            media = http.execute('probe_media', {'path': str(args.sample)})
            http.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': args.audio_stream})
            submitted = http.execute('analyze', {'media_id': media['media_id']})
            for _ in range(1200):
                task = http.execute('get_task', submitted)
                if task['status'] in ('completed', 'failed', 'cancelled'):
                    break
                time.sleep(.05)
            if task['status'] != 'completed':
                raise RuntimeError(task)
            result = http.execute('get_result', {'result_id': task['result_id']})
            source_scores = http.execute('read_scores', {'prediction_id': result['prediction_id'],
                'start_s': 0, 'end_s': media['duration_s']})
            manifest = json.loads((ROOT / 'desktop/resources/manifest.json').read_text())
            resources = ROOT / 'desktop/resources'
            requests = [{'id': 'scores', 'operation': 'read_scores', 'payload': {
                'prediction_id': native_result['prediction_id'], 'start_s': 0, 'end_s': media['duration_s']}}]
            native = subprocess.run([str(resources / manifest['service']), '--data-dir',
                str(args.frozen_evidence / 'data'), '--ffmpeg', str(resources / manifest['ffmpeg']),
                '--ffprobe', str(resources / manifest['ffprobe']), '--model-workspace', str(resources / manifest['model_workspace']),
                '--checkpoint', str(resources / manifest['checkpoint'])],
                input='\n'.join(json.dumps(request) for request in requests) + '\n',
                text=True, capture_output=True, check=True, timeout=30)
            frozen_scores = json.loads(native.stdout.splitlines()[1])['result']
            assert source_scores['classes'] == frozen_scores['classes']
            for key in ('frame_onsets_s', 'frame_offsets_s', 'scores'):
                np.testing.assert_allclose(source_scores[key], frozen_scores[key], rtol=0, atol=1e-6)
            source_candidates = [(c['start_s'], c['end_s']) for c in result['candidates']]
            native_candidates = [(c['start_s'], c['end_s']) for c in native_result['candidates']]
            np.testing.assert_allclose(source_candidates, native_candidates, rtol=0, atol=1e-6)
            report = {'sample': str(args.sample.resolve()), 'duration_s': media['duration_s'],
                'video': media['video'], 'audio_stream': args.audio_stream, 'tolerance': {'rtol': 0, 'atol': 1e-6},
                'frame_count': len(source_scores['scores']), 'class_count': len(source_scores['classes']),
                'max_probability_difference': float(np.max(np.abs(np.asarray(source_scores['scores']) - np.asarray(frozen_scores['scores'])))),
                'candidate_ranges': source_candidates, 'source_http_task': task, 'status': 'passed',
                'scope': 'real BEATs on local 20s/540p sample; not quality or clean-machine acceptance'}
            (args.frozen_evidence / 'source-http-frozen-ipc-parity.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({key: report[key] for key in ('status', 'frame_count', 'class_count', 'max_probability_difference', 'tolerance')}))
        finally:
            http.close()


if __name__ == '__main__':
    main()
