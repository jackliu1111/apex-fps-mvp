"""Task behavior at the agreed logical service-operation seam."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import threading
import unittest

from model_service import ModelService, ServiceError
import test_model_web as media_tests


class ModelTaskTests(unittest.TestCase):
    setUpClass = classmethod(media_tests.MediaSelectionTests.setUpClass.__func__)
    tearDownClass = classmethod(media_tests.MediaSelectionTests.tearDownClass.__func__)

    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.fixture = Path(self.data.name) / 'predictions.json'
        self.fixture.write_text(json.dumps({'events': [[0.08, 0.2, 0]]}))
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
            ffprobe=self.ffprobe, model_command=[sys.executable,
            str(Path(__file__).parent / 'fixtures/model_worker.py'), str(self.fixture)])

    def tearDown(self):
        self.service.close()
        self.data.cleanup()

    def media(self, path=None, track=1):
        media = self.service.execute('probe_media', {'path': str(path or self.video)})
        return self.service.execute('confirm_audio', {
            'media_id': media['media_id'], 'stream_index': track})

    def wait_task(self, task_id):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            task = self.service.execute('get_task', {'task_id': task_id})
            if task['status'] in ('completed', 'failed', 'cancelled'):
                return task
            time.sleep(0.01)
        self.fail('task did not finish')

    def analyze(self, media):
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        task = self.wait_task(submitted['task_id'])
        self.assertEqual('completed', task['status'], task)
        return self.service.execute('get_result', {'result_id': task['result_id']})

    def test_batch_analyzes_confirmed_recordings_in_submission_order(self):
        first, second = self.media(), self.media(track=2)
        submitted = self.service.execute('analyze', {
            'media_ids': [first['media_id'], second['media_id']]})
        task = self.wait_task(submitted['task_id'])
        results = [self.service.execute('get_result', {'result_id': item['result_id']})
                   for item in task['results']]
        self.assertEqual(('completed', [first['media_id'], second['media_id']],
                          ['completed', 'completed'], [1, 2]),
                         (task['status'], [item['media_id'] for item in task['results']],
                          [item['status'] for item in task['results']],
                          [result['media']['selected_audio']['stream_index'] for result in results]))

    def test_candidate_parameters_reuse_predictions_and_reset_selection_version(self):
        result = self.analyze(self.media())
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
            ffprobe=self.ffprobe, model_command=['/missing-model-executable'])
        updated = self.service.execute('recompute_candidates', {
            'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
            'parameters': {'threshold': 0.8, 'merge_gap_s': 5, 'before_s': 5, 'after_s': 5}})
        self.assertEqual((result['prediction'], [], [], 0.8, True),
                         (updated['prediction'], updated['candidates'], updated['selection'],
                          updated['parameters']['threshold'],
                          result['candidate_version'] != updated['candidate_version']))

    def test_source_replacement_with_same_size_and_timestamp_cannot_reuse_candidates(self):
        recording = Path(self.data.name) / '可替换 录像.mkv'
        shutil.copyfile(self.video, recording)
        result = self.analyze(self.media(recording))
        original = recording.stat()
        content = bytearray(recording.read_bytes())
        content[-1] ^= 1
        recording.write_bytes(content)
        os.utime(recording, ns=(original.st_atime_ns, original.st_mtime_ns))
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('recompute_candidates', {
                'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                'parameters': {'threshold': 0.3}})
        self.assertEqual((409, 'source_changed'), (rejected.exception.status, rejected.exception.code))

    def test_changing_selected_audio_requires_new_analysis_before_candidate_reuse(self):
        media = self.media()
        result = self.analyze(media)
        self.service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 2})
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('recompute_candidates', {
                'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                'parameters': {'before_s': 2}})
        self.assertEqual((409, 'analysis_configuration_changed'),
                         (rejected.exception.status, rejected.exception.code))

    def test_changing_model_weights_requires_new_inference(self):
        checkpoint = Path(self.data.name) / 'BEATs_strong_1.pt'
        checkpoint.write_bytes(b'first-model-fixture')
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg,
            ffprobe=self.ffprobe, checkpoint=checkpoint, model_command=[sys.executable,
            str(Path(__file__).parent / 'fixtures/model_worker.py'), str(self.fixture)])
        result = self.analyze(self.media())
        checkpoint.write_bytes(b'second-model-fixture')
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('recompute_candidates', {
                'result_id': result['result_id'], 'candidate_version': result['candidate_version'],
                'parameters': {'before_s': 2}})
        self.assertEqual((409, 'analysis_configuration_changed'),
                         (rejected.exception.status, rejected.exception.code))

    def test_cancelled_analysis_cleans_up_then_allows_a_new_task(self):
        gate = Path(self.data.name) / 'release-model'
        self.fixture.write_text(json.dumps({'gate': str(gate), 'events': [[0.08, 0.2, 0]]}))
        media = self.media()
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            running = self.service.execute('get_task', {'task_id': submitted['task_id']})
            if running['stage'] == 'model_loading':
                break
            time.sleep(0.01)
        accepted = self.service.execute('cancel_task', {'task_id': submitted['task_id']})
        finished = self.wait_task(submitted['task_id'])
        gate.touch()
        next_result = self.analyze(media)
        self.assertEqual(('cancelling', 'cancelled', 'task_cancelled', None, media['media_id']),
                         (accepted['status'], finished['status'], finished['error']['code'],
                          finished['result_id'], next_result['media']['media_id']))

    def test_data_directory_rejects_another_process_writer(self):
        script = """import json, sys
