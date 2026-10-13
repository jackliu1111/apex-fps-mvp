"""Bridge contract boundaries, using tiny files and a controlled sleeping child."""
import copy
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import uuid
from contextlib import redirect_stderr

import numpy as np

from integrations.filmcraft import bridge
from model_identity import configuration_identity, file_identity
from model_service import ModelService, ServiceError


class FakeService:
    """Controlled core boundary; identity validation is the real core validator."""
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self.data_dir = Path(self.data_dir)
        self.records_dir = self.data_dir / 'media'
        self.tasks_dir = self.data_dir / 'tasks'
        self.results_dir = self.data_dir / 'results'
        for path in (self.records_dir, self.tasks_dir, self.results_dir):
            path.mkdir(parents=True, exist_ok=True)
        self.read_only = False
        self.started = 0
        self.validated = []
        self.closed = []
        self.task_updates = []
        self.invalid_results = set()
        self.cancel_on_poll = False

    def current_cancel_check(self):
        pass

    def validate_media(self, media):
        current = {'path': media['source']['path'], **file_identity(media['source']['path'])}
        if current != media['source']:
            raise ServiceError('source_changed', '源文件已变化', 409)

    def get_media(self, identifier):
        return json.loads((self.records_dir / f'{identifier}.json').read_text())

    def validate_result(self, result):
        self.validated.append(result['result_id'])
        if result['result_id'] in self.invalid_results:
            raise ServiceError('analysis_configuration_changed', '旧记录已失效', 409)
        ModelService.validate_result(self, result)

    def build_result(self, *args, **kwargs):
        return ModelService.build_result(self, *args, **kwargs)

    def write_result(self, media, *, status='completed'):
        identifier = uuid.uuid4().hex
        folder = self.results_dir / identifier
        folder.mkdir()
        np.savez_compressed(folder / 'scores.npz', probabilities=np.array([[.8, .1]], dtype=np.float32),
            class_names=np.array(['Gunshot, gunfire', 'Machine gun']), frame_onsets=np.array([0.]),
            frame_offsets=np.array([.04]), window_counts=np.array([1]))
        prediction = {'configuration': configuration_identity(self.model_workspace, self.checkpoint),
                      'scores_path': str(folder / 'scores.npz'), 'metadata_path': str(folder / 'prediction.json'),
                      'cache_key': 'same-key-must-not-be-trusted', 'valid_duration_s': 1.,
                      'model': {'name': 'controlled-model'}}
        result = {'result_id': identifier, 'prediction_id': identifier, 'candidate_version': uuid.uuid4().hex,
            'media': copy.deepcopy(media), 'prediction': prediction,
            'candidates': [{'candidate_id': 'candidate-1', 'start_s': 0., 'end_s': 1.}],
            'selection': [{'candidate_id': 'candidate-1', 'selected': False, 'start_s': .25,
                           'end_s': .75, 'revision': 3}]}
        (folder / 'result.json').write_text(json.dumps(result))
        (folder / 'prediction.json').write_text(json.dumps({'prediction_id': identifier,
                                                           'media': media, **prediction}))
        task = {'task_id': identifier, 'kind': 'analysis', 'status': status, 'stage': status,
                'progress': 1, 'result_id': identifier,
                'results': [{'status': 'completed', 'result_id': identifier, 'media_id': media['media_id']}]}
        (self.tasks_dir / f'{identifier}.json').write_text(json.dumps(task))
        return result

    def execute(self, operation, request):
        if operation == 'probe_media':
            path = request['path']
            media = {'media_id': uuid.uuid4().hex, 'source': {'path': path, **file_identity(path)},
                     'duration_s': 1., 'video': {'start_time_s': 0.},
                     'audio_tracks': [{'stream_index': 1}, {'stream_index': 2}], 'selected_audio': None}
            (self.records_dir / f"{media['media_id']}.json").write_text(json.dumps(media))
            return media
        if operation == 'confirm_audio':
            media = self.get_media(request['media_id'])
            if request['stream_index'] not in (1, 2):
                raise ServiceError('invalid_audio_track', '请选择音轨')
            media['selected_audio'] = {'stream_index': request['stream_index'], 'video_origin_s': 0.,
                                      'audio_origin_s': 0., 'audio_to_video_offset_s': 0.}
            (self.records_dir / f"{media['media_id']}.json").write_text(json.dumps(media))
            return media
        if operation == 'analyze':
            self.started += 1
            result = self.write_result(self.get_media(request['media_id']), status='running')
            self.task = json.loads((self.tasks_dir / f"{result['result_id']}.json").read_text())
            return {'task_id': result['result_id']}
        if operation == 'get_task':
            if self.cancel_on_poll:
                raise bridge.Cancelled('task_cancelled', '分析已取消')
            self.task.update(self.task_updates.pop(0) if self.task_updates else
                             {'status': 'completed', 'stage': 'completed', 'progress': 1})
            (self.tasks_dir / f"{self.task['task_id']}.json").write_text(json.dumps(self.task))
            return copy.deepcopy(self.task)
        if operation == 'get_result':
            return json.loads((self.results_dir / request['result_id'] / 'result.json').read_text())
        raise AssertionError(operation)

    def close(self, *, interrupted=False):
        self.closed.append(interrupted)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'models'
        (self.workspace / 'scripts').mkdir(parents=True)
        (self.workspace / 'scripts/infer_apex_audio.py').write_text('# controlled loader\n')
        (self.workspace / 'PretrainedSED').mkdir()
        (self.workspace / 'checkpoints').mkdir()
        self.checkpoint = self.workspace / 'checkpoints/BEATs_strong_1.pt'
        self.checkpoint.write_bytes(b'controlled weight identity')
        self.source = self.root / '游戏.mkv'
        self.source.write_bytes(b'controlled media identity, never decoded')
        self.env = {'APEX_AI_DATA_DIR': str(self.root / 'data'), 'APEX_MODEL_WORKSPACE': str(self.workspace),
                    'APEX_CHECKPOINT': str(self.checkpoint), 'APEX_ENGINE_PYTHON': sys.executable,
                    'APEX_FFMPEG': sys.executable, 'APEX_FFPROBE': sys.executable}
        self.service = FakeService(**bridge.configuration(self.env, analyze=True).service_arguments())

    def tearDown(self):
        self.temp.cleanup()

    def seed(self, *, source=None, audio=1, status='completed'):
        media = self.service.execute('probe_media', {'path': str(source or self.source)})
        media = self.service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': audio})
        return self.service.write_result(media, status=status)

    def analyze(self, *, source=None, audio=1):
        events = []
        bridge.analyze(self.service, source or self.source, audio, events.append,
                       wait=lambda _: None, core_runtime_check=lambda: None)
        return events

    def test_cache_rebuilds_default_ai_selection_without_changing_existing_result(self):
        old = self.seed()
        path = self.service.results_dir / old['result_id'] / 'result.json'
        old['parameters'] = {'threshold': .99, 'before_s': 0, 'after_s': 0, 'merge_gap_s': 0}
        old['candidates'] = []
        path.write_text(json.dumps(old))
        before = path.read_bytes()
        events = self.analyze()
        self.assertEqual(0, self.service.started)
        self.assertEqual([old['result_id']], self.service.validated)
        result = events[-1]['result']
        self.assertTrue(events[-1]['cached'])
        self.assertEqual(.2, result['parameters']['threshold'])
        self.assertEqual((5, 5, 5), tuple(result['parameters'][k] for k in ('before_s', 'after_s', 'merge_gap_s')))
        self.assertEqual([(True, 0., 1.)], [(s['selected'], s['start_s'], s['end_s']) for s in result['selection']])
        self.assertEqual(old['result_id'], result['source_result_id'])
        self.assertEqual(old['candidate_version'], result['source_candidate_version'])
        self.assertNotEqual(old['candidate_version'], result['candidate_version'])
        self.assertEqual(before, path.read_bytes())

    def test_same_cache_key_cannot_reuse_a_different_source_audio_or_configuration(self):
        for mismatch in ('different_source', 'source_changed', 'same_size_mtime', 'audio', 'configuration'):
            with self.subTest(mismatch=mismatch):
                self.service = FakeService(**bridge.Configuration(self.root / mismatch, sys.executable,
                    sys.executable, self.workspace, self.checkpoint, sys.executable).service_arguments())
                old = self.seed()
                source, audio = self.source, 1
                if mismatch == 'different_source':
                    source = self.root / 'other.mkv'; source.write_bytes(self.source.read_bytes())
                elif mismatch == 'source_changed':
                    self.source.write_bytes(self.source.read_bytes() + b'changed')
                elif mismatch == 'same_size_mtime':
                    previous_stat = self.source.stat()
                    self.source.write_bytes(self.source.read_bytes()[::-1])
                    os.utime(self.source, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
                elif mismatch == 'audio':
                    audio = 2
                else:
                    self.checkpoint.write_bytes(self.checkpoint.read_bytes() + b'changed')
                events = self.analyze(source=source, audio=audio)
                self.assertEqual(1, self.service.started)
                self.assertFalse(events[-1]['cached'])
                self.assertNotEqual(old['result_id'], events[-1]['result']['result_id'])

    def test_failed_cancelled_and_incomplete_prediction_records_are_not_cache(self):
        for invalid in ('failed', 'cancelled', 'running', 'missing_scores', 'broken_npz', 'missing_metadata'):
            with self.subTest(invalid=invalid):
                self.service = FakeService(**bridge.Configuration(self.root / invalid, sys.executable,
                    sys.executable, self.workspace, self.checkpoint, sys.executable).service_arguments())
                old = self.seed(status=invalid if invalid in ('failed', 'cancelled', 'running') else 'completed')
                folder = self.service.results_dir / old['result_id']
                if invalid == 'missing_scores': (folder / 'scores.npz').unlink()
                if invalid == 'broken_npz': (folder / 'scores.npz').write_bytes(b'partial archive')
                if invalid == 'missing_metadata': (folder / 'prediction.json').unlink()
                with redirect_stderr(io.StringIO()):
                    events = self.analyze()
                self.assertFalse(events[-1]['cached'])
                self.assertEqual(1, self.service.started)

    def test_core_revalidation_can_invalidate_an_apparently_matching_cache(self):
        old = self.seed()
        self.service.invalid_results.add(old['result_id'])
        with redirect_stderr(io.StringIO()):
            events = self.analyze()
        self.assertFalse(events[-1]['cached'])
        self.assertIn(old['result_id'], self.service.validated)

    def test_progress_is_valid_json_bounded_and_stages_reach_completed(self):
        self.service.task_updates = [
            {'status': 'running', 'stage': 'extracting_audio', 'progress': None},
            {'status': 'running', 'stage': 'inference', 'progress': float('nan')},
            {'status': 'running', 'stage': 'inference', 'progress': 1.25},
        ]
        events = self.analyze()
        for event in events:
            json.dumps(event, allow_nan=False)
        progress = [e for e in events if e['type'] == 'progress']
        self.assertIn({'type': 'progress', 'stage': 'inference', 'message': '分析游戏声音', 'progress': None}, progress)
        self.assertTrue(all(e['progress'] is None or 0 <= e['progress'] <= 1 for e in progress))
        self.assertEqual('completed', progress[-1]['stage'])
        self.assertFalse(events[-1]['cached'])

    def test_probe_needs_no_model_runtime_and_diagnostics_do_not_pollute_stdout(self):
        output, diagnostics = io.StringIO(), io.StringIO()
        original = self.service.execute
        def execute(operation, request):
            print('controlled core diagnostic')
            return original(operation, request)
        self.service.execute = execute
        env = {**self.env, 'APEX_MODEL_WORKSPACE': '/missing', 'APEX_ENGINE_PYTHON': '/missing'}
        with redirect_stderr(diagnostics):
            code = bridge.main(['probe', '--input', str(self.source)], env=env,
                               output=output, service_factory=lambda **_: self.service)
        self.assertEqual(0, code)
        self.assertEqual(['media'], [json.loads(line)['type'] for line in output.getvalue().splitlines()])
        self.assertIn('controlled core diagnostic', diagnostics.getvalue())
        self.assertEqual([False], self.service.closed)

    def test_error_and_cancel_emit_no_result_and_always_close_core(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                self.service = FakeService(**bridge.configuration(self.env, analyze=True).service_arguments())
                self.service.cancel_on_poll = cancelled
                self.service.task_updates = [{'status': 'failed', 'stage': 'failed',
                    'error': {'code': 'model_load_failed', 'message': 'controlled failure'}}]
                output = io.StringIO()
                code = bridge.main(['analyze', '--input', str(self.source), '--audio-stream', '1'],
                    env=self.env, output=output, service_factory=lambda **_: self.service)
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertNotEqual(0, code)
                self.assertNotIn('result', [e['type'] for e in events])
                self.assertEqual('task_cancelled' if cancelled else 'model_load_failed', events[-1]['code'])
                self.assertEqual([False], self.service.closed)

    def test_invalid_arguments_and_missing_models_are_structured_errors(self):
        for argv, env, expected in ((['analyze'], self.env, 'invalid_request'),
            (['analyze', '--input', str(self.source), '--audio-stream', '1'],
             {**self.env, 'APEX_CHECKPOINT': '/missing/BEATs_strong_1.pt'}, 'model_runtime_unavailable')):
            output = io.StringIO()
            self.assertNotEqual(0, bridge.main(argv, env=env, output=output))
            self.assertEqual(expected, json.loads(output.getvalue())['code'])


@unittest.skipIf(os.name == 'nt', 'Unix SIGTERM/parent lifecycle fixture')
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        BridgeTests.setUp(self)
        self.fixture = self.root / 'controlled_bridge.py'
        self.fixture.write_text(textwrap.dedent('''
            import os, sys, uuid, threading, time
            from pathlib import Path
            sys.path.insert(0, REPO)
            from integrations.filmcraft.bridge import main
            from model_identity import file_identity
            from model_service import ModelService
            class ControlledCore(ModelService):
                def probe_media(self, source):
                    media = {'media_id': uuid.uuid4().hex, 'source': {'path':source, **file_identity(source)},
                        'duration_s': 1., 'video': {'start_time_s':0.}, 'selected_audio':None,
                        'audio_tracks':[{'stream_index':1,'start_time_s':0.}]}
                    self.save_media(media)
                    return media
                def run_analysis(self, task, media, result_id):
                    code = 'import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)'
                    def record_guardian():
                        while self.media_process is None: time.sleep(.005)
                        (self.data_dir/'guardian.pid').write_text(str(self.media_process.pid))
                    threading.Thread(target=record_guardian, daemon=True).start()
                    self.run_process(task, [sys.executable, '-c', code, str(self.data_dir/'child.pid')], self.data_dir/'child.log')
            raise SystemExit(main(service_factory=ControlledCore))
        ''').replace('REPO', repr(str(bridge.REPO))))

    tearDown = BridgeTests.tearDown

    def wait_file(self, path, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if path.is_file(): return path.read_text()
            time.sleep(.02)
        self.fail(f'Missing fixture evidence {path}')

    def assert_gone(self, pid, timeout=5):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try: os.kill(pid, 0)
            except ProcessLookupError: return
            time.sleep(.02)
        self.fail(f'Controlled child {pid} survived bridge cleanup')

    def fixture_args(self):
        return [sys.executable, str(self.fixture), 'analyze', '--input', str(self.source), '--audio-stream', '1']

    def test_sigterm_closes_core_and_reaps_owned_process(self):
        with subprocess.Popen(self.fixture_args(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env={**os.environ, **self.env}, text=True) as process:
            try:
                child = int(self.wait_file(self.root / 'data/child.pid'))
                guardian = int(self.wait_file(self.root / 'data/guardian.pid'))
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=8)
                self.assertNotEqual(0, process.returncode, stderr)
                events = [json.loads(line) for line in stdout.splitlines()]
                self.assertEqual('task_cancelled', events[-1]['code'])
                self.assertNotIn('result', [e['type'] for e in events])
                self.assert_gone(child)
                self.assert_gone(guardian)
                tasks = [json.loads(p.read_text()) for p in (self.root / 'data/tasks').glob('*.json')]
                self.assertEqual(['cancelled'], [t['status'] for t in tasks])
            finally:
                if process.poll() is None: process.kill(); process.wait()

    def test_parent_exit_without_stdin_activity_interrupts_and_cleans_children(self):
        events_path, error_path = self.root / 'events.ndjson', self.root / 'errors.txt'
        parent = textwrap.dedent('''
            import os, subprocess, time
            from pathlib import Path
            events=open(EVENTS,'w'); errors=open(ERRORS,'w')
            child=subprocess.Popen(ARGS, stdout=events, stderr=errors, stdin=subprocess.DEVNULL)
            Path(BRIDGEPID).write_text(str(child.pid))
            deadline=time.monotonic()+8
            while not Path(CHILDPID).exists() and time.monotonic()<deadline: time.sleep(.02)
            os._exit(0 if Path(CHILDPID).exists() else 2)
        ''')
        for key, value in {'EVENTS': str(events_path), 'ERRORS': str(error_path), 'ARGS': self.fixture_args(),
                           'BRIDGEPID': str(self.root / 'bridge.pid'), 'CHILDPID': str(self.root / 'data/child.pid')}.items():
            parent = parent.replace(key, repr(value))
        result = subprocess.run([sys.executable, '-c', parent], env={**os.environ, **self.env},
                                capture_output=True, text=True, timeout=12)
        self.assertEqual(0, result.returncode, result.stderr)
        child = int(self.wait_file(self.root / 'data/child.pid'))
        guardian = int(self.wait_file(self.root / 'data/guardian.pid'))
        self.assert_gone(child)
        self.assert_gone(guardian)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            events = [json.loads(line) for line in events_path.read_text().splitlines()]
            if events and events[-1]['type'] == 'error': break
            time.sleep(.02)
        self.assertEqual('service_interrupted', events[-1]['code'], error_path.read_text())
        self.assert_gone(int((self.root / 'bridge.pid').read_text()))
        tasks = [json.loads(p.read_text()) for p in (self.root / 'data/tasks').glob('*.json')]
        self.assertEqual(['failed'], [t['status'] for t in tasks])


if __name__ == '__main__':
    unittest.main()
