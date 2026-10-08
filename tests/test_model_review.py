"""Review and export behavior through the shared logical service operations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from model_service import ModelService, ServiceError


class ModelReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg, cls.ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixtures.name) / '中文 游戏录像.mp4'
        subprocess.run([
            cls.ffmpeg, '-nostdin', '-v', 'error', '-n',
            '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=24',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=24',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0',
            '-c:a', 'aac', '-output_ts_offset', '3', str(cls.video),
        ], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        spec = Path(self.data.name) / 'predictions.json'
        spec.write_text(json.dumps({'events': [[2, 2.4, 0], [14, 14.4, 1]]}))
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
                                    ffprobe=self.ffprobe, model_command=[sys.executable,
                                    str(Path(__file__).parent / 'fixtures/model_worker.py'), str(spec)])

    def tearDown(self):
        self.service.close()
        self.data.cleanup()

    def wait(self, submitted):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            task = self.service.execute('get_task', submitted)
            if task['status'] in ('completed', 'failed', 'cancelled'):
                return task
            time.sleep(0.02)
        self.fail('task did not finish')

    def analyze(self):
        media = self.service.execute('probe_media', {'path': str(self.video)})
        self.service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})
        task = self.wait(self.service.execute('analyze', {'media_id': media['media_id']}))
        self.assertEqual('completed', task['status'], task)
        return self.service.execute('get_result', {'result_id': task['result_id']})

    def ref(self, result):
        return {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}

    def gated_media_tool(self, *, second_export=False, fail=False):
        marker = Path(self.data.name) / 'media-started.json'
        release = Path(self.data.name) / 'release-media'
        wrapper = Path(self.data.name) / 'controlled-ffmpeg'
        wrapper.write_text(f'''#!{sys.executable}
import json, os, pathlib, sys, time
args = sys.argv[1:]
target = pathlib.Path(args[-1])
controlled = 'libx264' in args if {not second_export!r} else target.name == '002.mp4'
if controlled:
    target.write_bytes(b'partial media')
    pathlib.Path({str(marker)!r}).write_text(json.dumps({{'pid': os.getpid(), 'path': str(target)}}))
    while not pathlib.Path({str(release)!r}).exists(): time.sleep(0.01)
    if {fail!r}: sys.exit(13)
os.execv({self.ffmpeg!r}, [{self.ffmpeg!r}, *args])
''')
        wrapper.chmod(0o755)
        self.service.ffmpeg = str(wrapper)
        return marker, release

    def await_media(self, marker):
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(marker.exists(), 'external media fixture did not start')
        return json.loads(marker.read_text())

    def test_range_edit_and_deselection_preserve_automatic_candidates_and_prediction(self):
        result = self.analyze()
        prediction = self.service.execute('read_scores', {'prediction_id': result['prediction_id'],
                                                          'start_s': 0, 'end_s': 1})
        first, second = result['candidates']
        changed = self.service.execute('update_selection', {**self.ref(result), 'clips': [
            {'candidate_id': first['candidate_id'], 'selected': False, 'start_s': 1, 'end_s': 5}]})
        saved = self.service.execute('get_result', {'result_id': result['result_id']})
        self.assertEqual((False, 1, 5, second['start_s'], second['end_s']),
                         (saved['selection'][0]['selected'], saved['selection'][0]['start_s'],
                          saved['selection'][0]['end_s'], saved['selection'][1]['start_s'],
                          saved['selection'][1]['end_s']))
        self.assertEqual(result['candidates'], changed['candidates'])
        self.assertEqual(prediction, self.service.execute('read_scores', {
            'prediction_id': result['prediction_id'], 'start_s': 0, 'end_s': 1}))

    def test_invalid_ranges_do_not_apply_any_part_of_a_selection_update(self):
        result = self.analyze()
        candidate = result['candidates'][0]
        for start, end in [(-1, 5), (2, 2), (5, 2), (0, 25), (False, 2),
                           (float('nan'), 2), (0, float('inf')), ('bad', 2)]:
            with self.subTest(start=start, end=end):
                with self.assertRaises(ServiceError) as rejected:
                    self.service.execute('update_selection', {**self.ref(result), 'clips': [
                        {'candidate_id': candidate['candidate_id'], 'selected': False,
                         'start_s': start, 'end_s': end}]})
                self.assertEqual('invalid_range', rejected.exception.code)
        self.assertEqual(result['selection'], self.service.execute('get_result', {
            'result_id': result['result_id']})['selection'])

    def test_preview_task_reports_media_stage_timing_and_log_path(self):
        result = self.analyze()
        task = self.wait(self.service.execute('request_preview', {
            **self.ref(result), 'candidate_id': result['candidates'][0]['candidate_id']}))
        self.assertGreater(task['timings']['previewing'], 0)
        self.assertTrue(Path(task['media_log']).is_file())

    def test_export_cannot_write_into_prediction_storage_or_source_file(self):
        result = self.analyze()
        for destination in (str(Path(result['prediction']['metadata_path']).parent), str(self.video), None):
            with self.subTest(destination=destination):
                with self.assertRaises(ServiceError) as rejected:
                    self.service.execute('export', {**self.ref(result), 'output_dir': destination})
                self.assertEqual('invalid_output_dir', rejected.exception.code)

    def test_preview_generates_only_requested_range_as_playable_media(self):
        result = self.analyze()
        candidate = result['candidates'][0]['candidate_id']
        result = self.service.execute('update_selection', {**self.ref(result), 'clips': [
            {'candidate_id': candidate, 'start_s': 2.3, 'end_s': 3.7}]})
        task = self.wait(self.service.execute('request_preview', {
            **self.ref(result), 'candidate_id': candidate}))
        self.assertEqual('completed', task['status'], task)
        artifact = self.service.execute('get_artifact', {'artifact_id': task['preview_id']})
        self.assertEqual({'start_s': 2.3, 'end_s': 3.7}, artifact['requested_range'])
        self.assertEqual('preview', artifact['kind'])
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror',
                        '-i', artifact['path'], '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
        info = json.loads(subprocess.check_output([self.ffprobe, '-v', 'error',
                         '-show_streams', '-of', 'json', artifact['path']]))
        self.assertAlmostEqual(1.4, float(info['streams'][0]['duration']), places=2)

    def test_preview_cache_tracks_range_and_preserves_other_candidates(self):
        result = self.analyze()
        first, second = [c['candidate_id'] for c in result['candidates']]
        one = self.wait(self.service.execute('request_preview', {**self.ref(result), 'candidate_id': first}))
        two = self.wait(self.service.execute('request_preview', {**self.ref(result), 'candidate_id': second}))
        repeat = self.wait(self.service.execute('request_preview', {**self.ref(result), 'candidate_id': first}))
        self.assertEqual(one['preview_id'], repeat['preview_id'])
        self.service.execute('update_selection', {**self.ref(result), 'clips': [
            {'candidate_id': first, 'start_s': 1, 'end_s': 4}]})
        with self.assertRaises(ServiceError) as stale:
            self.service.execute('get_artifact', {'artifact_id': one['preview_id']})
        self.assertEqual('stale_preview', stale.exception.code)
        self.assertEqual(two['preview_id'], self.service.execute('get_artifact', {
            'artifact_id': two['preview_id']})['artifact_id'])
        replacement = self.wait(self.service.execute('request_preview', {
            **self.ref(result), 'candidate_id': first}))
        self.assertNotEqual(one['preview_id'], replacement['preview_id'])

    def test_selected_candidates_export_independently_with_measured_copy_boundaries(self):
        result = self.analyze()
        result = self.service.execute('update_selection', {**self.ref(result), 'clips': [
            {'candidate_id': result['candidates'][0]['candidate_id'], 'start_s': 2.3, 'end_s': 3.7},
            {'candidate_id': result['candidates'][1]['candidate_id'], 'start_s': 14.3, 'end_s': 15.7}]})
        request = {**self.ref(result), 'output_dir': str(Path(self.data.name) / '中文 输出')}
        task = self.wait(self.service.execute('export', request))
        self.assertEqual('completed', task['status'], task)
        self.assertEqual([({'start_s': 2.3, 'end_s': 3.7}, {'start_s': 2.0, 'end_s': 3.7}),
                          ({'start_s': 14.3, 'end_s': 15.7}, {'start_s': 14.0, 'end_s': 15.7})],
                         [(entry['requested_range'], {k: round(v, 3) for k, v in entry['actual_range'].items()})
                          for entry in task['exports']])
        for entry in task['exports']:
            self.assertEqual(('completed', 'copy', result['candidate_version'], result['prediction_id']),
                             (entry['status'], entry['mode'], entry['candidate_version'], entry['prediction_id']))
            subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', entry['path'],
                            '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
        repeat = self.wait(self.service.execute('export', request))
        self.assertEqual('completed', repeat['status'], repeat)
        self.assertTrue(set(e['path'] for e in task['exports']).isdisjoint(e['path'] for e in repeat['exports']))
        self.assertTrue(all(Path(e['path']).is_file() for e in task['exports']))

    def test_empty_selection_is_rejected_without_creating_output(self):
        result = self.analyze()
        self.service.execute('update_selection', {**self.ref(result), 'clips': [
            {'candidate_id': candidate['candidate_id'], 'selected': False}
            for candidate in result['candidates']]})
        output = Path(self.data.name) / 'empty-export'
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('export', {**self.ref(result), 'output_dir': str(output)})
        self.assertEqual('empty_selection', rejected.exception.code)
        self.assertFalse(output.exists())

    def test_source_change_rejects_cached_preview_and_new_media_operations(self):
        self.video = Path(self.data.name) / 'mutable.mp4'
        shutil.copyfile(type(self).video, self.video)
        result = self.analyze()
        request = {**self.ref(result), 'candidate_id': result['candidates'][0]['candidate_id']}
        preview = self.wait(self.service.execute('request_preview', request))
        with self.video.open('ab') as stream:
            stream.write(b'changed source')
        for operation, payload in [('get_artifact', {'artifact_id': preview['preview_id']}),
                                   ('request_preview', request),
                                   ('export', {**self.ref(result), 'output_dir': str(Path(self.data.name) / 'changed')})]:
            with self.subTest(operation=operation):
                with self.assertRaises(ServiceError) as rejected:
                    self.service.execute(operation, payload)
                self.assertEqual('source_changed', rejected.exception.code)

    def test_unavailable_export_mode_is_rejected_instead_of_silently_copying(self):
        result = self.analyze()
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('export', {**self.ref(result), 'mode': 'precise',
                                            'output_dir': str(Path(self.data.name) / 'unsupported')})
        self.assertEqual('export_mode_unavailable', rejected.exception.code)

    def test_incompatible_copy_stream_is_refused_before_creating_an_export(self):
        self.video = Path(self.data.name) / 'lossless.mkv'
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n', '-i', str(type(self).video),
                        '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(self.video)], check=True)
        result = self.analyze()
        output = Path(self.data.name) / 'incompatible-export'
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('export', {**self.ref(result), 'output_dir': str(output)})
        self.assertEqual('copy_incompatible', rejected.exception.code)
        self.assertFalse(output.exists())

    def test_cancelling_preview_stops_media_before_publishing_cancelled(self):
        result = self.analyze()
        marker, release = self.gated_media_tool()
        submitted = self.service.execute('request_preview', {
            **self.ref(result), 'candidate_id': result['candidates'][0]['candidate_id']})
        try:
            process = self.await_media(marker)
            cancelling = self.service.execute('cancel_task', submitted)
            self.assertEqual('cancelling', cancelling['status'])
            deadline = time.monotonic() + 1
            task = cancelling
            while task['status'] == 'cancelling' and time.monotonic() < deadline:
                time.sleep(0.02)
                task = self.service.execute('get_task', submitted)
            self.assertEqual('cancelled', task['status'], task)
            self.assertFalse(Path(process['path']).exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(process['pid'], 0)
        finally:
            release.touch()

    def test_failed_second_export_preserves_first_file_and_records_failed_item(self):
        result = self.analyze()
        marker, release = self.gated_media_tool(second_export=True, fail=True)
        submitted = self.service.execute('export', {**self.ref(result),
            'output_dir': str(Path(self.data.name) / 'partial-exports')})
        process = self.await_media(marker)
        release.touch()
        task = self.wait(submitted)
        self.assertEqual(('failed', 'media_failed', ['completed', 'failed']),
                         (task['status'], task['error']['code'], [e['status'] for e in task['exports']]))
        self.assertFalse(Path(process['path']).exists())
        first = self.service.execute('get_artifact', {'artifact_id': task['exports'][0]['artifact_id']})
        self.assertTrue(Path(first['path']).is_file())
        self.assertIsNone(task['exports'][1]['path'])

    def test_cancelled_second_export_preserves_finished_file_and_cleans_partial(self):
        result = self.analyze()
        marker, release = self.gated_media_tool(second_export=True)
        submitted = self.service.execute('export', {**self.ref(result),
            'output_dir': str(Path(self.data.name) / 'cancelled-exports')})
        try:
            process = self.await_media(marker)
            self.service.execute('cancel_task', submitted)
            task = self.wait(submitted)
            self.assertEqual(('cancelled', ['completed', 'cancelled']),
                             (task['status'], [e['status'] for e in task['exports']]))
            self.assertFalse(Path(process['path']).exists())
            self.assertTrue(Path(task['exports'][0]['path']).is_file())
        finally:
            release.touch()

    def test_host_interruption_marks_current_export_failed_and_preserves_finished_file(self):
        result = self.analyze()
        marker, release = self.gated_media_tool(second_export=True)
        submitted = self.service.execute('export', {**self.ref(result),
            'output_dir': str(Path(self.data.name) / 'interrupted-exports')})
        try:
            process = self.await_media(marker)
            self.service.close(interrupted=True)
            self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
            task = self.service.execute('get_task', submitted)
            self.assertEqual(('failed', 'service_interrupted', ['completed', 'failed'], 'service_interrupted'),
                             (task['status'], task['error']['code'], [entry['status'] for entry in task['exports']],
                              task['exports'][1]['error']['code']))
            self.assertFalse(Path(process['path']).exists())
            self.assertTrue(Path(task['exports'][0]['path']).is_file())
        finally:
            release.touch()

    def test_recomputed_candidates_reject_old_selection_and_preview(self):
        result = self.analyze()
        preview = self.wait(self.service.execute('request_preview', {
            **self.ref(result), 'candidate_id': result['candidates'][0]['candidate_id']}))
        updated = self.service.execute('recompute_candidates', {**self.ref(result),
                                      'parameters': {'threshold': 0.9}})
        self.assertEqual([], updated['selection'])
        with self.assertRaises(ServiceError) as stale_selection:
            self.service.execute('update_selection', {**self.ref(result), 'clips': []})
        self.assertEqual('stale_candidates', stale_selection.exception.code)
        with self.assertRaises(ServiceError) as stale_preview:
            self.service.execute('get_artifact', {'artifact_id': preview['preview_id']})
        self.assertEqual('stale_preview', stale_preview.exception.code)

    def test_malformed_review_requests_return_contract_errors_without_writes(self):
        result = self.analyze()
        for clips in (None, 'all', [None], [{'candidate_id': []}],
                      [{'candidate_id': result['candidates'][0]['candidate_id'], 'selected': 'false'}]):
            with self.subTest(clips=clips):
                with self.assertRaises(ServiceError) as rejected:
                    self.service.execute('update_selection', {**self.ref(result), 'clips': clips})
                self.assertEqual(('invalid_request', 400), (rejected.exception.code, rejected.exception.status))
        self.assertEqual(result['selection'], self.service.execute('get_result', {
            'result_id': result['result_id']})['selection'])

    def test_unknown_candidate_is_rejected_without_changing_valid_candidates(self):
        result = self.analyze()
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('update_selection', {**self.ref(result), 'clips': [
                {'candidate_id': result['candidates'][0]['candidate_id'], 'selected': False},
                {'candidate_id': 'unknown', 'selected': True}]})
        self.assertEqual('candidate_not_found', rejected.exception.code)
        self.assertEqual(result['selection'], self.service.execute('get_result', {
            'result_id': result['result_id']})['selection'])