from model_service import ModelService, ServiceError
try:
    service = ModelService(data_dir=sys.argv[1], ffmpeg=sys.argv[2], ffprobe=sys.argv[3])
    print(json.dumps({'code': 'opened'}))
    service.close()
except ServiceError as error:
    print(json.dumps({'code': error.code, 'status': error.status}))
"""
        output = subprocess.check_output([sys.executable, '-c', script,
            self.data.name, self.ffmpeg, self.ffprobe], text=True)
        self.assertEqual({'code': 'data_dir_locked', 'status': 409}, json.loads(output))

    def test_restart_marks_interrupted_tasks_failed_and_preserves_finished_results(self):
        completed = self.analyze(self.media())
        gate = Path(self.data.name) / 'release-crashed-model'
        self.fixture.write_text(json.dumps({'gate': str(gate)}))
        self.service.close()
        script = """import json, sys, time
from model_service import ModelService
service = ModelService(data_dir=sys.argv[1], ffmpeg=sys.argv[2], ffprobe=sys.argv[3],
    model_command=[sys.executable, sys.argv[4], sys.argv[5]])
media = service.execute('probe_media', {'path': sys.argv[6]})
service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})
submitted = service.execute('analyze', {'media_id': media['media_id']})
while service.execute('get_task', submitted)['stage'] != 'model_loading': time.sleep(.01)
print(json.dumps(submitted), flush=True)
while True: time.sleep(.1)
"""
        child = subprocess.Popen([sys.executable, '-u', '-c', script, self.data.name,
            self.ffmpeg, self.ffprobe, str(Path(__file__).parent / 'fixtures/model_worker.py'),
            str(self.fixture), str(self.video)], stdout=subprocess.PIPE, text=True)
        try:
            submitted = json.loads(child.stdout.readline())
            child.kill()
            child.wait(timeout=5)
            self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
            interrupted = self.service.execute('get_task', submitted)
            saved = self.service.execute('get_result', {'result_id': completed['result_id']})
            self.assertEqual(('failed', 'service_interrupted', completed['result_id']),
                             (interrupted['status'], interrupted['error']['code'], saved['result_id']))
        finally:
            gate.touch()
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()

    def test_batch_and_later_tasks_publish_engine_reuse_records(self):
        first, second = self.media(), self.media(track=2)
        task = self.wait_task(self.service.execute('analyze', {
            'media_ids': [first['media_id'], second['media_id']]})['task_id'])
        results = [self.service.execute('get_result', {'result_id': item['result_id']})
                   for item in task['results']]
        results.append(self.analyze(first))
        runtime = [result['prediction']['runtime'] for result in results]
        self.assertEqual(([1, 2, 3], [False, True, True], 1),
                         ([record['inference_index'] for record in runtime],
                          [record['model_reused'] for record in runtime],
                          len({record['engine_instance_id'] for record in runtime})))

    def test_core_crash_does_not_leave_model_process_running(self):
        gate = Path(self.data.name) / 'release-orphan-model'
        pid_path = Path(self.data.name) / 'external-model.pid'
        self.fixture.write_text(json.dumps({'gate': str(gate), 'pid_path': str(pid_path)}))
        self.service.close()
        script = """import json, sys, time
