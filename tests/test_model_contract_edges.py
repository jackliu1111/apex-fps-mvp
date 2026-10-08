"""Critical media and prediction boundaries through both public transports."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from model_service import ModelService, ServiceError
from test_model_dual_contract import HttpAdapter, IpcAdapter


class ModelContractEdgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg, cls.ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        cls.fixtures = tempfile.TemporaryDirectory()
        folder = Path(cls.fixtures.name)
        cls.multitrack = folder / '中文 双音轨 录像.mkv'
        subprocess.run([cls.ffmpeg, '-nostdin', '-v', 'error', '-n',
                        '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=1',
                        '-itsoffset', '0.25', '-f', 'lavfi', '-i',
                        'sine=frequency=440:sample_rate=16000:duration=0.75',
                        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=1',
                        '-map', '0:v', '-map', '1:a', '-map', '2:a',
                        '-c:v', 'ffv1', '-c:a', 'pcm_s16le',
                        '-metadata:s:a:0', 'title=游戏声音', '-metadata:s:a:0', 'language=zho',
                        '-metadata:s:a:1', 'title=麦克风', '-metadata:s:a:1', 'language=eng',
                        '-output_ts_offset', '3', str(cls.multitrack)], check=True)
        cls.no_audio = folder / '无音轨.mp4'
        subprocess.run([cls.ffmpeg, '-nostdin', '-v', 'error', '-n',
                        '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=1',
                        '-c:v', 'libx264', '-preset', 'ultrafast', str(cls.no_audio)], check=True)
        cls.invalid_media = folder / '损坏媒体.mkv'
        cls.invalid_media.write_text('This is not a recording.')

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.adapters = []

    def tearDown(self):
        for adapter in reversed(self.adapters):
            adapter.close()
        self.data.cleanup()

    def adapter(self, kind, *, ffmpeg=None, worker=None, workspace=None, checkpoint=None, **predictions):
        folder = Path(self.data.name) / f'{kind}-{len(self.adapters)}'
        folder.mkdir()
        spec = folder / 'predictions.json'
        spec.write_text(json.dumps(predictions or {'events': [[2, 2.4, 0], [14, 14.4, 1]]}))
        service = ModelService(data_dir=folder / 'data', ffmpeg=ffmpeg or self.ffmpeg,
                               ffprobe=self.ffprobe, model_workspace=workspace, checkpoint=checkpoint,
                               model_command=[sys.executable, str(Path(__file__).parent / 'fixtures'
                                             / (worker or 'model_worker.py')), str(spec)])
        adapter = (HttpAdapter if kind == 'http' else IpcAdapter)(service)
        self.adapters.append(adapter)
        return adapter

    def media(self, adapter, path, stream_index=1):
        record = adapter.execute('probe_media', {'path': str(path)})
        return adapter.execute('confirm_audio', {'media_id': record['media_id'], 'stream_index': stream_index})

    def wait(self, adapter, submitted):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            task = adapter.execute('get_task', submitted)
            if task['status'] in ('completed', 'failed', 'cancelled'):
                return task
            time.sleep(0.01)
        self.fail('public task did not reach a terminal state')

    def analyze(self, adapter, media):
        task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
        self.assertEqual('completed', task['status'], task)
        return adapter.execute('get_result', {'result_id': task['result_id']})

    def recording(self, name, duration):
        path = Path(self.data.name) / name
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n',
                        '-f', 'lavfi', '-i', f'testsrc2=size=96x64:rate=10:duration={duration}',
                        '-f', 'lavfi', '-i', f'sine=sample_rate=16000:duration={duration}',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0',
                        '-c:a', 'alac', '-output_ts_offset', '3', str(path)], check=True)
        return path

    def await_marker(self, path):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if path.exists():
                return json.loads(path.read_text())
            time.sleep(0.01)
        self.fail('external process did not reach its controlled boundary')

    def gated_media(self, kind, mode):
        marker = Path(self.data.name) / (kind + '-media-marker.json')
        release = Path(self.data.name) / (kind + '-media-release')
        spec = Path(self.data.name) / (kind + '-media-spec.json')
        spec.write_text(json.dumps({'mode': mode, 'marker': str(marker),
                                    'release': str(release), 'ffmpeg': self.ffmpeg}))
        wrapper = Path(self.data.name) / (kind + '-ffmpeg')
        fixture = Path(__file__).parent / 'fixtures/edge_media_gate.py'
        wrapper.write_text(f'#!{sys.executable}\nimport runpy, sys\n'
                           f'sys.argv.insert(1, {str(spec)!r})\n'
                           f'runpy.run_path({str(fixture)!r}, run_name="__main__")\n')
        wrapper.chmod(0o755)
        return wrapper, marker, release

    def test_media_selection_contract_uses_the_explicit_audio_track_through_both_entries(self):
        observations = []
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                record = adapter.execute('probe_media', {'path': str(self.multitrack)})
                self.assertIsNone(record['selected_audio'])
                self.assertEqual([(1, '游戏声音', 'zho', 3.25), (2, '麦克风', 'eng', 3.0)],
                                 [(t['stream_index'], t['title'], t['language'], t['start_time_s'])
                                  for t in record['audio_tracks']])
                with self.assertRaises(ServiceError) as unconfirmed:
                    adapter.execute('analyze', {'media_id': record['media_id']})
                self.assertEqual('audio_not_confirmed', unconfirmed.exception.code)
                observed = []
                for stream_index, frames, duration, offset in [(1, 19, 0.75, 0.25), (2, 25, 1.0, 0.0)]:
                    confirmed = adapter.execute('confirm_audio', {'media_id': record['media_id'],
                                                                  'stream_index': stream_index})
                    result = self.analyze(adapter, confirmed)
                    actual = (result['prediction']['frame_count'], result['prediction']['valid_duration_s'],
                              result['media']['selected_audio']['stream_index'],
                              result['prediction']['audio_to_video_offset_s'])
                    self.assertEqual((frames, duration, stream_index, offset), actual)
                    observed.append(actual)
                for operation, payload, code in [
                    ('probe_media', {'path': ''}, 'invalid_path'),
                    ('probe_media', {'path': str(Path(self.data.name) / 'missing.mkv')}, 'invalid_path'),
                    ('probe_media', {'path': self.data.name}, 'invalid_path'),
                    ('probe_media', {'path': str(self.no_audio)}, 'no_audio'),
                    ('probe_media', {'path': str(self.invalid_media)}, 'unreadable_media'),
                    ('confirm_audio', {'media_id': record['media_id'], 'stream_index': 99}, 'invalid_audio_track'),
                ]:
                    with self.subTest(entry=kind, operation=operation, code=code):
                        with self.assertRaises(ServiceError) as rejected:
                            adapter.execute(operation, payload)
                        self.assertEqual((code, 422), (rejected.exception.code, rejected.exception.status))
                observations.append(observed)
        self.assertEqual(observations[0], observations[1])

    def test_full_prediction_is_identical_across_entries_when_read_in_bounded_pages(self):
        recording = self.recording('44秒 分页录像.mp4', 44)
        pages = []
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind, events=[[39.92, 40.08, 0], [42, 42.4, 1]])
                result = self.analyze(adapter, self.media(adapter, recording))
                self.assertEqual(1100, result['prediction']['frame_count'])
                first = adapter.execute('read_scores', {'prediction_id': result['prediction_id'],
                                                        'start_s': 0, 'end_s': 44})
                self.assertEqual((1000, 0.0, 39.96, 40.0, [0.75, 0.0, 0.0]),
                                 (len(first['scores']), first['frame_onsets_s'][0],
                                  first['frame_onsets_s'][-1], first['next_start_s'], first['scores'][-1]))
                second = adapter.execute('read_scores', {'prediction_id': result['prediction_id'],
                                                         'start_s': first['next_start_s'], 'end_s': 44})
                self.assertEqual((100, 40.0, 44.0, None, [0.75, 0.0, 0.0]),
                                 (len(second['scores']), second['frame_onsets_s'][0],
                                  second['frame_offsets_s'][-1], second['next_start_s'], second['scores'][0]))
                for page in (first, second):
                    page.pop('prediction_id', None)
                pages.append((first, second))
        self.assertEqual(pages[0], pages[1])

    def test_source_changed_during_inference_does_not_publish_a_stale_prediction(self):
        recording = self.recording('推理中改动录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                mutable = Path(self.data.name) / (kind + '-mutable.mp4')
                shutil.copyfile(recording, mutable)
                marker = Path(self.data.name) / (kind + '-model-marker.json')
                release = Path(self.data.name) / (kind + '-model-release')
                adapter = self.adapter(kind, worker='edge_model_worker.py', marker=str(marker),
                                       gate=str(release), events=[[2, 2.4, 0]])
                media = self.media(adapter, mutable)
                submitted = adapter.execute('analyze', {'media_id': media['media_id']})
                try:
                    self.await_marker(marker)
                    with mutable.open('ab') as stream:
                        stream.write(b'source changed during inference')
                    release.touch()
                    terminal = self.wait(adapter, submitted)
                    self.assertEqual(('failed', 'source_changed', None),
                                     (terminal['status'], terminal['error']['code'], terminal['result_id']))
                    self.assertEqual(('failed', 'source_changed', None),
                                     (terminal['results'][0]['status'], terminal['results'][0]['error']['code'],
                                      terminal['results'][0]['result_id']))
                    with self.assertRaises(ServiceError) as absent:
                        adapter.execute('get_result', {'result_id': submitted['task_id']})
                    self.assertEqual(('result_not_found', 404), (absent.exception.code, absent.exception.status))
                finally:
                    release.touch()

    def test_source_changed_during_preview_rejects_media_and_removes_unfinished_output(self):
        recording = self.recording('预览中改动录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                mutable = Path(self.data.name) / (kind + '-mutable.mp4')
                shutil.copyfile(recording, mutable)
                wrapper, marker, release = self.gated_media(kind, 'preview')
                adapter = self.adapter(kind, ffmpeg=wrapper)
                result = self.analyze(adapter, self.media(adapter, mutable))
                submitted = adapter.execute('request_preview', {
                    'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                    'candidate_id': result['candidates'][0]['candidate_id']})
                try:
                    partial = self.await_marker(marker)
                    running = adapter.execute('get_task', submitted)
                    self.assertEqual([partial['path']], running['pending_paths'])
                    with mutable.open('ab') as stream:
                        stream.write(b'source changed during preview')
                    release.touch()
                    terminal = self.wait(adapter, submitted)
                    self.assertEqual(('failed', 'source_changed', [], None),
                                     (terminal['status'], terminal['error']['code'], terminal['pending_paths'],
                                      terminal.get('preview_id')))
                    self.assertFalse(Path(partial['path']).exists())
                    with self.assertRaises(ServiceError) as unregistered:
                        adapter.execute('get_artifact', {'artifact_id': Path(partial['path']).stem})
                    self.assertEqual(('artifact_not_found', 404),
                                     (unregistered.exception.code, unregistered.exception.status))
                finally:
                    release.touch()

    def test_source_changed_during_second_export_preserves_the_first_completed_file(self):
        recording = self.recording('导出中改动录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                mutable = Path(self.data.name) / (kind + '-mutable.mp4')
                shutil.copyfile(recording, mutable)
                wrapper, marker, release = self.gated_media(kind, 'second_export')
                adapter = self.adapter(kind, ffmpeg=wrapper)
                result = self.analyze(adapter, self.media(adapter, mutable))
                self.assertEqual(2, len(result['candidates']))
                submitted = adapter.execute('export', {
                    'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                    'output_dir': str(Path(self.data.name) / (kind + '-独立输出')), 'mode': 'copy'})
                try:
                    partial = self.await_marker(marker)
                    running = adapter.execute('get_task', submitted)
                    self.assertEqual(('completed', [partial['path']]),
                                     (running['exports'][0]['status'], running['pending_paths']))
                    with mutable.open('ab') as stream:
                        stream.write(b'source changed during second export')
                    release.touch()
                    terminal = self.wait(adapter, submitted)
                    self.assertEqual(('failed', 'source_changed', ['completed', 'failed'], []),
                                     (terminal['status'], terminal['error']['code'],
                                      [item['status'] for item in terminal['exports']], terminal['pending_paths']))
                    failed = terminal['exports'][1]
                    self.assertEqual(('source_changed', None, None),
                                     (failed['error']['code'], failed['path'], failed['actual_range']))
                    self.assertFalse(Path(partial['path']).exists())
                    first = adapter.execute('get_artifact', {'artifact_id': terminal['exports'][0]['artifact_id']})
                    self.assertEqual(('export', 'completed'), (first['kind'], first['status']))
                    self.assertGreater(first['size'], 0)
                    subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror',
                                    '-i', first['path'], '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
                finally:
                    release.touch()

    def test_audio_change_requires_new_prediction_while_postprocessing_reuses_compatible_scores(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind, events=[[0.08, 0.2, 0]])
                media = self.media(adapter, self.multitrack, 1)
                first = self.analyze(adapter, media)
                second_media = adapter.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 2})
                with self.assertRaises(ServiceError) as old_prediction:
                    adapter.execute('recompute_candidates', {
                        'result_id': first['result_id'], 'candidate_version': first['candidate_version'],
                        'parameters': {'threshold': 1}})
                self.assertEqual(('analysis_configuration_changed', 409),
                                 (old_prediction.exception.code, old_prediction.exception.status))
                second = self.analyze(adapter, second_media)
                self.assertEqual((19, 25, 2), (first['prediction']['frame_count'],
                                              second['prediction']['frame_count'],
                                              second['media']['selected_audio']['stream_index']))
                self.assertNotEqual(first['prediction_id'], second['prediction_id'])
                self.assertNotEqual(first['prediction']['cache_key'], second['prediction']['cache_key'])
                self.assertEqual(first['prediction']['runtime']['engine_instance_id'],
                                 second['prediction']['runtime']['engine_instance_id'])
                self.assertTrue(second['prediction']['runtime']['model_reused'])
                request = {'prediction_id': second['prediction_id'], 'start_s': 0, 'end_s': 1}
                scores = adapter.execute('read_scores', request)
                recomputed = adapter.execute('recompute_candidates', {
                    'result_id': second['result_id'], 'candidate_version': second['candidate_version'],
                    'parameters': {'threshold': 1, 'before_s': 0.1, 'after_s': 0.1}})
                self.assertEqual([], recomputed['candidates'])
                self.assertNotEqual(second['candidate_version'], recomputed['candidate_version'])
                self.assertEqual(second['prediction'], recomputed['prediction'])
                self.assertEqual(scores, adapter.execute('read_scores', request))

    def test_weight_and_loader_changes_require_new_predictions_and_new_engine_instances(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                workspace = Path(self.data.name) / (kind + '-model-workspace')
                (workspace / 'scripts').mkdir(parents=True)
                (workspace / 'checkpoints').mkdir()
                loader = workspace / 'scripts/infer_apex_audio.py'
                checkpoint = workspace / 'checkpoints/BEATs_strong_1.pt'
                loader.write_text('controlled external loader version one')
                checkpoint.write_bytes(b'controlled checkpoint version one')
                adapter = self.adapter(kind, worker='edge_model_worker.py', workspace=workspace,
                                       checkpoint=checkpoint, events=[[0.08, 0.2, 0]])
                media = self.media(adapter, self.multitrack)
                first = self.analyze(adapter, media)
                checkpoint.write_bytes(b'controlled checkpoint version two')
                with self.assertRaises(ServiceError) as old_weight:
                    adapter.execute('recompute_candidates', {
                        'result_id': first['result_id'], 'candidate_version': first['candidate_version'],
                        'parameters': {'before_s': 0.1}})
                self.assertEqual(('analysis_configuration_changed', 409),
                                 (old_weight.exception.code, old_weight.exception.status))
                second = self.analyze(adapter, media)
                self.assertNotEqual(first['prediction']['model']['checkpoint_sha256'],
                                    second['prediction']['model']['checkpoint_sha256'])
                loader.write_text('controlled external loader version two')
                with self.assertRaises(ServiceError) as old_loader:
                    adapter.execute('request_preview', {
                        'result_id': second['result_id'], 'candidate_version': second['candidate_version'],
                        'candidate_id': second['candidates'][0]['candidate_id']})
                self.assertEqual(('analysis_configuration_changed', 409),
                                 (old_loader.exception.code, old_loader.exception.status))
                third = self.analyze(adapter, media)
                self.assertNotEqual(second['prediction']['configuration']['files']['loader']['sha256'],
                                    third['prediction']['configuration']['files']['loader']['sha256'])
                self.assertEqual(3, len({item['prediction_id'] for item in (first, second, third)}))
                self.assertEqual(3, len({item['prediction']['cache_key'] for item in (first, second, third)}))
                self.assertEqual(3, len({item['prediction']['runtime']['engine_instance_id']
                                         for item in (first, second, third)}))
                self.assertEqual([(False, 1), (False, 1), (False, 1)],
                                 [(item['prediction']['runtime']['model_reused'],
                                   item['prediction']['runtime']['inference_index'])
                                  for item in (first, second, third)])

    def test_model_process_crash_is_reported_and_the_next_task_builds_a_new_engine(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                marker = Path(self.data.name) / (kind + '-crashed-model-marker.json')
                release = Path(self.data.name) / (kind + '-crashed-model-release')
                adapter = self.adapter(kind, worker='edge_model_worker.py', marker=str(marker),
                                       gate=str(release), events=[[0.08, 0.2, 0]])
                media = self.media(adapter, self.multitrack)
                submitted = adapter.execute('analyze', {'media_id': media['media_id']})
                try:
                    target = self.await_marker(marker)
                    self.assertGreater(target['pid'], 0)
                    self.assertNotEqual(os.getpid(), target['pid'])
                    # The external fixture reports its own PID. Only the model
                    # target is killed; the service and process guardian survive.
                    os.kill(target['pid'], signal.SIGKILL)
                    crashed = self.wait(adapter, submitted)
                    self.assertEqual(('failed', 'model_inference_failed', None),
                                     (crashed['status'], crashed['error']['code'], crashed['result_id']))
                    self.assertEqual('model_inference_failed', crashed['results'][0]['error']['code'])
                    self.assertEqual('failed', adapter.execute('get_config', {})['model_state'])
                    with self.assertRaises(ProcessLookupError):
                        os.kill(target['pid'], 0)
                    release.touch()
                    recovered = self.analyze(adapter, media)
                    next_target = self.await_marker(marker)
                    self.assertNotEqual(target['pid'], next_target['pid'])
                    runtime = recovered['prediction']['runtime']
                    self.assertNotEqual(crashed['engine_runtime']['engine_instance_id'], runtime['engine_instance_id'])
                    self.assertEqual((False, 1, 19),
                                     (runtime['model_reused'], runtime['inference_index'],
                                      recovered['prediction']['frame_count']))
                finally:
                    release.touch()

    def test_active_analysis_rejects_duplicate_submission_without_blocking_status_queries(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                marker = Path(self.data.name) / (kind + '-busy-model-marker.json')
                release = Path(self.data.name) / (kind + '-busy-model-release')
                adapter = self.adapter(kind, worker='edge_model_worker.py', marker=str(marker),
                                       gate=str(release), events=[[0.08, 0.2, 0]])
                media = self.media(adapter, self.multitrack)
                submitted = adapter.execute('analyze', {'media_id': media['media_id']})
                try:
                    self.await_marker(marker)
                    with self.assertRaises(ServiceError) as duplicate:
                        adapter.execute('analyze', {'media_id': media['media_id']})
                    self.assertEqual(('task_busy', 409), (duplicate.exception.code, duplicate.exception.status))
                    queried_at = time.monotonic()
                    running = adapter.execute('get_task', submitted)
                    self.assertLess(time.monotonic() - queried_at, 1.0)
                    self.assertEqual(('running', submitted['task_id']), (running['status'], running['task_id']))
                    release.touch()
                    self.assertEqual('completed', self.wait(adapter, submitted)['status'])
                finally:
                    release.touch()

    def test_parameters_reject_invalid_types_and_old_version_previews_through_both_entries(self):
        recording = self.recording('参数边界录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                result = self.analyze(adapter, self.media(adapter, recording))
                reference = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                preview = self.wait(adapter, adapter.execute('request_preview', {
                    **reference, 'candidate_id': result['candidates'][0]['candidate_id']}))
                self.assertEqual('completed', preview['status'], preview)
                invalid = [None, True, False, '0.2', [], {}, float('nan'), float('inf'), float('-inf'), -1]
                for key in ('threshold', 'merge_gap_s', 'before_s', 'after_s'):
                    for value in invalid + ([1.01] if key == 'threshold' else []):
                        with self.subTest(entry=kind, parameter=key, value=value):
                            with self.assertRaises(ServiceError) as rejected:
                                adapter.execute('recompute_candidates', {**reference, 'parameters': {key: value}})
                            self.assertEqual(('invalid_parameters', 422),
                                             (rejected.exception.code, rejected.exception.status))
                for value in (None, [], 'parameters', {'unknown_setting': 1}):
                    with self.subTest(entry=kind, parameters=value):
                        with self.assertRaises(ServiceError) as rejected:
                            adapter.execute('recompute_candidates', {**reference, 'parameters': value})
                        self.assertEqual(('invalid_parameters', 422),
                                         (rejected.exception.code, rejected.exception.status))
                unchanged = adapter.execute('get_result', {'result_id': result['result_id']})
                self.assertEqual(result, unchanged)
                renewed = adapter.execute('recompute_candidates', {**reference, 'parameters': {'threshold': 0.2}})
                self.assertNotEqual(result['candidate_version'], renewed['candidate_version'])
                self.assertEqual([(0.0, 7.4), (9.0, 19.4)],
                                 [(round(c['start_s'], 2), round(c['end_s'], 2)) for c in renewed['candidates']])
                with self.assertRaises(ServiceError) as old_cache:
                    adapter.execute('get_artifact', {'artifact_id': preview['preview_id']})
                self.assertEqual(('stale_preview', 409), (old_cache.exception.code, old_cache.exception.status))
                with self.assertRaises(ServiceError) as old_request:
                    adapter.execute('request_preview', {**reference, 'candidate_id': result['candidates'][0]['candidate_id']})
                self.assertEqual(('stale_candidates', 409), (old_request.exception.code, old_request.exception.status))
                for threshold, count in [(0, 2), (1, 0)]:
                    renewed = adapter.execute('recompute_candidates', {
                        'result_id': renewed['result_id'], 'candidate_version': renewed['candidate_version'],
                        'parameters': {'threshold': threshold, 'merge_gap_s': 0, 'before_s': 0, 'after_s': 0}})
                    self.assertEqual(count, len(renewed['candidates']))
                    self.assertEqual(result['prediction'], renewed['prediction'])

    def test_range_edit_invalidates_only_its_preview_and_retains_the_other_candidate_cache(self):
        recording = self.recording('独立预览缓存录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                result = self.analyze(adapter, self.media(adapter, recording))
                reference = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                first, second = [candidate['candidate_id'] for candidate in result['candidates']]
                old_first = self.wait(adapter, adapter.execute('request_preview', {**reference, 'candidate_id': first}))
                unchanged_second = self.wait(adapter, adapter.execute('request_preview', {**reference, 'candidate_id': second}))
                self.assertEqual(('completed', 'completed'), (old_first['status'], unchanged_second['status']))
                original_second = adapter.execute('get_artifact', {'artifact_id': unchanged_second['preview_id']})
                saved = adapter.execute('update_selection', {**reference, 'clips': [
                    {'candidate_id': first, 'start_s': 1.1, 'end_s': 2.7}]})
                self.assertEqual(result['candidates'], saved['candidates'])
                with self.assertRaises(ServiceError) as stale_first:
                    adapter.execute('get_artifact', {'artifact_id': old_first['preview_id']})
                self.assertEqual(('stale_preview', 409), (stale_first.exception.code, stale_first.exception.status))
                retained_second = adapter.execute('get_artifact', {'artifact_id': unchanged_second['preview_id']})
                self.assertEqual(original_second, retained_second)
                repeat_second = self.wait(adapter, adapter.execute('request_preview', {**reference, 'candidate_id': second}))
                self.assertEqual(unchanged_second['preview_id'], repeat_second['preview_id'])
                new_first = self.wait(adapter, adapter.execute('request_preview', {**reference, 'candidate_id': first}))
                self.assertEqual('completed', new_first['status'], new_first)
                self.assertNotEqual(old_first['preview_id'], new_first['preview_id'])
                replacement = adapter.execute('get_artifact', {'artifact_id': new_first['preview_id']})
                self.assertEqual({'start_s': 1.1, 'end_s': 2.7}, replacement['requested_range'])

    def test_deselecting_all_existing_candidates_rejects_export_without_creating_output(self):
        recording = self.recording('全不选录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                result = self.analyze(adapter, self.media(adapter, recording))
                self.assertEqual(2, len(result['candidates']))
                reference = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                saved = adapter.execute('update_selection', {**reference, 'clips': [
                    {'candidate_id': candidate['candidate_id'], 'selected': False}
                    for candidate in result['candidates']]})
                self.assertEqual([False, False], [item['selected'] for item in saved['selection']])
                self.assertEqual(result['candidates'], saved['candidates'])
                previous_task = adapter.execute('get_config', {})['latest_task_id']
                output = Path(self.data.name) / (kind + '-全不选输出')
                with self.assertRaises(ServiceError) as empty:
                    adapter.execute('export', {**reference, 'output_dir': str(output), 'mode': 'copy'})
                self.assertEqual(('empty_selection', 422), (empty.exception.code, empty.exception.status))
                self.assertFalse(output.exists())
                self.assertEqual(previous_task, adapter.execute('get_config', {})['latest_task_id'])

    def test_exports_follow_request_time_and_repeat_without_overwriting_and_reject_unsupported_modes(self):
        recording = self.recording('排序独立输出录像.mp4', 24)
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                result = self.analyze(adapter, self.media(adapter, recording))
                first, second = result['candidates']
                reference = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                adapter.execute('update_selection', {**reference, 'clips': [
                    {'candidate_id': first['candidate_id'], 'start_s': 15.3, 'end_s': 16.7},
                    {'candidate_id': second['candidate_id'], 'start_s': 2.3, 'end_s': 3.7}]})
                request = {**reference, 'output_dir': str(Path(self.data.name) / (kind + '-排序输出')), 'mode': 'copy'}
                exported = self.wait(adapter, adapter.execute('export', request))
                self.assertEqual(('completed', 2), (exported['status'], len(exported['exports'])))
                self.assertEqual([(second['candidate_id'], {'start_s': 2.3, 'end_s': 3.7}),
                                  (first['candidate_id'], {'start_s': 15.3, 'end_s': 16.7})],
                                 [(item['candidate_id'], item['requested_range']) for item in exported['exports']])
                self.assertEqual(['001.mp4', '002.mp4'], [Path(item['path']).name for item in exported['exports']])
                originals = []
                for item in exported['exports']:
                    artifact = adapter.execute('get_artifact', {'artifact_id': item['artifact_id']})
                    self.assertEqual(('copy', 'completed', 'export'),
                                     (artifact['mode'], artifact['status'], artifact['kind']))
                    originals.append((item['artifact_id'], Path(artifact['path']).read_bytes()))
                repeated = self.wait(adapter, adapter.execute('export', request))
                self.assertEqual(('completed', 2), (repeated['status'], len(repeated['exports'])))
                self.assertTrue({item['path'] for item in exported['exports']}.isdisjoint(
                    item['path'] for item in repeated['exports']))
                for artifact_id, content in originals:
                    artifact = adapter.execute('get_artifact', {'artifact_id': artifact_id})
                    self.assertEqual(content, Path(artifact['path']).read_bytes())
                    subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror',
                                    '-i', artifact['path'], '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
                unavailable = Path(self.data.name) / (kind + '-precise-output')
                with self.assertRaises(ServiceError) as precise:
                    adapter.execute('export', {**reference, 'output_dir': str(unavailable), 'mode': 'precise'})
                self.assertEqual(('export_mode_unavailable', 422), (precise.exception.code, precise.exception.status))
                self.assertFalse(unavailable.exists())
                lossless_adapter = self.adapter(kind, events=[[0.08, 0.2, 0]])
                lossless = self.analyze(lossless_adapter, self.media(lossless_adapter, self.multitrack))
                unsupported = Path(self.data.name) / (kind + '-unsupported-copy-output')
                with self.assertRaises(ServiceError) as incompatible:
                    lossless_adapter.execute('export', {'result_id': lossless['result_id'],
                        'candidate_version': lossless['candidate_version'], 'output_dir': str(unsupported), 'mode': 'copy'})
                self.assertEqual(('copy_incompatible', 422), (incompatible.exception.code, incompatible.exception.status))
                self.assertFalse(unsupported.exists())
