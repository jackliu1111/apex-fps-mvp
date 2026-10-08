"""Transport-independent operations for the audio-model service."""
import json
import math
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import uuid
import time
import copy
import sys
import os
import signal
import shutil
from datetime import datetime, timezone
from model_review import ModelReviewMixin
from model_identity import file_identity, configuration_identity, prediction_cache_key
from model_runtime import acquire_directory, guarded_command


class ServiceError(Exception):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code = code
        self.status = status


def _time(value):
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except (ValueError, TypeError):
        pass
    raise ServiceError('unreadable_media', '缺少可靠的时间戳或时长，无法确定录像时间映射')


class ModelService(ModelReviewMixin):
    def __init__(self, *, data_dir, ffmpeg, ffprobe, model_workspace=None, checkpoint=None,
                 model_command=None, engine_python=None):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.ffmpeg = str(ffmpeg)
        self.ffprobe = str(ffprobe)
        self.model_workspace = Path(model_workspace).expanduser().resolve() if model_workspace else None
        self.checkpoint = Path(checkpoint).expanduser().resolve() if checkpoint else (
            self.model_workspace / 'checkpoints' / 'BEATs_strong_1.pt' if self.model_workspace else None)
        self.records_dir = self.data_dir / 'media'
        self.records_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.close_lock = threading.Lock()
        self.tasks_dir = self.data_dir / 'tasks'
        self.tasks_dir.mkdir(exist_ok=True)
        self.tasks = {}
        self.results_dir = self.data_dir / 'results'
        self.results_dir.mkdir(exist_ok=True)
        self.model_command = model_command or [engine_python or sys.executable, '-u',
                                              str(Path(__file__).with_name('model_inference.py'))]
        self.configured_model = model_command is not None or bool(self.model_workspace and self.checkpoint)
        self.worker = None
        self.worker_configuration = None
        self.worker_runtime = None
        self.worker_log = None
        self.analysis_thread = None
        self.active_task = None
        self.model_state = 'not_loaded'
        self.cancel_events = {}
        self.media_process = None
        self.closing = False
        try:
            self.directory_lock = acquire_directory(self)
        except OSError as exc:
            raise ServiceError('data_dir_locked', '数据目录已由其他服务使用，请停止该服务或选择不同目录', 409) from exc
        self.read_only = self.directory_lock is None
        self.state_path = self.data_dir / 'state.json'
        self.reference_state = self.read_reference_state()
        if not self.read_only:
            self.recover_interrupted_tasks()
            self.reference_state['active_task_id'] = None
            self.save_record(self.state_path, self.reference_state)

    def execute(self, operation, request):
        if not isinstance(request, dict):
            raise ServiceError('invalid_request', '请求必须是 JSON 对象', 400)
        read_operations = ('get_config', 'browse', 'get_media', 'get_task', 'get_result', 'read_scores', 'get_artifact')
        if self.closing and operation not in (*read_operations, 'cancel_task'):
            raise ServiceError('service_stopping', '服务已停止，不能提交修改；请使用新的服务实例', 503)
        if self.read_only and operation not in read_operations:
            raise ServiceError('data_dir_locked', '同一目录的只读查看实例不能提交修改，请使用拥有目录的服务', 409)
        required = {'probe_media': ('path',), 'confirm_audio': ('media_id', 'stream_index'),
                    'get_media': ('media_id',),
                    'get_task': ('task_id',), 'get_result': ('result_id',),
                    'cancel_task': ('task_id',),
                    'recompute_candidates': ('result_id', 'candidate_version', 'parameters'),
                    'read_scores': ('prediction_id', 'start_s', 'end_s')}.get(operation, ())
        if any(key not in request for key in required):
            raise ServiceError('invalid_request', '请求缺少必要字段', 400)
        if operation == 'get_config':
            with self.lock:
                references = self.read_reference_state() if self.read_only else dict(self.reference_state)
            return {
                'schema_version': 1, 'time_unit': 'seconds', 'home': str(Path.home()),
                'data_dir': str(self.data_dir), 'ffmpeg': self.ffmpeg, 'ffprobe': self.ffprobe,
                'model_workspace': str(self.model_workspace) if self.model_workspace else None,
                'checkpoint': str(self.checkpoint) if self.checkpoint else None,
                'checkpoint_available': bool(self.checkpoint and self.checkpoint.is_file()),
                'model_state': self.model_state,
                'data_dir_read_only': self.read_only,
                'export_modes': ['copy'], 'precise_export_available': False,
                **{key: references[key] for key in ('active_task_id', 'latest_task_id', 'latest_analysis_task_id')},
            }
        if operation == 'probe_media':
            try:
                return self.probe_media(request['path'])
            except OSError as exc:
                raise ServiceError('media_tool_unavailable', '媒体工具或记录目录不可用，请检查配置', 503) from exc
            except (subprocess.SubprocessError, KeyError, ValueError, TypeError) as exc:
                raise ServiceError('unreadable_media', '无法读取可靠的媒体信息或时间映射，请重新选择录像') from exc
        if operation == 'get_media':
            return self.get_media(request['media_id'])
        if operation == 'analyze':
            with self.lock:
                if self.closing:
                    raise ServiceError('service_stopping', '服务正在停止', 503)
                if self.active_task is not None:
                    raise ServiceError('task_busy', '已有活动任务，请等待完成后再提交', 409)
            identifiers = request.get('media_ids', [request.get('media_id')])
            if not isinstance(identifiers, list) or not identifiers or any(not isinstance(i, str) for i in identifiers):
                raise ServiceError('invalid_request', '请选择至少一份录像', 400)
            media = [self.get_media(identifier) for identifier in identifiers]
            if any(item['selected_audio'] is None for item in media):
                raise ServiceError('audio_not_confirmed', '请先明确确认所有录像的检测音轨')
            for item in media:
                self.validate_media(item)
            return self.start_task('analysis', lambda task: self.run_batch(task, media),
                                   media_id=identifiers[0], media_ids=identifiers, results=[])
        if operation == 'get_task':
            if not isinstance(request['task_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', request['task_id']):
                raise ServiceError('task_not_found', '任务不存在', 404)
            with self.lock:
                task = self.tasks.get(request['task_id'])
                if task is None:
                    task = self.read_record(self.tasks_dir, request['task_id'], 'task_not_found')
                result = copy.deepcopy(task)
                if result['status'] in ('running', 'cancelling'):
                    result['elapsed_s'] = (datetime.now(timezone.utc) - datetime.fromisoformat(result['started_at'])).total_seconds()
            result.update(media_log_tail='', media_log_truncated=False)
            if result.get('media_log'):
                try:
                    with Path(result['media_log']).open('rb') as diagnostic:
                        size = diagnostic.seek(0, os.SEEK_END)
                        diagnostic.seek(max(0, size - 8192))
                        raw = diagnostic.read(8192)
                    utf8 = raw.decode('utf-8', errors='replace').encode('utf-8')
                    result['media_log_tail'] = utf8[-8192:].decode('utf-8', errors='ignore')
                    result['media_log_truncated'] = size > 8192 or len(utf8) > 8192
                except (OSError, TypeError, ValueError):
                    pass
            return result
        if operation == 'cancel_task':
            with self.lock:
                task = self.execute('get_task', request)
                if task['status'] not in ('running', 'cancelling'):
                    return task
                current = self.tasks[task['task_id']]
                self.cancel_events[task['task_id']].set()
                self.update_task(current, status='cancelling')
                for process in (self.media_process, self.worker):
                    if process is not None and process.poll() is None:
                        self.signal_process(process)
                return copy.deepcopy(current)
        if operation == 'get_result':
            return self.read_record(self.results_dir, request['result_id'], 'result_not_found', nested=True)
        if operation == 'read_scores':
            return self.read_scores(request)
        if operation == 'recompute_candidates':
            result = self.execute('get_result', {'result_id': request['result_id']})
            self.validate_result(result)
            if request['candidate_version'] != result['candidate_version']:
                raise ServiceError('stale_candidates', '候选版本已经更新，请重新复核', 409)
            parameters = request['parameters']
            keys = ('threshold', 'merge_gap_s', 'before_s', 'after_s')
            if not isinstance(parameters, dict) or any(key not in keys for key in parameters):
                raise ServiceError('invalid_parameters', '参数必须是阈值、间隔和前后留白')
            configured = {**result['parameters'], **parameters}
            for key in keys:
                value = configured[key]
                if (isinstance(value, bool) or not isinstance(value, (float, int))
                        or not math.isfinite(value) or value < 0
                        or (key == 'threshold' and value > 1)):
                    raise ServiceError('invalid_parameters', '参数必须为有限非负数，阈值须在 0–1 之间')
            folder = self.results_dir / result['result_id']
            updated = self.build_result({'task_id': result['result_id']}, result['media'],
                                        folder, result['prediction'], configured)
            if 'analysis' in result:
                updated['analysis'] = result['analysis']
            with self.lock:
                current = self.execute('get_result', {'result_id': request['result_id']})
                if current['candidate_version'] != request['candidate_version']:
                    raise ServiceError('stale_candidates', '候选版本已经更新，请重新复核', 409)
                self.save_record(folder / 'result.json', updated)
                return updated
        if operation == 'browse':
            try:
                path = Path(request.get('path') or Path.home()).expanduser().resolve()
                if not path.is_dir():
                    raise ServiceError('invalid_path', '请选择可读取的本地目录')
                entries = [{'name': p.name, 'path': str(p), 'is_dir': p.is_dir()}
                           for p in path.iterdir() if not p.name.startswith('.')]
            except (OSError, ValueError, TypeError) as exc:
                raise ServiceError('invalid_path', '目录不存在或不可读') from exc
            return {'path': str(path), 'parent': str(path.parent),
                    'entries': sorted(entries, key=lambda p: (not p['is_dir'], p['name'].casefold()))}
        if operation == 'confirm_audio':
            with self.lock:
                media = self.get_media(request['media_id'])
                index = request.get('stream_index')
                audio = next((t for t in media['audio_tracks']
                              if t['stream_index'] == index), None)
                if type(index) is not int or audio is None:
                    raise ServiceError('invalid_audio_track', '请明确选择录像中可用的音轨')
                video_origin = media['video']['start_time_s']
                audio_origin = audio['start_time_s']
                media['selected_audio'] = {
                    'stream_index': audio['stream_index'],
                    'video_origin_s': video_origin, 'audio_origin_s': audio_origin,
                    'audio_to_video_offset_s': audio_origin - video_origin,
                }
                self.save_media(media)
                return media
        reviewed = self.execute_review(operation, request)
        if reviewed is not NotImplemented:
            return reviewed
        raise ServiceError('not_found', '操作不存在', 404)

    def start_task(self, kind, runner, **fields):
        with self.lock:
            if self.closing:
                raise ServiceError('service_stopping', '服务正在停止', 503)
            if self.active_task is not None:
                raise ServiceError('task_busy', '已有活动任务，请等待完成后再提交', 409)
            task = {'schema_version': 1, 'task_id': uuid.uuid4().hex, 'kind': kind,
                    'status': 'running', 'stage': 'starting', 'progress': 0,
                    'timings': {}, 'logs': [], 'error': None, 'result_id': None,
                    'started_at': datetime.now(timezone.utc).isoformat(), **fields}
            self.active_task = task['task_id']
            self.tasks[task['task_id']] = task
            self.cancel_events[task['task_id']] = threading.Event()
            self.update_task(task)
            self.reference_state.update(active_task_id=task['task_id'], latest_task_id=task['task_id'])
            if kind == 'analysis':
                self.reference_state['latest_analysis_task_id'] = task['task_id']
            self.save_record(self.state_path, self.reference_state)
            self.analysis_thread = threading.Thread(target=self.run_task, args=(task, runner), daemon=True)
            self.analysis_thread.start()
            return {'task_id': task['task_id']}

    def run_task(self, task, runner):
        started = time.perf_counter()
        try:
            runner(task)
            self.check_cancelled(task)
            terminal = {'status': 'completed', 'stage': 'completed', 'progress': 1}
        except Exception as exc:
            cancelled = self.cancel_events[task['task_id']].is_set()
            interrupted = task.get('shutdown_reason') == 'service_interrupted'
            code = 'service_interrupted' if interrupted else 'task_cancelled' if cancelled else exc.code if isinstance(exc, ServiceError) else 'task_failed'
            if cancelled:
                self.stop_worker()
            self.cleanup_pending(task)
            terminal = {'status': 'cancelled' if cancelled and not interrupted else 'failed',
                        'stage': 'cancelled' if cancelled and not interrupted else 'failed',
                        'error': {'code': code, 'message': '入口异常退出，任务已中断并清理完成；已完成产物保留' if interrupted
                                  else '任务已取消，清理完成' if cancelled else str(exc)}}
        finally:
            with self.lock:
                self.active_task = None
                self.reference_state['active_task_id'] = None
                self.save_record(self.state_path, self.reference_state)
                self.update_task(task, elapsed_s=time.perf_counter() - started, **terminal)

    def run_batch(self, task, media):
        for index, item in enumerate(media):
            self.check_cancelled(task)
            item_started = time.perf_counter()
            with self.lock:
                task['timings'] = {}
            self.update_task(task, current_media_id=item['media_id'], current_index=index,
                             batch_progress=index / len(media))
            result_id = task['task_id'] if len(media) == 1 else uuid.uuid4().hex
            self.update_task(task, current_result_id=result_id)
            try:
                analysis = self.run_analysis(task, item, result_id)
                result = {'media_id': item['media_id'], 'status': 'completed',
                          'result_id': result_id, 'error': None, **analysis['analysis'],
                          'media_log': task.get('media_log')}
            except Exception as exc:
                interrupted = task.get('shutdown_reason') == 'service_interrupted'
                code = exc.code if isinstance(exc, ServiceError) else (
                    'media_failed' if task['stage'] == 'extracting_audio' else
                    'model_load_failed' if task['stage'] == 'model_loading' else 'model_inference_failed')
                result = {'media_id': item['media_id'], 'status': 'cancelled' if self.cancel_events[task['task_id']].is_set() and not interrupted else 'failed', 'result_id': None,
                          'error': {'code': 'service_interrupted' if interrupted else code,
                                    'message': '入口异常退出，分析已中断' if interrupted else str(exc)},
                          'timings': copy.deepcopy(task['timings']), 'elapsed_s': time.perf_counter() - item_started,
                          'media_log': task.get('media_log')}
            self.update_task(task, results=[*task['results'], result],
                             result_id=result_id if result['status'] == 'completed' else task['result_id'])
            self.check_cancelled(task)
        if not any(item['status'] == 'completed' for item in task['results']):
            error = task['results'][-1]['error']
            raise ServiceError(error['code'], error['message'])
        self.update_task(task, batch_progress=1)

    def run_analysis(self, task, media, result_id):
        started = time.perf_counter()
        folder = self.results_dir / result_id
        media_log = self.tasks_dir / 'logs' / task['task_id'] / f'{result_id}.log'
        try:
            folder.mkdir()
            media_log.parent.mkdir(parents=True, exist_ok=True)
            media_log.touch()
            self.update_task(task, media_log=str(media_log))
            self.check_cancelled(task)
            self.validate_media(media)
            if not self.configured_model:
                raise ServiceError('model_load_failed', '请配置可用的模型工作目录与权重')
            self.update_task(task, stage='extracting_audio')
            extraction_start = time.perf_counter()
            audio = folder / 'audio.wav'
            self.run_process(task, [self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-n',
                                '-protocol_whitelist', 'file,pipe', '-i', media['source']['path'],
                                '-map', f"0:{media['selected_audio']['stream_index']}",
                                '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(audio)],
                             media_log)
            self.update_task(task, timings={'extracting_audio': time.perf_counter() - extraction_start},
                             stage='model_loading')
            self.model_state = 'loading'
            configuration = configuration_identity(self.model_workspace, self.checkpoint, self.current_cancel_check)
            if self.worker is None or self.worker.poll() is not None or self.worker_configuration != configuration:
                self.stop_worker()
                self.worker_log = (self.data_dir / 'model-worker.log').open('ab')
                self.worker = subprocess.Popen(guarded_command(self.model_command), stdin=subprocess.PIPE,
                                               stdout=subprocess.PIPE, stderr=self.worker_log,
                                               text=True, encoding='utf-8', bufsize=1, start_new_session=os.name != 'nt')
                self.worker_configuration = configuration
                self.worker_runtime = {'engine_instance_id': uuid.uuid4().hex,
                                       'process_id': self.worker.pid, 'inference_index': 0,
                                       'reported_by': 'host'}
            self.worker_runtime['inference_index'] += 1
            runtime = {**self.worker_runtime, 'model_reused': self.worker_runtime['inference_index'] > 1}
            self.update_task(task, engine_runtime=runtime)
            self.check_cancelled(task)
            self.worker.stdin.write(json.dumps({
                'audio': str(audio), 'scores_path': str(folder / 'scores.npz'),
                'model_workspace': str(self.model_workspace) if self.model_workspace else None,
                'checkpoint': str(self.checkpoint) if self.checkpoint else None}) + '\n')
            self.worker.stdin.flush()
            message = None
            for line in self.worker.stdout:
                self.check_cancelled(task)
                event = json.loads(line)
                if event['type'] == 'error':
                    raise ServiceError(event['code'], event['message'])
                if event['type'] == 'result':
                    message = event
                    break
                self.update_task(task, **{k: v for k, v in event.items() if k != 'type'})
            if message is None:
                self.check_cancelled(task)
                raise ServiceError('model_inference_failed', '模型进程退出，请检查模型日志')
            self.model_state = 'loaded'
            if configuration != configuration_identity(self.model_workspace, self.checkpoint, self.current_cancel_check):
                raise ServiceError('analysis_configuration_changed', '模型配置在推理期间变化，请重新分析', 409)
            message['configuration'] = configuration
            message['runtime'] = message.get('runtime', runtime)
            if 'timings' in message:
                self.update_task(task, timings=message['timings'])
            self.update_task(task, stage='postprocessing', progress=0)
            self.check_cancelled(task)
            post_start = time.perf_counter()
            result = self.build_result({'task_id': result_id}, media, folder, message)
            self.validate_media(media)
            self.check_cancelled(task)
            timings = {**task['timings'], 'postprocessing': time.perf_counter() - post_start}
            result['analysis'] = {'elapsed_s': time.perf_counter() - started, 'timings': timings}
            self.save_record(folder / 'prediction.json', {
                'schema_version': 1, 'prediction_id': result['prediction_id'],
                'media': media, **result['prediction']})
            self.save_record(folder / 'result.json', result)
            self.update_task(task, timings=timings)
            return result
        except Exception as exc:
            self.model_state = 'failed'
            try:
                with media_log.open('a', encoding='utf-8') as diagnostic:
                    diagnostic.write('\n' + json.dumps({'stage': task['stage'],
                        'code': getattr(exc, 'code', 'analysis_failed'), 'message': str(exc)},
                        ensure_ascii=False) + '\n')
            except OSError:
                pass
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def check_cancelled(self, task):
        if self.cancel_events.get(task['task_id'], threading.Event()).is_set():
            raise ServiceError('task_cancelled', '任务正在取消', 409)

    def current_cancel_check(self):
        if threading.current_thread() is self.analysis_thread and self.active_task is not None:
            self.check_cancelled(self.tasks[self.active_task])

    def signal_process(self, process, *, force=False):
        try:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Sandboxed hosts may allow signalling our child but deny killpg.
            try:
                process.kill() if force else process.terminate()
            except ProcessLookupError:
                pass

    def stop_process(self, process):
        if process is not None and process.poll() is None:
            self.signal_process(process)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.signal_process(process, force=True)
                process.wait(timeout=5)

    def run_process(self, task, args, log_path, *, stdout=None):
        self.check_cancelled(task)
        with Path(log_path).open('ab') as log:
            process = subprocess.Popen(guarded_command(args), stdin=subprocess.DEVNULL,
                stdout=log if stdout is None else stdout, stderr=log,
                start_new_session=os.name != 'nt')
            with self.lock:
                self.media_process = process
            try:
                while process.poll() is None:
                    self.check_cancelled(task)
                    time.sleep(0.02)
                self.check_cancelled(task)
                if process.returncode:
                    raise ServiceError('media_failed', '媒体工具执行失败，请查看任务媒体日志')
            finally:
                self.stop_process(process)
                with self.lock:
                    if self.media_process is process:
                        self.media_process = None

    def stop_worker(self):
        worker = self.worker
        if worker is not None:
            self.stop_process(worker)
            worker.stdin.close()
            worker.stdout.close()
            self.worker_log.close()
            self.worker = None
            self.model_state = 'not_loaded'

    def update_task(self, task, **changes):
        with self.lock:
            if 'timings' in changes:
                changes['timings'] = {**task['timings'], **changes['timings']}
            task.update(changes)
            task['logs'].append({'stage': task['stage'], 'progress': task['progress']})
            task['logs'] = task['logs'][-200:]
            self.save_record(self.tasks_dir / f"{task['task_id']}.json", task)

    def recover_interrupted_tasks(self):
        for path in self.tasks_dir.glob('*.json'):
            task = json.loads(path.read_text(encoding='utf-8'))
            if task.get('status') in ('running', 'cancelling'):
                self.cleanup_pending(task)
                task.update(status='failed', stage='failed',
                    error={'code': 'service_interrupted', 'message': '上次服务中断，任务未继续；已完成产物已保留'})
                self.save_record(path, task)

    def read_reference_state(self):
        defaults = {'schema_version': 1, 'active_task_id': None,
                    'latest_task_id': None, 'latest_analysis_task_id': None}
        try:
            record = json.loads(self.state_path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            latest, latest_analysis = None, None
            for path in self.tasks_dir.glob('*.json'):
                if not re.fullmatch(r'[0-9a-f]{32}', path.stem):
                    continue
                try:
                    task = json.loads(path.read_text(encoding='utf-8'))
                    if not isinstance(task, dict) or task.get('task_id') != path.stem:
                        continue
                    kind = task.get('kind', 'analysis')
                    if kind not in ('analysis', 'preview', 'export'):
                        continue
                    started = datetime.fromisoformat(task['started_at'].replace('Z', '+00:00'))
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=timezone.utc)
                    key = (started, task['task_id'])
                except (OSError, ValueError, TypeError, KeyError, AttributeError):
                    continue
                if latest is None or key > latest:
                    latest = key
                    defaults['latest_task_id'] = task['task_id']
                if kind == 'analysis' and (latest_analysis is None or key > latest_analysis):
                    latest_analysis = key
                    defaults['latest_analysis_task_id'] = task['task_id']
            return defaults
        return {key: record.get(key, value) for key, value in defaults.items()}

    def cleanup_pending(self, task):
        identifier = task.get('current_result_id')
        if isinstance(identifier, str) and re.fullmatch(r'[0-9a-f]{32}', identifier):
            folder = self.results_dir / identifier
            if folder.exists() and not (folder / 'result.json').is_file():
                shutil.rmtree(folder, ignore_errors=True)
        for path in task.get('pending_paths', []):
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass
        task['pending_paths'] = []

    def validate_media(self, media):
        try:
            current = file_identity(media['source']['path'], self.current_cancel_check)
            expected = {key: media['source'][key] for key in current}
        except (OSError, KeyError) as exc:
            raise ServiceError('source_changed', '源录像不可用或缺少身份记录，请重新探测和分析', 409) from exc
        if current != expected:
            raise ServiceError('source_changed', '源录像内容、大小或修改时间已变化，请重新探测和分析', 409)

    def validate_result(self, result):
        self.validate_media(result['media'])
        current = self.get_media(result['media']['media_id'])
        if current['selected_audio'] != result['media']['selected_audio']:
            raise ServiceError('analysis_configuration_changed', '检测音轨已变化，请重新分析', 409)
        if result['prediction'].get('configuration') != configuration_identity(self.model_workspace, self.checkpoint, self.current_cancel_check):
            raise ServiceError('analysis_configuration_changed', '模型、权重或前处理已变化，请重新分析', 409)

    def read_record(self, directory, identifier, code, *, nested=False):
        if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{32}', identifier):
            raise ServiceError(code, '记录不存在', 404)
        path = directory / identifier / 'result.json' if nested else directory / f'{identifier}.json'
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError as exc:
            raise ServiceError(code, '记录不存在', 404) from exc

    def build_result(self, task, media, folder, message, parameters=None):
        import numpy as np
        with np.load(folder / 'scores.npz', allow_pickle=False) as archive:
            scores = archive['probabilities']
            starts, ends = archive['frame_onsets'], archive['frame_offsets']
            classes = archive['class_names'].tolist()
        if (scores.shape != (len(starts), len(classes)) or not len(starts)
                or len(ends) != len(starts) or not np.isfinite(scores).all()
                or (scores < 0).any() or (scores > 1).any()):
            raise ServiceError('model_inference_failed', '模型分数维度或数值无效，不能生成候选')
        shift = media['selected_audio']['audio_to_video_offset_s']
        parameters = parameters or {'threshold': 0.2, 'threshold_comparison': '>', 'median_frames': 3,
                                     'merge_gap_s': 5, 'before_s': 5, 'after_s': 5,
                                     'class_merge': 'union-of-thresholded-target-classes'}
        # Decode each target class after a three-frame median, then union activity.
        indices = [classes.index(name) for name in ('Gunshot, gunfire', 'Machine gun')]
        target = scores[:, indices]
        padded = np.pad(target, ((1, 1), (0, 0)), mode='symmetric')
        smoothed = np.median(np.stack([padded[i:i + len(target)] for i in range(3)]), axis=0)
        active = (smoothed > parameters['threshold']).any(axis=1)
        boundaries = np.diff(np.r_[False, active, False].astype(int))
        events = []
        for first, stop in zip(np.flatnonzero(boundaries == 1), np.flatnonzero(boundaries == -1)):
            start, end = max(0.0, float(starts[first]) + shift), min(media['duration_s'], float(ends[stop - 1]) + shift)
            if start < end:
                events.append({'event_id': f'e{len(events) + 1}', 'start_s': start, 'end_s': end,
                               'classes': [classes[indices[i]] for i in range(2)
                                           if (smoothed[first:stop, i] > parameters['threshold']).any()]})
        candidates = []
        candidate_version = uuid.uuid4().hex
        for event in events:
            if candidates and event['start_s'] - candidates[-1]['event_end_s'] <= parameters['merge_gap_s']:
                group = candidates[-1]
                group['event_end_s'] = event['end_s']
                group['end_s'] = min(media['duration_s'], event['end_s'] + parameters['after_s'])
                group['event_ids'].append(event['event_id'])
            else:
                candidates.append({'candidate_id': f'{candidate_version[:8]}-c{len(candidates) + 1}',
                                   'event_start_s': event['start_s'], 'event_end_s': event['end_s'],
                                   'start_s': max(0.0, event['start_s'] - parameters['before_s']),
                                   'end_s': min(media['duration_s'], event['end_s'] + parameters['after_s']),
                                   'event_ids': [event['event_id']]})
        configuration = message.get('configuration') or configuration_identity(self.model_workspace, self.checkpoint)
        return {'schema_version': 1, 'time_unit': 'seconds', 'result_id': task['task_id'],
                'prediction_id': task['task_id'], 'candidate_version': candidate_version,
                'media': media, 'prediction': {
                    'frame_count': len(starts), 'classes': classes,
                    'valid_duration_s': message['valid_duration_s'], 'frame_step_s': 0.04,
                    'audio_to_video_offset_s': shift, 'model': message['model'],
                    'configuration': configuration,
                    'runtime': message.get('runtime'),
                    'cache_key': prediction_cache_key(media, configuration),
                    'covered_samples': message.get('covered_samples'),
                    'processed_windows': message.get('processed_windows'),
                    'padded_samples_last_window': message.get('padded_samples_last_window'),
                    'metadata_path': str(folder / 'prediction.json'),
                    'scores_format': 'npz-float32-time-by-class',
                    'scores_path': str(folder / 'scores.npz')},
                'parameters': parameters,
                'events': events, 'candidates': candidates,
                'selection': [{'candidate_id': c['candidate_id'], 'selected': True,
                               'start_s': c['start_s'], 'end_s': c['end_s'], 'revision': 1}
                              for c in candidates],
                'meaning': '枪声候选不代表本人开枪、命中或击杀'}

    def read_scores(self, request):
        import numpy as np
        result = self.read_record(self.results_dir, request['prediction_id'], 'result_not_found', nested=True)
        try:
            start, end = float(request['start_s']), float(request['end_s'])
            if isinstance(request['start_s'], bool) or isinstance(request['end_s'], bool):
                raise ValueError('boolean range')
            if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= result['media']['duration_s']:
                raise ValueError('out of range')
        except (TypeError, ValueError) as exc:
            raise ServiceError('invalid_range', '范围必须满足 0 ≤ start < end ≤ 录像时长') from exc
        with np.load(self.results_dir / request['prediction_id'] / 'scores.npz', allow_pickle=False) as archive:
            shift = result['prediction']['audio_to_video_offset_s']
            starts, ends = archive['frame_onsets'] + shift, archive['frame_offsets'] + shift
            available = np.flatnonzero((starts < end - 1e-9) & (ends > start + 1e-9))
            selected = available[:1000]
            return {'prediction_id': request['prediction_id'], 'classes': result['prediction']['classes'],
                    'frame_onsets_s': starts[selected].tolist(), 'frame_offsets_s': ends[selected].tolist(),
                    'scores': archive['probabilities'][selected].tolist(),
                    'next_start_s': float(ends[selected[-1]]) if len(available) > 1000 else None}

    def close(self, *, interrupted=False):
        with self.close_lock:
            self.close_service(interrupted=interrupted)

    def close_service(self, *, interrupted=False):
        with self.lock:
            self.closing = True
            identifier = self.active_task
            if interrupted and identifier is not None:
                self.tasks[identifier]['shutdown_reason'] = 'service_interrupted'
        if identifier is not None:
            self.execute('cancel_task', {'task_id': identifier})
        if self.analysis_thread is not None:
            self.analysis_thread.join(timeout=10)
        self.stop_process(self.media_process)
        self.stop_worker()
        if getattr(self, 'directory_lock', None) is not None:
            self.directory_lock.close()
            self.directory_lock = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    def save_record(self, path, record):
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                         dir=path.parent, delete=False) as stream:
            json.dump(record, stream, ensure_ascii=False, allow_nan=False, indent=2)
            temp = Path(stream.name)
        try:
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def get_media(self, media_id):
        if not isinstance(media_id, str) or not re.fullmatch(r'[0-9a-f]{32}', media_id):
            raise ServiceError('media_not_found', '媒体记录不存在，请重新探测', 404)
        with self.lock:
            try:
                return json.loads((self.records_dir / f'{media_id}.json').read_text(encoding='utf-8'))
            except FileNotFoundError as exc:
                raise ServiceError('media_not_found', '媒体记录不存在，请重新探测', 404) from exc

    def save_media(self, media):
        with self.lock:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                             dir=self.records_dir, delete=False) as stream:
                json.dump(media, stream, ensure_ascii=False, allow_nan=False, indent=2)
                temp = Path(stream.name)
            try:
                temp.replace(self.records_dir / f"{media['media_id']}.json")
            finally:
                temp.unlink(missing_ok=True)

    def probe_media(self, source):
        if not isinstance(source, str) or not source.strip() or '\0' in source:
            raise ServiceError('invalid_path', '请输入有效的本地录像路径')
        try:
            path = Path(source).expanduser().resolve()
            if not path.is_file():
                raise ServiceError('invalid_path', '录像文件不存在，或路径不是文件')
            with path.open('rb') as stream:
                stream.read(1)
        except OSError as exc:
            raise ServiceError('unreadable_media', '录像文件不可读，请检查权限') from exc
        try:
            source_identity = file_identity(path)
        except OSError as exc:
            raise ServiceError('source_changed', '源录像在探测前的身份核对期间变化或不可用，请重新探测', 409) from exc
        try:
            probe = json.loads(subprocess.check_output([
                self.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
                '-show_format', '-show_streams', '-of', 'json', str(path),
            ], stderr=subprocess.PIPE, timeout=30))
        except (subprocess.SubprocessError, json.JSONDecodeError) as exc:
            raise ServiceError('unreadable_media', '无法探测录像，文件可能损坏或格式不受支持') from exc
        streams = probe.get('streams', [])
        video = next((s for s in streams if s.get('codec_type') == 'video'
                      and not s.get('disposition', {}).get('attached_pic')), None)
        if video is None:
            raise ServiceError('not_video', '文件没有可用视频流，请选择录像')
        audio_streams = [s for s in streams if s.get('codec_type') == 'audio'
                         and s.get('codec_name') not in (None, '', 'unknown')
                         and isinstance(s.get('channels'), int) and s['channels'] > 0
                         and str(s.get('sample_rate', '')).isdigit() and int(s['sample_rate']) > 0]
        if not audio_streams:
            raise ServiceError('no_audio', '录像没有可用音轨，无法进行枪声分析')
        video_start = _time(video.get('start_time'))
        # Some containers omit stream duration. Read packet timestamps, without
        # decoding images; format duration can include a nonzero PTS origin.
        duration = video.get('duration')
        if duration is None:
            with tempfile.TemporaryFile() as packets:
                subprocess.run([
                    self.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
                    '-select_streams', str(video['index']),
                    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0',
                    str(path),
                ], stdout=packets, stderr=subprocess.PIPE, check=True, timeout=60)
                packets.seek(0)
                end = video_start
                for line in packets:
                    pts, length = line.decode().strip().split(',')[:2]
                    end = max(end, _time(pts) + _time(length))
                duration = end - video_start
        duration = _time(duration)
        if duration <= 0:
            raise ServiceError('unreadable_media', '无法确定录像的有效时长')
        try:
            verified_identity = file_identity(path)
        except OSError as exc:
            raise ServiceError('source_changed', '源录像在探测期间变化或不可用，请重新探测', 409) from exc
        if verified_identity != source_identity:
            raise ServiceError('source_changed', '源录像在媒体探测期间变化，不能保存旧媒体信息，请重新探测', 409)
        media = {
            'schema_version': 1, 'media_id': uuid.uuid4().hex,
            'source': {'path': str(path), **source_identity}, 'duration_s': float(duration),
            'video': {'stream_index': video['index'], 'codec': video['codec_name'],
                      'width': video['width'], 'height': video['height'],
                      'start_time_s': video_start},
            'audio_tracks': [
                {'stream_index': s['index'], 'codec': s['codec_name'],
                 'channels': s['channels'], 'sample_rate': int(s['sample_rate']),
                 'title': s.get('tags', {}).get('title', ''),
                 'language': s.get('tags', {}).get('language', 'und'),
                 'start_time_s': _time(s.get('start_time'))}
                for s in audio_streams
            ],
            'selected_audio': None,
        }
        self.save_media(media)
        return media