from pathlib import Path
from model_service import ModelService
service = ModelService(data_dir=sys.argv[1], ffmpeg=sys.argv[2], ffprobe=sys.argv[3],
    model_command=[sys.executable, sys.argv[4], sys.argv[5]])
media = service.execute('probe_media', {'path': sys.argv[6]})
service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})
submitted = service.execute('analyze', {'media_id': media['media_id']})
while not Path(sys.argv[7]).exists(): time.sleep(.01)
print(json.dumps(submitted), flush=True)
while True: time.sleep(.1)
"""
        child = subprocess.Popen([sys.executable, '-u', '-c', script, self.data.name,
            self.ffmpeg, self.ffprobe, str(Path(__file__).parent / 'fixtures/task_model_worker.py'),
            str(self.fixture), str(self.video), str(pid_path)], stdout=subprocess.PIPE, text=True)
        try:
            json.loads(child.stdout.readline())
            process_id = int(pid_path.read_text())
            child.kill()
            child.wait(timeout=5)
            deadline = time.monotonic() + 3
            alive = True
            while time.monotonic() < deadline:
                try:
                    os.kill(process_id, 0)
                except ProcessLookupError:
                    alive = False
                    break
                time.sleep(.02)
            self.assertFalse(alive, 'external model process survived core crash')
        finally:
            gate.touch()
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()

    def test_recompute_uses_adjusted_gap_and_padding_then_refuses_previous_version(self):
        recording = Path(self.data.name) / '调参 录像.mkv'
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi',
            '-i', 'color=size=64x64:rate=10:duration=15', '-f', 'lavfi',
            '-i', 'sine=sample_rate=16000:duration=15', '-c:v', 'ffv1', '-c:a', 'pcm_s16le',
            str(recording)], check=True)
        self.fixture.write_text(json.dumps({'events': [[2, 2.2, 0], [8, 8.2, 1]]}))
        original = self.analyze(self.media(recording))
        updated = self.service.execute('recompute_candidates', {
            'result_id': original['result_id'], 'candidate_version': original['candidate_version'],
            'parameters': {'merge_gap_s': 6, 'before_s': 1, 'after_s': 2}})
        with self.assertRaises(ServiceError) as rejected:
            self.service.execute('recompute_candidates', {
                'result_id': original['result_id'], 'candidate_version': original['candidate_version'],
                'parameters': {'threshold': 0.3}})
        self.assertEqual((2, [(1, 10.2)], [True], 'stale_candidates', original['prediction']),
                         (len(original['candidates']), [(c['start_s'], round(c['end_s'], 2))
                          for c in updated['candidates']], [s['selected'] for s in updated['selection']],
                          rejected.exception.code, updated['prediction']))

    def test_each_batch_recording_preserves_its_stage_timings_with_the_result(self):
        first, second = self.media(), self.media(track=2)
        task = self.wait_task(self.service.execute('analyze', {
            'media_ids': [first['media_id'], second['media_id']]})['task_id'])
        for item in task['results']:
            result = self.service.execute('get_result', {'result_id': item['result_id']})
            self.assertEqual({'elapsed_s': item['elapsed_s'], 'timings': item['timings']}, result['analysis'])
            self.assertGreater(result['analysis']['elapsed_s'], 0)
            self.assertGreater(result['analysis']['timings']['extracting_audio'], 0)

    def test_service_stop_finishes_cancellation_and_prevents_closed_writer_mutations(self):
        gate = Path(self.data.name) / 'release-stopped-model'
        self.fixture.write_text(json.dumps({'gate': str(gate)}))
        media = self.media()
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        stopped = self.service
        stopped.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
        saved = self.service.execute('get_task', submitted)
        with self.assertRaises(ServiceError) as rejected:
            stopped.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 2})
        self.assertEqual(('cancelled', 'task_cancelled', 'service_stopping'),
                         (saved['status'], saved['error']['code'], rejected.exception.code))

    def test_busy_submission_is_rejected_before_rechecking_a_changed_source(self):
        recording = Path(self.data.name) / '忙碌 录像.mkv'
        shutil.copyfile(self.video, recording)
        gate = Path(self.data.name) / 'release-busy-model'
        self.fixture.write_text(json.dumps({'gate': str(gate)}))
        media = self.media(recording)
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            task = self.service.execute('get_task', submitted)
            if task['stage'] == 'model_loading':
                break
            time.sleep(.01)
        recording.unlink()
        try:
            with self.assertRaises(ServiceError) as rejected:
                self.service.execute('analyze', {'media_id': media['media_id']})
            started = time.monotonic()
            current = self.service.execute('get_task', submitted)
            self.assertEqual((409, 'task_busy', 'running'),
                             (rejected.exception.status, rejected.exception.code, current['status']))
            self.assertLess(time.monotonic() - started, 1)
        finally:
            gate.touch()

    def test_configuration_discovers_active_and_latest_tasks_after_a_fresh_connection_or_restart(self):
        gate = Path(self.data.name) / 'release-discoverable-model'
        self.fixture.write_text(json.dumps({'gate': str(gate), 'events': [[0.08, 0.2, 0]]}))
        media = self.media()
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        current = self.service.execute('get_config', {})
        try:
            self.assertEqual(submitted['task_id'], current['active_task_id'])
        finally:
            gate.touch()
        analyzed = self.wait_task(submitted['task_id'])
        result = self.service.execute('get_result', {'result_id': analyzed['result_id']})
        preview = self.service.execute('request_preview', {'result_id': result['result_id'],
            'candidate_version': result['candidate_version'], 'candidate_id': result['candidates'][0]['candidate_id']})
        self.assertEqual('completed', self.wait_task(preview['task_id'])['status'])
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
        restored = self.service.execute('get_config', {})
        self.assertEqual({'active': None, 'latest': preview['task_id'], 'analysis': submitted['task_id']},
                         {'active': restored['active_task_id'], 'latest': restored['latest_task_id'],
                          'analysis': restored['latest_analysis_task_id']})

    def test_failed_audio_extraction_preserves_its_diagnostic_log(self):
        media = self.media()
        failing = Path(self.data.name) / 'failing-ffmpeg'
        failing.write_text(f'#!{sys.executable}\nimport sys\nprint("controlled audio decoder failure", file=sys.stderr)\nsys.exit(7)\n')
        failing.chmod(0o755)
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=failing,
            ffprobe=self.ffprobe, model_command=[sys.executable,
            str(Path(__file__).parent / 'fixtures/model_worker.py'), str(self.fixture)])
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        failed = self.wait_task(submitted['task_id'])
        diagnostic = Path(failed['media_log']).read_text(encoding='utf-8')
        self.assertEqual(('failed', 'media_failed', True, failed['media_log']),
                         (failed['status'], failed['error']['code'],
                          'controlled audio decoder failure' in diagnostic, failed['results'][0]['media_log']))

    def test_ipc_parent_death_marks_work_interrupted_and_preserves_completed_analysis(self):
        gate = Path(self.data.name) / 'release-parent-death-model'
        gate.touch()
        pid_path = Path(self.data.name) / 'parent-death-model.pid'
        self.fixture.write_text(json.dumps({'gate': str(gate), 'pid_path': str(pid_path),
                                          'events': [[0.08, 0.2, 0]]}))
        workspace = Path(self.data.name) / 'controlled-model-workspace'
        (workspace / 'checkpoints').mkdir(parents=True)
        (workspace / 'checkpoints/BEATs_strong_1.pt').write_bytes(b'controlled external model')
        engine = Path(self.data.name) / 'controlled-engine-python'
        worker_fixture = Path(__file__).parent / 'fixtures/task_model_worker.py'
        engine.write_text(f'#!{sys.executable}\nimport runpy,sys\nsys.argv=[{str(worker_fixture)!r},{str(self.fixture)!r}]\nrunpy.run_path({str(worker_fixture)!r},run_name="__main__")\n')
        engine.chmod(0o755)
        self.service.close()
        script = """import json,os,subprocess,sys,time
