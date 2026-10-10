"""Public stdio IPC acceptance: real service, real media, controlled model process."""
import io
import os
import json
from pathlib import Path
import shutil
import subprocess
import sys
import selectors
import tempfile
import time
import unittest

from model_service import ModelService
from model_ipc import serve


class StdioContractTests(unittest.TestCase):
    def test_requests_keep_their_ids_and_the_worker_serves_more_than_one_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            service = ModelService(data_dir=directory, ffmpeg='ffmpeg', ffprobe='ffprobe')
            output = io.StringIO()
            serve(service, io.StringIO(
                '{"id":"配置 1","operation":"get_config","payload":{}}\n'
                '{"id":"config-2","operation":"get_config","payload":{}}\n'), output)
            messages = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(['ready', 'response', 'response'], [m['type'] for m in messages])
            self.assertEqual(['配置 1', 'config-2'], [m['id'] for m in messages[1:]])
            self.assertEqual(str(Path(directory).resolve()), messages[1]['result']['data_dir'])

    def test_bad_messages_return_contract_errors_without_ending_the_session(self):
        with tempfile.TemporaryDirectory() as directory:
            service = ModelService(data_dir=directory, ffmpeg='ffmpeg', ffprobe='ffprobe')
            output = io.StringIO()
            source = io.StringIO('\n'.join([
                '{',
                json.dumps({'id': 'shape', 'operation': 'get_config', 'payload': []}),
                json.dumps({'id': 'unknown', 'operation': 'run_shell', 'payload': {}}),
                json.dumps({'id': 'missing', 'operation': 'get_result', 'payload': {'result_id': '0' * 32}}),
                json.dumps({'id': 'alive', 'operation': 'get_config', 'payload': {}}),
            ]) + '\n')
            serve(service, source, output)
            messages = [json.loads(line) for line in output.getvalue().splitlines()][1:]
            self.assertEqual([None, 'shape', 'unknown', 'missing', 'alive'], [m['id'] for m in messages])
            self.assertEqual(['invalid_request', 'invalid_request', 'not_found', 'result_not_found'],
                             [m['error']['code'] for m in messages[:-1]])
            self.assertIn('result', messages[-1])

    def test_standalone_worker_reads_utf8_chinese_paths_even_under_an_ascii_locale(self):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        with tempfile.TemporaryDirectory(prefix='桌面 IPC ') as directory:
            video = Path(directory) / '中文 录像.mkv'
            subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                            'color=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i',
                            'sine=sample_rate=16000:duration=1', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(video)], check=True)
            with subprocess.Popen([sys.executable, '-S', '-u', str(Path(__file__).resolve().parents[1] / 'model_ipc.py'),
                                   '--data-dir', str(Path(directory) / 'desktop-data'),
                                   '--ffmpeg', ffmpeg, '--ffprobe', ffprobe],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
                                  env={**os.environ, 'PYTHONIOENCODING': 'ascii', 'PATH': '/nonexistent'}) as process:
                try:
                    with selectors.DefaultSelector() as ready:
                        ready.register(process.stdout, selectors.EVENT_READ)
                        self.assertTrue(ready.select(timeout=5), 'worker did not report readiness')
                    self.assertEqual('ready', json.loads(process.stdout.readline())['type'])
                    process.stdin.write(json.dumps({'id': '录像', 'operation': 'probe_media', 'payload': {'path': str(video)}}, ensure_ascii=False) + '\n')
                    process.stdin.flush()
                    media = json.loads(process.stdout.readline())['result']
                    process.stdin.write(json.dumps({'id': '音轨', 'operation': 'confirm_audio',
                                                   'payload': {'media_id': media['media_id'], 'stream_index': 1}}) + '\n')
                    process.stdin.flush()
                    selected = json.loads(process.stdout.readline())['result']
                    self.assertEqual((str(video.resolve()), 1),
                                     (selected['source']['path'], selected['selected_audio']['stream_index']))
                    process.stdin.close()
                    process.wait(timeout=5)
                    self.assertEqual(0, process.returncode)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)

    def test_oversized_messages_are_rejected_and_a_later_query_still_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            service = ModelService(data_dir=directory, ffmpeg='ffmpeg', ffprobe='ffprobe')
            output = io.StringIO()
            serve(service, io.StringIO(json.dumps({'id': 'large', 'operation': 'probe_media',
                 'payload': {'path': 'a' * 70000}}) + '\n' +
                 '{"id":"alive","operation":"get_config","payload":{}}\n'), output)
            messages = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(('request_too_large', 'alive'),
                             (messages[1]['error']['code'], messages[2]['id']))

    def test_guardian_launcher_preserves_the_media_process_failure_exit_code(self):
        completed = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'model_ipc.py'),
            '--process-guardian', str(os.getpid()), '--', sys.executable, '-c', 'import sys; sys.exit(7)'],
            capture_output=True, timeout=5)
        self.assertEqual(7, completed.returncode, completed.stderr)

    def test_unicode_model_errors_survive_a_non_utf8_process_locale(self):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        with tempfile.TemporaryDirectory(prefix='ipc-locale-') as folder:
            directory = Path(folder)
            video = directory / 'recording.mkv'
            subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                'color=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=1',
                '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(video)], check=True)
            engine = directory / 'unicode-model-process'
            engine.write_text('#!' + sys.executable + '\nimport json,sys\nfor line in sys.stdin:\n print(json.dumps({"type":"error","code":"model_load_failed","message":"模型文件不存在：中文.pt"},ensure_ascii=False),flush=True)\n', encoding='utf-8')
            engine.chmod(0o755)
            process = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve().parents[1] / 'model_ipc.py'),
                '--data-dir', str(directory / 'data'), '--ffmpeg', ffmpeg, '--ffprobe', ffprobe,
                '--engine-python', str(engine), '--model-workspace', str(directory)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
                env={**os.environ, 'LC_ALL': 'C', 'PYTHONUTF8': '0', 'PYTHONCOERCECLOCALE': '0', 'PYTHONIOENCODING': 'utf-8'})
            try:
                self.assertEqual('ready', json.loads(process.stdout.readline())['type'])
                def request(operation, payload):
                    process.stdin.write(json.dumps({'id': 'locale', 'operation': operation, 'payload': payload}) + '\n')
                    process.stdin.flush()
                    return json.loads(process.stdout.readline())['result']
                media = request('probe_media', {'path': str(video)})
                request('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})
                submitted = request('analyze', {'media_id': media['media_id']})
                for _ in range(500):
                    task = request('get_task', submitted)
                    if task['status'] in ('completed', 'failed', 'cancelled'): break
                    time.sleep(.01)
                self.assertEqual({'code': 'model_load_failed', 'message': '模型文件不存在：中文.pt'}, task['error'])
            finally:
                process.stdin.close()
                process.wait(timeout=10)
                process.stdout.close()
                process.stderr.close()


if __name__ == '__main__':
    unittest.main()
