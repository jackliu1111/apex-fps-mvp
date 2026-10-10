#!/usr/bin/env python3
"""Run real HTTP acceptance once and compare saved native public artifacts."""
import argparse
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import sys
import time
import uuid

import numpy as np

from validate_model_recordings import Adapter, run_entry, save, require, candidate_values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--audio-stream', type=int, required=True)
    parser.add_argument('--native-result', type=Path, required=True)
    parser.add_argument('--native-export-task', type=Path, required=True)
    parser.add_argument('--model-workspace', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--ffmpeg', default='/opt/homebrew/bin/ffmpeg')
    parser.add_argument('--ffprobe', default='/opt/homebrew/bin/ffprobe')
    parser.add_argument('--timeout-s', type=float, default=7200)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    native = json.loads(args.native_result.read_text(encoding='utf-8'))
    native_export = json.loads(args.native_export_task.read_text(encoding='utf-8'))
    require(native_export['status'] == 'completed', 'Native export must already be completed')
    args.source = [args.source.resolve()]
    args.audio_stream = [args.audio_stream]
    args.model_workspace = args.model_workspace.resolve()
    args.checkpoint = (args.checkpoint or args.model_workspace / 'checkpoints/BEATs_strong_1.pt').resolve()
    args.service_python = args.engine_python = args.python
    args.trim_s = 0
    args.preview_limit = 1
    args.preview_all = False
    timestamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d_%H-%M-%S')
    folder = args.output_dir.resolve() / (timestamp + '-' + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True)
    report = {
        'status': 'running', 'source': str(args.source[0]),
        'native_result_reference': str(args.native_result.resolve()),
        'native_export_reference': str(args.native_export_task.resolve()),
        'scope': 'new real HTTP cold/warm/full-selected workflow against existing native public scores_path and export records; no second native run',
        'manual_review': 'required', 'quicklook_stutter': 'unresolved',
        'clean_machine': 'not_evaluated', 'issue16_complete': False,
        'command': [sys.executable, *sys.argv],
    }
    began = time.monotonic()
    adapter = None
    save(folder / 'report.json', report)
    try:
        adapter = Adapter('http', folder / 'http', args)
        print('HTTP real recording validation started: ' + str(folder), flush=True)
        evidence = run_entry(adapter, args)
        baseline = evidence['results'][0]['baseline']
        selected = evidence['results'][0]['selected']
        require(baseline['media']['source'] == native['media']['source'], 'Source identity changed')
        require(baseline['media']['selected_audio'] == native['media']['selected_audio'], 'Audio selection or mapping differs')
        require(baseline['parameters'] == native['parameters'], 'Default postprocessing differs')
        require(candidate_values(baseline) == candidate_values(native), 'Automatic candidate ranges differ')
        require([s[k] for s in selected['selection'] for k in ('selected', 'start_s', 'end_s')]
                == [s[k] for s in native['selection'] for k in ('selected', 'start_s', 'end_s')],
                'Selected requests differ')
        produced = evidence['results'][0]['exports']
        expected = native_export['exports']
        require(len(produced) == len(expected), 'Export counts differ')
        require(all(a['requested_range'] == b['requested_range'] and a['actual_range'] == b['actual_range']
                    and a['mode'] == b['mode'] for a, b in zip(produced, expected)),
                'Measured or requested export ranges differ')
        first_path = Path(baseline['prediction']['scores_path'])
        second_path = Path(native['prediction']['scores_path'])
        checks = {}
        with np.load(first_path, allow_pickle=False) as first, np.load(second_path, allow_pickle=False) as second:
            for name in ('class_names', 'frame_onsets', 'frame_offsets', 'window_counts'):
                checks[name] = bool(np.array_equal(first[name], second[name]))
            a, b = first['probabilities'], second['probabilities']
            checks['shape_equal'] = a.shape == b.shape
            require(checks['shape_equal'], 'Raw score dimensions differ')
            require(np.isfinite(a).all() and np.isfinite(b).all(), 'Non-finite scores')
            maximum = float(np.max(np.abs(a - b)))
            checks['scores_within_tolerance'] = maximum <= 1e-6
            shape = list(a.shape)
        require(all(checks.values()), 'Prediction artifact mismatch')
        report.update(status='passed', http=evidence['evidence'],
                      original_parameters=baseline['parameters'], video=baseline['media']['video'],
                      raw_artifact_parity={'shape': shape, 'max_abs_difference': maximum,
                                           'atol': 1e-6, 'rtol': 0, 'checks': checks,
                                           'scope': 'all raw arrays at public scores_path, including real audio tail outside video'},
                      candidate_count=len(baseline['candidates']), export_count=len(produced),
                      configuration={'http': baseline['prediction']['configuration'],
                                     'native': native['prediction']['configuration'],
                                     'path_difference_is_not_numeric_drift': True})
    except Exception as exc:
        report.update(status='failed', error={'type': type(exc).__name__, 'message': str(exc)})
    finally:
        if adapter:
            adapter.close()
        report['elapsed_s'] = time.monotonic() - began
        report['completed_at'] = datetime.now(timezone(timedelta(hours=8))).isoformat()
        save(folder / 'report.json', report)
    print(json.dumps({'status': report['status'], 'report': str(folder / 'report.json'),
                      'error': report.get('error')}, ensure_ascii=False), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
