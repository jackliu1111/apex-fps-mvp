"""Public HTTP service scenarios shared with future IPC acceptance tests."""
import http.client
import json
import os
import selectors
import shlex
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, quote, urlsplit

from model_service import ModelService, ServiceError
from model_web import create_server


class MediaSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = shutil.which('ffmpeg')
        cls.ffprobe = shutil.which('ffprobe')
        if not cls.ffmpeg or not cls.ffprobe:
            raise RuntimeError('These service acceptance tests require FFmpeg/ffprobe')
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixtures.name) / '中文 录像.mkv'
        subprocess.run([
            cls.ffmpeg, '-nostdin', '-v', 'error', '-n',
            '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=1',
            '-itsoffset', '0.25', '-f', 'lavfi', '-i',
            'sine=frequency=440:sample_rate=16000:duration=0.75',
            '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=1',
            '-map', '0:v', '-map', '1:a', '-map', '2:a',
            '-c:v', 'ffv1', '-c:a', 'pcm_s16le',
            '-metadata:s:a:0', 'title=游戏声音', '-metadata:s:a:0', 'language=zho',
            '-metadata:s:a:1', 'title=麦克风', '-metadata:s:a:1', 'language=eng',
            '-output_ts_offset', '3', str(cls.video),
        ], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
                                    ffprobe=self.ffprobe)
        self.server = create_server(self.service, port=0, token='test-access-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()
        self.data.cleanup()

    def request(self, method, path, payload=None, *, token='test-access-token',
                origin=None, host=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Content-Type': 'application/json'}
        if token is not None:
            headers['X-Apex-Token'] = token
        if origin is not None:
            headers['Origin'] = origin
        if host is not None:
            headers['Host'] = host
        connection.request(method, path,
                           raw if raw is not None else json.dumps(payload) if payload is not None else None,
                           headers)
        response = connection.getresponse()
        body = response.read()
        status = response.status
        connection.close()
        return status, json.loads(body) if response.getheader('Content-Type', '').startswith('application/json') else body

    def test_probe_lists_identifiable_tracks_without_selecting_one(self):
        status, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        self.assertEqual(200, status, media)
        self.assertEqual({
            'titles': ['游戏声音', '麦克风'], 'languages': ['zho', 'eng'],
            'indices': [1, 2], 'starts': [3.25, 3.0],
            'video_start': 3.0, 'duration': 1.0, 'selection': None,
        }, {
            'titles': [t['title'] for t in media['audio_tracks']],
            'languages': [t['language'] for t in media['audio_tracks']],
            'indices': [t['stream_index'] for t in media['audio_tracks']],
            'starts': [t['start_time_s'] for t in media['audio_tracks']],
            'video_start': media['video']['start_time_s'],
            'duration': media['duration_s'], 'selection': media['selected_audio'],
        })

    def test_confirmed_track_and_timeline_survive_service_restart(self):
        _, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        status, selected = self.request('POST', '/api/confirm-audio', {
            'media_id': media['media_id'], 'stream_index': 1,
        })
        self.assertEqual(200, status, selected)
        # Retrieve through the public core boundary after reopening its data dir.
        reopened = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
        saved = reopened.execute('get_media', {'media_id': media['media_id']})
        self.assertEqual({
            'stream_index': 1, 'video_origin_s': 3.0, 'audio_origin_s': 3.25,
            'audio_to_video_offset_s': 0.25,
        }, saved['selected_audio'])

    def test_invalid_media_returns_specific_errors(self):
        folder = Path(self.data.name)
        corrupt = folder / '损坏.mp4'
        corrupt.write_bytes(b'not a recording')
        silent = folder / '无音轨.mkv'
        audio = folder / '只有音频.wav'
        for target, mapping, args in [(silent, '0:v', ['-c', 'copy']),
                                      (audio, '0:a:0', ['-c:a', 'pcm_s16le'])]:
            subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n',
                            '-i', str(self.video), '-map', mapping, *args, str(target)], check=True)
        unreadable = folder / '不可读.mkv'
        shutil.copyfile(self.video, unreadable)
        unreadable.chmod(0)
        try:
            for path, code in [(str(folder / 'missing.mp4'), 'invalid_path'),
                               (str(folder), 'invalid_path'), ('', 'invalid_path'),
                               (None, 'invalid_path'), (str(corrupt), 'unreadable_media'),
                               (str(audio), 'not_video'), (str(silent), 'no_audio'),
                               (str(unreadable), 'unreadable_media')]:
                with self.subTest(path=path):
                    status, error = self.request('POST', '/api/probe', {'path': path})
                    self.assertEqual((422, code), (status, error['error']['code']))
        finally:
            unreadable.chmod(0o600)

    def test_confirmation_rejects_unknown_tracks_and_media(self):
        _, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        for media_id, index, code in [
            (media['media_id'], 0, 'invalid_audio_track'),
            (media['media_id'], 99, 'invalid_audio_track'),
            (media['media_id'], True, 'invalid_audio_track'),
            (media['media_id'], '1', 'invalid_audio_track'),
            (media['media_id'], None, 'invalid_audio_track'),
            ('0' * 32, 1, 'media_not_found'),
            ('../../outside', 1, 'media_not_found'),
        ]:
            with self.subTest(media_id=media_id, index=index):
                status, error = self.request('POST', '/api/confirm-audio', {
                    'media_id': media_id, 'stream_index': index,
                })
                self.assertEqual(code, error['error']['code'])
                self.assertIn(status, (404, 422))
        saved = self.service.execute('get_media', {'media_id': media['media_id']})
        self.assertIsNone(saved['selected_audio'])

    def test_probe_requires_token_and_rejects_foreign_origin_or_host(self):
        for options, code, status in [
            ({'token': None}, 'unauthorized', 401),
            ({'token': 'wrong'}, 'unauthorized', 401),
            ({'origin': 'https://outside.example'}, 'invalid_origin', 403),
            ({'origin': 'null'}, 'invalid_origin', 403),
            ({'host': 'outside.example'}, 'invalid_host', 403),
        ]:
            with self.subTest(options=options):
                actual, error = self.request('POST', '/api/probe', {'path': str(self.video)}, **options)
                self.assertEqual((status, code), (actual, error['error']['code']))
        status, media = self.request('POST', '/api/probe', {'path': str(self.video)},
                                     origin=f'http://127.0.0.1:{self.server.server_port}')
        self.assertEqual(200, status, media)

    def test_user_can_browse_local_directories_and_choose_a_recording(self):
        status, listing = self.request('GET', '/api/browse?path=' + quote(self.fixtures.name))
        self.assertEqual(200, status, listing)
        recording = next(e for e in listing['entries'] if e['name'] == '中文 录像.mkv')
        status, media = self.request('POST', '/api/probe', {'path': recording['path']})
        self.assertEqual((False, 200, str(self.video.resolve())),
                         (recording['is_dir'], status, media['source']['path']))
        status, error = self.request('GET', '/api/browse?path=' + quote(str(self.video)))
        self.assertEqual((422, 'invalid_path'), (status, error['error']['code']))

    def test_config_exposes_explicit_model_and_media_paths_without_loading_model(self):
        workspace = Path(self.data.name) / '模型 目录'
        checkpoint = workspace / '基线.pt'
        workspace.mkdir()
        checkpoint.write_bytes(b'configuration fixture; not a model')
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
                                    ffprobe=self.ffprobe, model_workspace=workspace,
                                    checkpoint=checkpoint)
        self.server = create_server(self.service, port=0, token='test-access-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        status, config = self.request('GET', '/api/config')
        self.assertEqual(200, status, config)
        self.assertEqual({
            'model_workspace': str(workspace.resolve()), 'checkpoint': str(checkpoint.resolve()),
            'checkpoint_available': True, 'model_state': 'not_loaded',
            'ffmpeg': self.ffmpeg, 'ffprobe': self.ffprobe,
        }, {key: config[key] for key in (
            'model_workspace', 'checkpoint', 'checkpoint_available', 'model_state', 'ffmpeg', 'ffprobe')})

    def test_malformed_requests_and_unknown_routes_return_contract_errors(self):
        for path, raw, status, code in [
            ('/api/probe', '{', 400, 'invalid_request'),
            ('/api/probe', '[]', 400, 'invalid_request'),
            ('/api/probe', '{}', 400, 'invalid_request'),
            ('/api/confirm-audio', '{}', 400, 'invalid_request'),
            ('/api/unknown', '{}', 404, 'not_found'),
            ('/api/probe', '{"path":"' + 'a' * 70000 + '"}', 413, 'request_too_large'),
        ]:
            with self.subTest(path=path, status=status):
                actual, error = self.request('POST', path, raw=raw)
                self.assertEqual((status, code), (actual, error['error']['code']))
        status, error = self.request('GET', '/api/unknown')
        self.assertEqual((404, 'not_found'), (status, error['error']['code']))

    def test_selected_second_track_is_retrievable_over_http(self):
        _, media = self.request('POST', '/api/probe', {'path': str(self.video)})
        self.request('POST', '/api/confirm-audio', {'media_id': media['media_id'], 'stream_index': 2})
        status, saved = self.request('GET', '/api/media/' + media['media_id'])
        self.assertEqual((200, 2, 0.0), (status, saved['selected_audio']['stream_index'],
                                       saved['selected_audio']['audio_to_video_offset_s']))

    def test_standalone_entry_runs_without_node_bun_or_python_site_packages(self):
        # -S excludes third-party site packages; PATH hides all other runtimes.
        with subprocess.Popen([
            sys.executable, '-S', '-u', str(Path(__file__).resolve().parents[1] / 'model_web.py'),
            '--port', '0', '--data-dir', str(Path(self.data.name) / 'standalone'),
            '--ffmpeg', self.ffmpeg, '--ffprobe', self.ffprobe,
        ], env={**os.environ, 'PATH': '/nonexistent'},
           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            try:
                with selectors.DefaultSelector() as ready:
                    ready.register(process.stdout, selectors.EVENT_READ)
                    self.assertTrue(ready.select(timeout=5), 'service did not report readiness')
                    line = process.stdout.readline().strip()
                self.assertTrue(line.startswith('Python Web: http://127.0.0.1:'), line)
                url = urlsplit(line.removeprefix('Python Web: '))
                token = parse_qs(url.fragment)['token'][0]
                connection = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
                connection.request('POST', '/api/probe', json.dumps({'path': str(self.video)}),
                                   {'X-Apex-Token': token, 'Content-Type': 'application/json'})
                response = connection.getresponse()
                media = json.loads(response.read())
                self.assertEqual((200, 2), (response.status, len(media['audio_tracks'])))
                connection.close()
            finally:
                process.terminate()
                process.communicate(timeout=5)

    def test_local_browser_can_load_selection_page_and_offline_assets(self):
        for path in ('/', '/app.js', '/style.css'):
            with self.subTest(path=path):
                status, body = self.request('GET', path, token=None)
                self.assertEqual(200, status, body)
                self.assertTrue(body)
        status, error = self.request('GET', '/', token=None, origin='https://outside.example')
        self.assertEqual((403, 'invalid_origin'), (status, error['error']['code']))

    def test_missing_or_nonfinite_media_timestamps_are_explicitly_rejected(self):
        # ffprobe is an external process boundary. Its response is a controlled
        # fixture here; normal compatibility tests above run the real tools.
        probe = Path(self.data.name) / 'ffprobe-fixture'
        valid_video = {'index': 0, 'codec_type': 'video', 'codec_name': 'h264',
                       'width': 64, 'height': 64, 'start_time': '0', 'duration': '1'}
        valid_audio = {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac',
                       'channels': 2, 'sample_rate': '48000', 'start_time': '0'}
        for stream, field, value in [('video', 'start_time', None),
                                      ('audio', 'start_time', None),
                                      ('audio', 'start_time', 'NaN'),
                                      ('video', 'duration', 'N/A')]:
            with self.subTest(stream=stream, field=field, value=value):
                video, audio = valid_video.copy(), valid_audio.copy()
                target = video if stream == 'video' else audio
                if value is None:
                    del target[field]
                else:
                    target[field] = value
                response = json.dumps({'streams': [video, audio]})
                probe.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(response) + '\n')
                probe.chmod(0o700)
                controlled = ModelService(data_dir=Path(self.data.name) / 'controlled',
                                          ffmpeg=self.ffmpeg, ffprobe=probe)
                try:
                    with self.assertRaisesRegex(ServiceError, '时间|时长') as rejected:
                        controlled.execute('probe_media', {'path': str(self.video)})
                    self.assertEqual('unreadable_media', rejected.exception.code)
                finally:
                    controlled.close()

    def test_unusable_audio_stream_is_rejected_as_no_audio(self):
        probe = Path(self.data.name) / 'ffprobe-fixture'
        response = json.dumps({'streams': [
            {'index': 0, 'codec_type': 'video', 'codec_name': 'h264',
             'width': 64, 'height': 64, 'start_time': '0', 'duration': '1'},
            {'index': 1, 'codec_type': 'audio', 'channels': 0, 'sample_rate': '0'},
        ]})
        probe.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(response) + '\n')
        probe.chmod(0o700)
        controlled = ModelService(data_dir=Path(self.data.name) / 'controlled',
                                  ffmpeg=self.ffmpeg, ffprobe=probe)
        with self.assertRaises(ServiceError) as rejected:
            controlled.execute('probe_media', {'path': str(self.video)})
        self.assertEqual('no_audio', rejected.exception.code)

    def test_probe_tool_failure_returns_a_service_error(self):
        controlled = ModelService(data_dir=Path(self.data.name) / 'controlled',
                                  ffmpeg=self.ffmpeg, ffprobe=Path(self.data.name) / 'missing-ffprobe')
        with self.assertRaises(ServiceError) as rejected:
            controlled.execute('probe_media', {'path': str(self.video)})
        self.assertEqual(('media_tool_unavailable', 503),
                         (rejected.exception.code, rejected.exception.status))


if __name__ == '__main__':
    unittest.main()
