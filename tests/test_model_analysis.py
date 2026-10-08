"""Analysis contract scenarios observed through HTTP and public service operations."""
import unittest
import time
import json
from pathlib import Path
import sys
import threading
import subprocess
import os
from model_service import ModelService, ServiceError
from model_web import create_server

import test_model_web as selection


class ModelAnalysisTests(unittest.TestCase):
    setUpClass = classmethod(selection.MediaSelectionTests.setUpClass.__func__)
    tearDownClass = classmethod(selection.MediaSelectionTests.tearDownClass.__func__)
    setUp = selection.MediaSelectionTests.setUp
    request = selection.MediaSelectionTests.request

    def tearDown(self):
        if hasattr(self.service, 'close'):
            self.service.close()
        selection.MediaSelectionTests.tearDown(self)

    def use_predictions(self, **fixture):
        self.service.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        spec = Path(self.data.name) / 'predictions.json'
        spec.write_text(json.dumps(fixture))
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
                                    ffprobe=self.ffprobe, model_command=[sys.executable,
                                    str(Path(__file__).parent / 'fixtures/model_worker.py'), str(spec)])
        self.server = create_server(self.service, port=0, token='test-access-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def confirmed_media(self):
        _, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        _, media = self.request('POST', '/api/confirm-audio', {
            'media_id': media['media_id'], 'stream_index': 1})
        return media

    def completed_task(self, task_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status, task = self.request('GET', '/api/tasks/' + task_id)
            self.assertEqual(200, status, task)
            if task['status'] in ('completed', 'failed'):
                return task
            time.sleep(0.02)
        self.fail('analysis did not reach a terminal state')

    def long_recording(self):
        self.video = Path(self.data.name) / '长 录像.mkv'
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n',
                        '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=80',
                        '-itsoffset', '0.25', '-f', 'lavfi', '-i',
                        'sine=sample_rate=16000:duration=79.75', '-c:v', 'ffv1',
                        '-c:a', 'pcm_s16le', '-output_ts_offset', '3', str(self.video)], check=True)

    def analyzed_result(self):
        media = self.confirmed_media()
        _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        task = self.completed_task(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        _, result = self.request('GET', '/api/results/' + task['result_id'])
        return result

    def test_score_range_rejects_invalid_bounds_instead_of_crashing_or_reading_everything(self):
        self.use_predictions()
        result = self.analyzed_result()
        for query in ('', '?start_s=no&end_s=1', '?start_s=NaN&end_s=1',
                      '?start_s=0&end_s=Infinity', '?start_s=-1&end_s=1',
                      '?start_s=1&end_s=0', '?start_s=0&end_s=2'):
            with self.subTest(query=query):
                status, error = self.request('GET', '/api/scores/' + result['prediction_id'] + query)
                self.assertEqual((422, 'invalid_range'), (status, error['error']['code']))

    def test_exact_five_second_gap_joins_events_before_padding(self):
        self.use_predictions(events=[[2.72, 2.88, 0], [7.88, 8.04, 1]])
        self.long_recording()
        result = self.analyzed_result()
        self.assertEqual([(0.0, 13.29)], [(c['start_s'], round(c['end_s'], 2))
                                          for c in result['candidates']])

    def test_gap_boundaries_padding_overlap_and_long_fire_keep_distinct_groups(self):
        self.use_predictions(events=[[0.04, 0.2, 0], [5.16, 5.32, 1],
                                    [10.36, 10.52, 0], [17.52, 17.68, 1], [30, 79.75, 0]])
        self.long_recording()
        result = self.analyzed_result()
        self.assertEqual([(0.0, 10.57), (5.61, 15.77), (12.77, 22.93), (25.25, 80.0)],
                         [(round(c['start_s'], 2), round(c['end_s'], 2)) for c in result['candidates']])

    def test_no_gunfire_still_saves_prediction_and_empty_candidate_result(self):
        self.use_predictions(events=[[0, 0.75, 2]])
        result = self.analyzed_result()
        self.assertEqual(([], [], 19), (result['events'], result['candidates'],
                                       result['prediction']['frame_count']))

    def test_model_load_and_inference_errors_remain_failed_without_a_result(self):
        for code in ('model_load_failed', 'model_inference_failed'):
            with self.subTest(code=code):
                self.use_predictions(error=code)
                media = self.confirmed_media()
                _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
                task = self.completed_task(submitted['task_id'])
                self.assertEqual(('failed', code, None),
                                 (task['status'], task['error']['code'], task['result_id']))

    def test_score_pages_bound_response_size_without_discarding_raw_frames(self):
        self.use_predictions()
        self.long_recording()
        result = self.analyzed_result()
        _, first = self.request('GET', '/api/scores/' + result['prediction_id'] + '?start_s=0&end_s=80')
        self.assertEqual((1000, 40.25), (len(first['scores']), first['next_start_s']))
        # Two pages recover every valid frame; neither depends on display sampling.
        _, last = self.request('GET', '/api/scores/' + result['prediction_id'] + '?start_s=40.25&end_s=80')
        self.assertEqual((994, None, 80), (len(last['scores']), last['next_start_s'], last['frame_offsets_s'][-1]))

    def test_invalid_model_scores_fail_analysis_instead_of_publishing_candidates(self):
        self.use_predictions(invalid_scores=True)
        media = self.confirmed_media()
        _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        task = self.completed_task(submitted['task_id'])
        self.assertEqual(('failed', 'model_inference_failed', None),
                         (task['status'], task['error']['code'], task['result_id']))

    def test_unknown_or_malformed_task_and_result_ids_return_contract_errors(self):
        for identifier in (None, [], '../../outside', '0' * 32):
            for operation, key, code in [('get_task', 'task_id', 'task_not_found'),
                                          ('get_result', 'result_id', 'result_not_found')]:
                with self.subTest(identifier=identifier, operation=operation):
                    with self.assertRaises(ServiceError) as rejected:
                        self.service.execute(operation, {key: identifier})
                    self.assertEqual((404, code), (rejected.exception.status, rejected.exception.code))

    def test_analysis_requires_explicit_audio_confirmation(self):
        _, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        status, error = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        self.assertEqual((422, 'audio_not_confirmed'), (status, error['error']['code']))

    def test_missing_model_configuration_becomes_queryable_failed_task(self):
        media = self.confirmed_media()
        status, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        self.assertEqual(202, status, submitted)
        task = self.completed_task(submitted['task_id'])
        self.assertEqual(('failed', 'model_load_failed', None),
                         (task['status'], task['error']['code'], task['result_id']))

    def test_analysis_saves_complete_prediction_and_mapped_candidates_readable_after_restart(self):
        self.use_predictions(events=[[0.08, 0.16, 0], [0.12, 0.2, 1]])
        media = self.confirmed_media()
        _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        task = self.completed_task(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        status, result = self.request('GET', '/api/results/' + task['result_id'])
        self.assertEqual(200, status, result)
        self.assertEqual([(0.33, 0.45)], [(round(e['start_s'], 2), round(e['end_s'], 2))
                                          for e in result['events']])
        self.assertEqual([(0.0, 1.0)], [(c['start_s'], c['end_s']) for c in result['candidates']])
        self.assertNotIn('scores', task)
        self.assertNotIn('scores', result)
        self.assertEqual((19, 0.75, 0.25, ['Gunshot, gunfire', 'Machine gun', 'Speech']),
                         (result['prediction']['frame_count'], result['prediction']['valid_duration_s'],
                          result['prediction']['audio_to_video_offset_s'], result['prediction']['classes']))
        _, scores = self.request('GET', '/api/scores/' + result['prediction_id'] + '?start_s=0.33&end_s=0.41')
        self.assertEqual([[0.75, 0.0, 0.0], [0.75, 0.75, 0.0]], scores['scores'])
        self.service.close()
        reopened = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
        saved = reopened.execute('get_result', {'result_id': task['result_id']})
        self.assertEqual(result, saved)
        self.assertEqual('completed', reopened.execute('get_task', {'task_id': task['task_id']})['status'])
        full = reopened.execute('read_scores', {'prediction_id': result['prediction_id'],
                                                'start_s': 0, 'end_s': 1})
        self.assertEqual((19, 1.0), (len(full['scores']), full['frame_offsets_s'][-1]))

    def test_busy_analysis_is_rejected_while_task_query_remains_responsive(self):
        gate = Path(self.data.name) / 'release-model'
        self.use_predictions(gate=str(gate))
        media = self.confirmed_media()
        _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        try:
            started = time.monotonic()
            status, task = self.request('GET', '/api/tasks/' + submitted['task_id'])
            self.assertEqual((200, 'running'), (status, task['status']))
            self.assertLess(time.monotonic() - started, 1)
            status, error = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
            self.assertEqual((409, 'task_busy'), (status, error['error']['code']))
        finally:
            gate.touch()
        self.assertEqual('completed', self.completed_task(submitted['task_id'])['status'])

    @unittest.skipUnless(os.environ.get('APEX_REAL_MODEL_WORKSPACE'), 'explicit local BEATs environment required')
    def test_real_beats_analysis_excludes_tail_padding_and_records_model_versions(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
                                    ffprobe=self.ffprobe,
                                    model_workspace=os.environ['APEX_REAL_MODEL_WORKSPACE'],
                                    engine_python=os.environ.get('APEX_ENGINE_PYTHON'))
        self.server = create_server(self.service, port=0, token='test-access-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        media = self.confirmed_media()
        _, submitted = self.request('POST', '/api/analyze', {'media_id': media['media_id']})
        task = self.completed_task(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        _, result = self.request('GET', '/api/results/' + task['result_id'])
        prediction = result['prediction']
        self.assertEqual((19, 0.75, 447, 'BEATs_strong_1'),
                         (prediction['frame_count'], prediction['valid_duration_s'],
                          len(prediction['classes']), prediction['model']['name']))
        self.assertEqual(64, len(prediction['model']['checkpoint_sha256']))
        self.assertEqual('beats-16k-mono-10s-5s-mean-v1', prediction['model']['preprocessing_version'])


if __name__ == '__main__':
    unittest.main()
