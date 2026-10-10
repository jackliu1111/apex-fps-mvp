"""Identical public operation scenarios through HTTP and NDJSON IPC adapters."""
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from model_ipc import serve
from model_service import ModelService, ServiceError
from model_web import create_server


class IpcAdapter:
    def __init__(self, service):
        request_read, request_write = os.pipe()
        response_read, response_write = os.pipe()
        self.source = os.fdopen(request_read, 'r', encoding='utf-8')
        self.writer = os.fdopen(request_write, 'w', encoding='utf-8')
        self.reader = os.fdopen(response_read, 'r', encoding='utf-8')
        self.sink = os.fdopen(response_write, 'w', encoding='utf-8')
        self.thread = threading.Thread(target=serve, args=(service, self.source, self.sink), daemon=True)
        self.thread.start()
        if json.loads(self.reader.readline())['type'] != 'ready':
            raise RuntimeError('IPC did not become ready')
        self.sequence = 0

    def execute(self, operation, payload):
        self.sequence += 1
        identifier = str(self.sequence)
        self.writer.write(json.dumps({'id': identifier, 'operation': operation, 'payload': payload}) + '\n')
        self.writer.flush()
        response = json.loads(self.reader.readline())
        if response['id'] != identifier:
            raise RuntimeError('IPC response correlation failed')
        if 'error' in response:
            error = response['error']
            raise ServiceError(error['code'], error['message'], error['status'])
        return response['result']

    def close(self):
        self.writer.close()
        self.thread.join(timeout=10)
        if self.thread.is_alive():
            raise RuntimeError('IPC failed to close and clean up tasks')
        for stream in (self.source, self.sink, self.reader):
            stream.close()


class HttpAdapter:
    POST = {'probe_media': '/api/probe', 'confirm_audio': '/api/confirm-audio',
            'analyze': '/api/analyze', 'recompute_candidates': '/api/recompute-candidates',
            'update_selection': '/api/update-selection', 'request_preview': '/api/preview',
            'export': '/api/export', 'cancel_task': '/api/cancel'}
    GET = {'get_config': ('/api/config', None), 'get_media': ('/api/media/', 'media_id'),
           'get_task': ('/api/tasks/', 'task_id'), 'get_result': ('/api/results/', 'result_id'),
           'get_artifact': ('/api/artifacts/', 'artifact_id')}

    def __init__(self, service):
        self.service = service
        self.server = create_server(service, port=0, token='dual-contract')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def execute(self, operation, payload):
        if operation in self.POST:
            method, path, body = 'POST', self.POST[operation], json.dumps(payload)
        elif operation == 'read_scores':
            method, body = 'GET', None
            path = '/api/scores/' + payload['prediction_id'] + '?start_s=' + str(payload['start_s']) + '&end_s=' + str(payload['end_s'])
        else:
            prefix, identifier = self.GET[operation]
            method, body, path = 'GET', None, prefix + (payload[identifier] if identifier else '')
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        connection.request(method, path, body, {'Content-Type': 'application/json', 'X-Apex-Token': 'dual-contract'})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        if response.status >= 400:
            raise ServiceError(data['error']['code'], data['error']['message'], response.status)
        return data

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()


class DualEntryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg, cls.ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        cls.fixture = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixture.name) / '双入口 中文 录像.mp4'
        subprocess.run([cls.ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
            'testsrc2=size=96x64:rate=10:duration=24', '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=24',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'alac',
            '-output_ts_offset', '3', str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.adapters = []

    def tearDown(self):
        for adapter in self.adapters:
            adapter.close()
        self.data.cleanup()

    def adapter(self, kind, *, media_tool=None, **predictions):
        directory = Path(self.data.name) / kind
        directory.mkdir()
        spec = directory / 'fixture.json'
        spec.write_text(json.dumps(predictions or {'events': [[2, 2.4, 0], [14, 14.4, 1]]}))
        service = ModelService(data_dir=directory / 'data', ffmpeg=media_tool or self.ffmpeg, ffprobe=self.ffprobe,
            model_command=[sys.executable, str(Path(__file__).parent / 'fixtures/model_worker.py'), str(spec)])
        adapter = (HttpAdapter if kind == 'http' else IpcAdapter)(service)
        self.adapters.append(adapter)
        return adapter

    def wait(self, adapter, request):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            task = adapter.execute('get_task', request)
            if task['status'] in ('completed', 'failed', 'cancelled'):
                return task
            time.sleep(0.01)
        self.fail('task did not finish')

    def media(self, adapter, path=None):
        media = adapter.execute('probe_media', {'path': str(path or self.video)})
        return adapter.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})

    def test_same_complete_review_flow_preserves_scores_ranges_versions_and_export_semantics(self):
        observed = []
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                first, second = self.media(adapter), self.media(adapter)
                task = self.wait(adapter, adapter.execute('analyze', {'media_ids': [first['media_id'], second['media_id']]}))
                self.assertEqual(('completed', ['completed', 'completed']),
                    (task['status'], [item['status'] for item in task['results']]))
                results = [adapter.execute('get_result', {'result_id': item['result_id']}) for item in task['results']]
                self.assertEqual([False, True], [result['prediction']['runtime']['model_reused'] for result in results])
                result = results[0]
                scores = adapter.execute('read_scores', {'prediction_id': result['prediction_id'], 'start_s': 2.01, 'end_s': 2.05})
                self.assertEqual([[0.75, 0.0, 0.0], [0.75, 0.0, 0.0]], scores['scores'])
                old = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                changed = adapter.execute('recompute_candidates', {**old, 'parameters': {'before_s': 2, 'after_s': 3}})
                with self.assertRaises(ServiceError) as stale:
                    adapter.execute('update_selection', {**old, 'clips': []})
                self.assertEqual('stale_candidates', stale.exception.code)
                ref = {'result_id': changed['result_id'], 'candidate_version': changed['candidate_version']}
                first_clip, second_clip = changed['candidates']
                saved = adapter.execute('update_selection', {**ref, 'clips': [
                    {'candidate_id': first_clip['candidate_id'], 'start_s': 2.3, 'end_s': 3.7},
                    {'candidate_id': second_clip['candidate_id'], 'selected': False}]})
                preview = self.wait(adapter, adapter.execute('request_preview', {**ref, 'candidate_id': first_clip['candidate_id']}))
                artifact = adapter.execute('get_artifact', {'artifact_id': preview['preview_id']})
                subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', artifact['path'],
                    '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
                exports = self.wait(adapter, adapter.execute('export', {**ref, 'output_dir': str(Path(self.data.name) / kind / '中文 输出')}))
                self.assertEqual(('completed', 1), (exports['status'], len(exports['exports'])))
                export = adapter.execute('get_artifact', {'artifact_id': exports['exports'][0]['artifact_id']})
                subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', export['path'],
                    '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
                observed.append({'classes': result['prediction']['classes'], 'scores': scores,
                    'candidates': [(round(c['start_s'], 3), round(c['end_s'], 3)) for c in changed['candidates']],
                    'selection': [(c['selected'], c['start_s'], c['end_s']) for c in saved['selection']],
                    'preview_range': artifact['requested_range'], 'export_range': export['requested_range'],
                    'actual_range': {k: round(v, 3) for k, v in export['actual_range'].items()},
                    'export_mode': export['mode']})
                observed[-1]['scores'].pop('prediction_id', None)
                observed[-1]['scores'].pop('media_id', None)
        self.assertEqual(observed[0], observed[1])
        self.assertEqual([(0.0, 5.4), (12.0, 17.4)], observed[0]['candidates'])
        self.assertEqual({'start_s': 2.0, 'end_s': 3.7}, observed[0]['actual_range'])

    def test_cancelled_analysis_reaches_clean_terminal_state_and_allows_the_next_task(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                gate = Path(self.data.name) / (kind + '-release')
                adapter = self.adapter(kind, gate=str(gate), events=[[2, 2.4, 0]])
                media = self.media(adapter)
                submitted = adapter.execute('analyze', {'media_id': media['media_id']})
                accepted = adapter.execute('cancel_task', submitted)
                terminal = self.wait(adapter, submitted)
                self.assertEqual(('cancelling', 'cancelled', 'task_cancelled'),
                    (accepted['status'], terminal['status'], terminal['error']['code']))
                gate.touch()
                next_task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                self.assertEqual('completed', next_task['status'], next_task)

    def test_unknown_identifiers_have_the_same_public_error_contract(self):
        for kind in ('http', 'ipc'):
            adapter = self.adapter(kind)
            for operation, key, code in [('get_task', 'task_id', 'task_not_found'),
                ('get_result', 'result_id', 'result_not_found'), ('get_artifact', 'artifact_id', 'artifact_not_found')]:
                with self.subTest(entry=kind, operation=operation):
                    with self.assertRaises(ServiceError) as rejected:
                        adapter.execute(operation, {key: '0' * 32})
                    self.assertEqual((code, 404), (rejected.exception.code, rejected.exception.status))

    def test_no_gunfire_still_has_scores_and_both_entries_reject_empty_export(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind, events=[[1, 1.4, 2]])
                media = self.media(adapter)
                task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                result = adapter.execute('get_result', {'result_id': task['result_id']})
                self.assertEqual(([], [], 600), (result['candidates'], result['selection'], result['prediction']['frame_count']))
                with self.assertRaises(ServiceError) as rejected:
                    adapter.execute('export', {'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                        'output_dir': str(Path(self.data.name) / kind / 'empty-output')})
                self.assertEqual('empty_selection', rejected.exception.code)

    def test_illegal_review_and_changed_sources_have_matching_errors(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                mutable = Path(self.data.name) / kind / 'mutable.mp4'
                shutil.copyfile(self.video, mutable)
                media = self.media(adapter, mutable)
                task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                result = adapter.execute('get_result', {'result_id': task['result_id']})
                ref = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                candidate_id = result['candidates'][0]['candidate_id']
                for clip, code in [({'candidate_id': candidate_id, 'start_s': -1, 'end_s': 3}, 'invalid_range'),
                                   ({'candidate_id': 'unknown', 'selected': False}, 'candidate_not_found')]:
                    with self.assertRaises(ServiceError) as rejected:
                        adapter.execute('update_selection', {**ref, 'clips': [clip]})
                    self.assertEqual(code, rejected.exception.code)
                self.assertEqual(result['selection'], adapter.execute('get_result', {'result_id': result['result_id']})['selection'])
                preview = self.wait(adapter, adapter.execute('request_preview', {**ref, 'candidate_id': candidate_id}))
                with mutable.open('ab') as stream:
                    stream.write(b'changed recording')
                for operation, payload in [('get_artifact', {'artifact_id': preview['preview_id']}),
                    ('request_preview', {**ref, 'candidate_id': candidate_id}),
                    ('export', {**ref, 'output_dir': str(Path(self.data.name) / kind / 'changed-output')})]:
                    with self.assertRaises(ServiceError) as rejected:
                        adapter.execute(operation, payload)
                    self.assertEqual('source_changed', rejected.exception.code)

    def test_grouping_boundaries_overlap_and_long_fire_match_through_both_entries(self):
        recording = Path(self.data.name) / '80秒 录像.mp4'
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
            'testsrc2=size=96x64:rate=10:duration=80', '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=80',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'alac', str(recording)], check=True)
        events = [[0.04, 0.2, 0], [5.16, 5.32, 1], [10.36, 10.52, 0], [17.52, 17.68, 1], [30, 79.75, 0]]
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind, events=events)
                media = self.media(adapter, recording)
                task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                result = adapter.execute('get_result', {'result_id': task['result_id']})
                self.assertEqual([(0.0, 10.32), (5.36, 15.52), (12.52, 22.68), (25.0, 80.0)],
                    [(round(c['start_s'], 2), round(c['end_s'], 2)) for c in result['candidates']])

    def test_preview_and_export_cancel_failure_preserve_completed_files_through_both_entries(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                config = Path(self.data.name) / (kind + '-media-config.json')
                marker = Path(self.data.name) / (kind + '-media-marker.json')
                release = Path(self.data.name) / (kind + '-media-release')
                tool = Path(self.data.name) / (kind + '-ffmpeg')
                program = """#!{python}
import json, os, pathlib, subprocess, sys, time
spec = json.loads(pathlib.Path({config!r}).read_text())
target = pathlib.Path(sys.argv[-1])
blocked = (spec['mode'] == 'preview' and 'previews' in target.parts) or (spec['mode'] in ('export-fail', 'export-cancel') and target.name == '002.mp4')
if blocked:
    target.write_bytes(b'partial media fixture')
    pathlib.Path({marker!r}).write_text(json.dumps({{'pid':os.getpid(),'path':str(target)}}))
    while not pathlib.Path({release!r}).exists(): time.sleep(.01)
    if spec['mode'] == 'export-fail': sys.exit(7)
os.execv({ffmpeg!r}, [{ffmpeg!r}, *sys.argv[1:]])
""".format(python=sys.executable, config=str(config), marker=str(marker), release=str(release), ffmpeg=self.ffmpeg)
                tool.write_text(program)
                tool.chmod(0o755)
                config.write_text(json.dumps({'mode': 'preview'}))
                adapter = self.adapter(kind, media_tool=tool)
                media = self.media(adapter)
                analyzed = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                result = adapter.execute('get_result', {'result_id': analyzed['result_id']})
                ref = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
                def await_marker():
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if marker.exists(): return json.loads(marker.read_text())
                        time.sleep(.01)
                    self.fail('controlled media process did not become ready')
                preview = adapter.execute('request_preview', {**ref, 'candidate_id': result['candidates'][0]['candidate_id']})
                partial = await_marker()
                adapter.execute('cancel_task', preview)
                terminal = self.wait(adapter, preview)
                self.assertEqual('cancelled', terminal['status'])
                self.assertFalse(Path(partial['path']).exists())
                with self.assertRaises(ProcessLookupError): os.kill(partial['pid'], 0)
                for mode, expected in [('export-fail', 'failed'), ('export-cancel', 'cancelled')]:
                    marker.unlink()
                    release.unlink(missing_ok=True)
                    config.write_text(json.dumps({'mode': mode}))
                    submitted = adapter.execute('export', {**ref, 'output_dir': str(Path(self.data.name) / kind / mode)})
                    partial = await_marker()
                    if mode == 'export-fail': release.touch()
                    else: adapter.execute('cancel_task', submitted)
                    terminal = self.wait(adapter, submitted)
                    self.assertEqual((expected, ['completed', expected]),
                        (terminal['status'], [entry['status'] for entry in terminal['exports']]))
                    self.assertFalse(Path(partial['path']).exists())
                    first = adapter.execute('get_artifact', {'artifact_id': terminal['exports'][0]['artifact_id']})
                    self.assertTrue(Path(first['path']).is_file())
                    subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', first['path'],
                        '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], check=True)
                release.touch()

    def test_both_entries_recover_interrupted_tasks_and_preserve_completed_results(self):
        from types import SimpleNamespace
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind)
                media = self.media(adapter)
                finished = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                saved = adapter.execute('get_result', {'result_id': finished['result_id']})
                adapter.close()
                self.adapters.remove(adapter)
                directory = Path(self.data.name) / kind
                gate = directory / 'release-interrupted'
                spec = directory / 'fixture.json'
                spec.write_text(json.dumps({'gate': str(gate)}))
                script = """import json,sys
from model_service import ModelService
from model_web import create_server
from model_ipc import serve
service=ModelService(data_dir=sys.argv[1],ffmpeg=sys.argv[2],ffprobe=sys.argv[3],model_command=[sys.executable,sys.argv[4],sys.argv[5]])
if sys.argv[6]=='http':
 server=create_server(service,port=0,token='dual-contract')
 print(json.dumps({'port':server.server_port}),flush=True)
 server.serve_forever()
else:
 serve(service,sys.stdin,sys.stdout)
"""
                process = subprocess.Popen([sys.executable, '-u', '-c', script, str(directory / 'data'),
                    self.ffmpeg, self.ffprobe, str(Path(__file__).parent / 'fixtures/model_worker.py'), str(spec), kind],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    ready = json.loads(process.stdout.readline())
                    if kind == 'http':
                        interrupted = HttpAdapter.__new__(HttpAdapter)
                        interrupted.server = SimpleNamespace(server_port=ready['port'])
                    else:
                        interrupted = IpcAdapter.__new__(IpcAdapter)
                        interrupted.writer, interrupted.reader, interrupted.sequence = process.stdin, process.stdout, 0
                    submitted = interrupted.execute('analyze', {'media_id': media['media_id']})
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if interrupted.execute('get_task', submitted)['stage'] == 'model_loading': break
                        time.sleep(.01)
                    process.kill()
                    process.wait(timeout=5)
                    restored_core = ModelService(data_dir=directory / 'data', ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
                    restored = (HttpAdapter if kind == 'http' else IpcAdapter)(restored_core)
                    self.adapters.append(restored)
                    task = restored.execute('get_task', submitted)
                    result = restored.execute('get_result', {'result_id': saved['result_id']})
                    self.assertEqual(('failed', 'service_interrupted', saved['result_id']),
                        (task['status'], task['error']['code'], result['result_id']))
                    self.assertEqual(saved['candidates'], result['candidates'])
                finally:
                    gate.touch()
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    for stream in (process.stdin, process.stdout, process.stderr): stream.close()

    def test_exact_five_second_event_gap_merges_before_padding_in_both_entries(self):
        for kind in ('http', 'ipc'):
            with self.subTest(entry=kind):
                adapter = self.adapter(kind, events=[[2.72, 2.88, 0], [7.88, 8.04, 1]])
                media = self.media(adapter)
                task = self.wait(adapter, adapter.execute('analyze', {'media_id': media['media_id']}))
                result = adapter.execute('get_result', {'result_id': task['result_id']})
                self.assertEqual([(0.0, 13.04)], [(round(c['start_s'], 2), round(c['end_s'], 2)) for c in result['candidates']])


if __name__ == '__main__':
    unittest.main()