from pathlib import Path
worker=subprocess.Popen([sys.executable,'-u',sys.argv[1],'--data-dir',sys.argv[2],
 '--ffmpeg',sys.argv[3],'--ffprobe',sys.argv[4],'--model-workspace',sys.argv[5],
 '--engine-python',sys.argv[6],'--parent-pid',str(os.getpid())],
 stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(worker.stdout.readline())['type']=='ready'
sequence=0
def operation(name,payload):
 global sequence
 sequence+=1
 worker.stdin.write(json.dumps({'id':str(sequence),'operation':name,'payload':payload})+'\\n')
 worker.stdin.flush()
 response=json.loads(worker.stdout.readline())
 assert response['id']==str(sequence),response
 assert 'error' not in response,response
 return response['result']
media=operation('probe_media',{'path':sys.argv[7]})
operation('confirm_audio',{'media_id':media['media_id'],'stream_index':1})
finished=operation('analyze',{'media_id':media['media_id']})
while True:
 completed=operation('get_task',finished)
 if completed['status']=='completed': break
 assert completed['status']=='running',completed
 time.sleep(.01)
Path(sys.argv[8]).unlink()
submitted=operation('analyze',{'media_id':media['media_id']})
while operation('get_task',submitted).get('engine_runtime',{}).get('inference_index')!=2: time.sleep(.01)
print(json.dumps({'worker_pid':worker.pid,'model_pid':int(Path(sys.argv[9]).read_text()),
 'task_id':submitted['task_id'],'completed_result_id':completed['result_id']}),flush=True)
while True: time.sleep(.1)
"""
        controller = subprocess.Popen([sys.executable, '-u', '-c', script,
            str(Path(__file__).resolve().parents[1] / 'model_ipc.py'), self.data.name,
            self.ffmpeg, self.ffprobe, str(workspace), str(engine), str(self.video),
            str(gate), str(pid_path)], stdout=subprocess.PIPE, text=True)
        observed = None
        try:
            observed = json.loads(controller.stdout.readline())
            controller.kill()
            controller.wait(timeout=5)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    os.kill(observed['worker_pid'], 0)
                except ProcessLookupError:
                    break
                time.sleep(.02)
            else:
                self.fail('IPC worker survived its parent death')
            self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
            interrupted = self.service.execute('get_task', {'task_id': observed['task_id']})
            completed = self.service.execute('get_result', {'result_id': observed['completed_result_id']})
            self.assertEqual(('failed', 'service_interrupted', observed['completed_result_id']),
                             (interrupted['status'], interrupted['error']['code'], completed['result_id']))
            with self.assertRaises(ProcessLookupError):
                os.kill(observed['model_pid'], 0)
        finally:
            gate.touch()
            if controller.poll() is None:
                controller.kill()
                controller.wait()
            controller.stdout.close()
            if observed:
                try:
                    os.kill(observed['worker_pid'], 15)
                except ProcessLookupError:
                    pass

    def test_failed_media_diagnostic_is_bounded_and_visible_without_breaking_status_queries(self):
        media = self.media()
        failing = Path(self.data.name) / 'verbose-failing-ffmpeg'
        failing.write_text(f'#!{sys.executable}\nimport sys\n'
            'print("beginning-only-marker\\n" + "x" * 10000 + "\\ncontrolled decoder tail failure", file=sys.stderr)\n'
            'sys.exit(7)\n')
        failing.chmod(0o755)
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=failing,
            ffprobe=self.ffprobe, model_command=[sys.executable,
            str(Path(__file__).parent / 'fixtures/model_worker.py'), str(self.fixture)])
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        failed = self.wait_task(submitted['task_id'])
        self.assertIn('controlled decoder tail failure', failed['media_log_tail'])
        self.assertNotIn('beginning-only-marker', failed['media_log_tail'])
        self.assertLessEqual(len(failed['media_log_tail'].encode('utf-8')), 8192)
        self.assertTrue(failed['media_log_truncated'])
        Path(failed['media_log']).unlink()
        unavailable = self.service.execute('get_task', submitted)
        self.assertEqual(('failed', failed['error'], ''),
                         (unavailable['status'], unavailable['error'], unavailable['media_log_tail']))

    def test_source_replaced_during_probe_cannot_bind_old_metadata_to_new_identity(self):
        recording = Path(self.data.name) / '探测中替换 录像.mkv'
        replacement = Path(self.data.name) / 'replacement.mkv'
        shutil.copyfile(self.video, recording)
        subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-n', '-f', 'lavfi',
            '-i', 'color=size=96x64:rate=10:duration=2', '-f', 'lavfi',
            '-i', 'sine=sample_rate=16000:duration=2', '-c:v', 'ffv1', '-c:a', 'pcm_s16le',
            str(replacement)], check=True)
        ready = Path(self.data.name) / 'original-metadata-ready'
        release = Path(self.data.name) / 'release-probe'
        wrapper = Path(self.data.name) / 'gated-ffprobe'
        wrapper.write_text(f'''#!{sys.executable}
import json,pathlib,subprocess,sys,time
if '-show_streams' in sys.argv:
    metadata=json.loads(subprocess.check_output([{self.ffprobe!r}, *sys.argv[1:]]))
    next(s for s in metadata['streams'] if s['codec_type']=='video')['duration']='1.0'
    pathlib.Path({str(ready)!r}).touch()
    while not pathlib.Path({str(release)!r}).exists(): time.sleep(.01)
    print(json.dumps(metadata))
else:
    subprocess.run([{self.ffprobe!r}, *sys.argv[1:]], check=True)
''')
        wrapper.chmod(0o755)
        self.service.close()
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=wrapper)
        observed = {}

        def probe():
            try:
                observed['media'] = self.service.execute('probe_media', {'path': str(recording)})
            except ServiceError as error:
                observed.update(code=error.code, status=error.status)

        task = threading.Thread(target=probe)
        task.start()
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists(), 'external ffprobe did not capture the original media')
            recording.write_bytes(replacement.read_bytes())
        finally:
            release.touch()
            task.join(timeout=5)
        self.assertFalse(task.is_alive())
        self.assertEqual({'code': 'source_changed', 'status': 409}, observed)

    def test_restart_discovers_existing_legacy_tasks_when_lightweight_state_is_absent(self):
        media = self.media()
        submitted = self.service.execute('analyze', {'media_id': media['media_id']})
        analyzed = self.wait_task(submitted['task_id'])
        result = self.service.execute('get_result', {'result_id': analyzed['result_id']})
        preview = self.service.execute('request_preview', {'result_id': result['result_id'],
            'candidate_version': result['candidate_version'], 'candidate_id': result['candidates'][0]['candidate_id']})
        self.assertEqual('completed', self.wait_task(preview['task_id'])['status'])
        self.service.close()
        # Version-1 tasks predate the lightweight state file and kind field.
        state = Path(self.data.name) / 'state.json'
        state.unlink()
        record_path = Path(self.data.name) / 'tasks' / (submitted['task_id'] + '.json')
        legacy = json.loads(record_path.read_text())
        legacy.pop('kind')
        record_path.write_text(json.dumps(legacy))
        self.service = ModelService(data_dir=self.data.name, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe)
        restored = self.service.execute('get_config', {})
        self.assertEqual({'active': None, 'latest': preview['task_id'], 'analysis': submitted['task_id']},
                         {'active': restored['active_task_id'], 'latest': restored['latest_task_id'],
                          'analysis': restored['latest_analysis_task_id']})
        self.assertEqual(result['result_id'], self.service.execute('get_result', {
            'result_id': result['result_id']})['result_id'])


if __name__ == '__main__':
    unittest.main()
