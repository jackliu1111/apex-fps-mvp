"""Shared logical operations observed through the real local HTTP entry point."""
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from model_service import ModelService
from model_web import create_server


class ModelHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixtures.name) / '中文 HTTP 录像.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-n',
                        '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=6',
                        '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=6',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0',
                        '-c:a', 'aac', str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        spec = Path(self.data.name) / 'predictions.json'
        spec.write_text(json.dumps({'events': [[1, 1.4, 0]]}))
        self.service = ModelService(data_dir=self.data.name,
                                    ffmpeg=shutil.which('ffmpeg'),
                                    ffprobe=shutil.which('ffprobe'),
                                    model_command=[sys.executable, str(Path(__file__).parent
                                                   / 'fixtures/model_worker.py'), str(spec)])
        self.server = create_server(self.service, port=0, token='contract-access-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()
        self.data.cleanup()

    def request(self, method, path, *, payload=None, raw=None, token='contract-access-token',
                headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        request_headers = {'Content-Type': 'application/json', **(headers or {})}
        if token is not None:
            request_headers['X-Apex-Token'] = token
        connection.request(method, path, raw if raw is not None else
                           json.dumps(payload) if payload is not None else None,
                           request_headers)
        response = connection.getresponse()
        body = response.read()
        status, response_headers = response.status, dict(response.getheaders())
        connection.close()
        if response_headers.get('Content-Type', '').startswith('application/json'):
            body = json.loads(body)
        return status, body, response_headers

    def wait(self, task_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status, task, _ = self.request('GET', '/api/tasks/' + task_id)
            self.assertEqual(200, status, task)
            if task['status'] in ('completed', 'failed', 'cancelled'):
                return task
            time.sleep(0.02)
        self.fail('HTTP task did not finish')

    def analyzed_result(self):
        status, media, _ = self.request('POST', '/api/probe', payload={'path': str(self.video)})
        self.assertEqual(200, status, media)
        status, confirmed, _ = self.request('POST', '/api/confirm-audio', payload={
            'media_id': media['media_id'], 'stream_index': 1})
        self.assertEqual(200, status, confirmed)
        status, submitted, _ = self.request('POST', '/api/analyze', payload={'media_ids': [media['media_id']]})
        self.assertEqual(202, status, submitted)
        task = self.wait(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        status, result, _ = self.request('GET', '/api/results/' + task['result_id'])
        self.assertEqual(200, status, result)
        return result

    def test_review_and_task_commands_reject_malformed_json_over_http(self):
        for path in ('/api/recompute-candidates', '/api/update-selection', '/api/preview',
                     '/api/export', '/api/cancel'):
            with self.subTest(path=path):
                status, body, _ = self.request('POST', path, raw='{broken')
                self.assertEqual((400, 'invalid_request'), (status, body['error']['code']))

    def test_reviewed_preview_is_seekable_over_authenticated_http(self):
        result = self.analyzed_result()
        candidate = result['candidates'][0]['candidate_id']
        ref = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
        status, saved, _ = self.request('POST', '/api/update-selection', payload={**ref, 'clips': [
            {'candidate_id': candidate, 'start_s': 1.1, 'end_s': 2.3}]})
        self.assertEqual(200, status, saved)
        status, submitted, _ = self.request('POST', '/api/preview', payload={**ref, 'candidate_id': candidate})
        self.assertEqual(202, status, submitted)
        task = self.wait(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        path = '/api/artifacts/' + task['preview_id']
        status, metadata, _ = self.request('GET', path)
        self.assertEqual((200, {'start_s': 1.1, 'end_s': 2.3}), (status, metadata.get('requested_range')))
        status, content, headers = self.request('GET', path + '/content', headers={'Range': 'bytes=4-7'})
        self.assertEqual((206, b'ftyp', '4'), (status, content, headers.get('Content-Length')))
        self.assertEqual(f'bytes 4-7/{metadata["size"]}', headers['Content-Range'])
        status, whole, headers = self.request('GET', path + '/content?token=contract-access-token', token=None)
        self.assertEqual((200, metadata['size'], 'video/mp4'),
                         (status, len(whole), headers.get('Content-Type')))
        status, suffix, headers = self.request('GET', path + '/content', headers={'Range': 'bytes=-12'})
        self.assertEqual((206, whole[-12:], '12'), (status, suffix, headers.get('Content-Length')))
        status, body, headers = self.request('GET', path + '/content', headers={'Range': 'bytes=99999999999-'})
        self.assertEqual((416, b'', f'bytes */{metadata["size"]}'), (status, body, headers.get('Content-Range')))
        self.request('POST', '/api/update-selection', payload={**ref, 'clips': [
            {'candidate_id': candidate, 'start_s': 1.2, 'end_s': 2.3}]})
        status, body, _ = self.request('GET', path + '/content?token=contract-access-token', token=None)
        self.assertEqual((409, 'stale_preview'), (status, body['error']['code']))

    def test_resource_query_token_does_not_authorize_service_commands(self):
        for path in ('/api/config?token=contract-access-token',
                     '/api/artifacts/' + '0' * 32 + '?token=contract-access-token'):
            with self.subTest(path=path):
                status, body, _ = self.request('GET', path, token=None)
                self.assertEqual((401, 'unauthorized'), (status, body['error']['code']))
        status, body, _ = self.request('GET', '/api/artifacts/' + '0' * 32
                                       + '/content?token=contract-access-token', token=None,
                                       headers={'Origin': 'https://foreign.invalid'})
        self.assertEqual((403, 'invalid_origin'), (status, body['error']['code']))

    def test_parameter_recalculation_round_trips_a_new_candidate_version_over_http(self):
        result = self.analyzed_result()
        status, updated, _ = self.request('POST', '/api/recompute-candidates', payload={
            'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
            'parameters': {'threshold': 1, 'merge_gap_s': 5, 'before_s': 5, 'after_s': 5}})
        self.assertEqual((200, [], []), (status, updated['candidates'], updated['selection']))
        self.assertEqual(result['prediction_id'], updated['prediction_id'])
        self.assertNotEqual(result['candidate_version'], updated['candidate_version'])

    def test_http_export_returns_independent_registered_outputs(self):
        result = self.analyzed_result()
        status, submitted, _ = self.request('POST', '/api/export', payload={
            'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
            'output_dir': str(Path(self.data.name) / '独立 输出'), 'mode': 'copy'})
        self.assertEqual(202, status, submitted)
        task = self.wait(submitted['task_id'])
        self.assertEqual(('completed', 1), (task['status'], len(task['exports'])))
        artifact_id = task['exports'][0]['artifact_id']
        status, artifact, _ = self.request('GET', '/api/artifacts/' + artifact_id)
        self.assertEqual((200, 'export', 'copy'), (status, artifact['kind'], artifact['mode']))
        status, content, _ = self.request('GET', '/api/artifacts/' + artifact_id + '/content',
                                         headers={'Range': 'bytes=4-7'})
        self.assertEqual((206, b'ftyp'), (status, content))
