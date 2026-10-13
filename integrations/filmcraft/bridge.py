#!/usr/bin/env python3
"""FilmCraft's one-request NDJSON adapter for the existing local model service."""
from contextlib import redirect_stdout
from dataclasses import dataclass
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import threading
import time
import zipfile

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from model_identity import configuration_identity
from model_runtime import parent_alive
from model_service import ModelService, ServiceError


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Cancelled(BridgeError):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise BridgeError('invalid_request', message)

    def print_help(self, file=None):
        super().print_help(file or sys.stderr)


@dataclass(frozen=True)
class Configuration:
    data_dir: Path
    ffmpeg: str
    ffprobe: str
    model_workspace: Path | None = None
    checkpoint: Path | None = None
    engine_python: str | None = None

    def service_arguments(self):
        return dict(data_dir=self.data_dir, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe,
                    model_workspace=self.model_workspace, checkpoint=self.checkpoint,
                    engine_python=self.engine_python)


def executable(value, variable):
    resolved = shutil.which(os.path.expanduser(value))
    if not resolved:
        raise BridgeError('runtime_unavailable', f'{variable} 指定的程序不存在或不可执行：{value}')
    return resolved


def configuration(env, *, analyze):
    ffmpeg = executable(env.get('APEX_FFMPEG') or 'ffmpeg', 'APEX_FFMPEG')
    ffprobe = executable(env.get('APEX_FFPROBE') or 'ffprobe', 'APEX_FFPROBE')
    data_dir = Path(env.get('APEX_AI_DATA_DIR') or REPO / 'outputs/filmcraft-ai-prototype/model-data').expanduser().resolve()
    if not analyze:
        return Configuration(data_dir, ffmpeg, ffprobe)
    workspace = Path(env.get('APEX_MODEL_WORKSPACE') or REPO.parent / 'apex-voice-detect').expanduser().resolve()
    checkpoint = Path(env.get('APEX_CHECKPOINT') or workspace / 'checkpoints/BEATs_strong_1.pt').expanduser().resolve()
    for path, label in ((workspace / 'scripts/infer_apex_audio.py', '模型加载入口'),
                        (workspace / 'PretrainedSED', 'PretrainedSED 模型代码'),
                        (checkpoint, 'BEATs 权重')):
        if not path.exists():
            raise BridgeError('model_runtime_unavailable', f'{label}不存在：{path}')
    if not checkpoint.is_file() or checkpoint.name != 'BEATs_strong_1.pt':
        raise BridgeError('model_runtime_unavailable', '现有引擎需要文件名为 BEATs_strong_1.pt 的本地权重')
    engine = executable(env.get('APEX_ENGINE_PYTHON') or str(workspace / '.venv-pretrainedsed/bin/python'),
                        'APEX_ENGINE_PYTHON')
    return Configuration(data_dir, ffmpeg, ffprobe, workspace, checkpoint, engine)


def require_core_runtime():
    if importlib.util.find_spec('numpy') is None:
        raise BridgeError('core_runtime_unavailable',
                          '当前桥接 Python 缺少 NumPy；请用现有模型 Python 环境启动 bridge.py')


def read_json(path):
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)


def cached_result(service, media, model_configuration, check_cancelled=lambda: None):
    """Only completed tasks in this service directory may supply a cache entry.

    The current probe has already measured source identity and confirmed audio.
    Cache keys are never trusted as validation: compare the actual identity and
    configuration fields, require persisted prediction files, and ask the core
    to revalidate its original media record before publishing the result.
    """
    tasks = sorted(service.tasks_dir.glob('*.json'), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for path in tasks:
        check_cancelled()
        try:
            if path.is_symlink():
                continue
            task = read_json(path)
            if task.get('kind') != 'analysis' or task.get('status') != 'completed':
                continue
            completed = [r for r in task.get('results', []) if r.get('status') == 'completed']
            for entry in completed:
                identifier = entry.get('result_id')
                if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{32}', identifier):
                    continue
                folder = service.results_dir / identifier
                if folder.is_symlink() or (folder / 'result.json').is_symlink():
                    continue
                result = service.execute('get_result', {'result_id': identifier})
                prediction = result.get('prediction', {})
                original = result.get('media', {})
                if (result.get('result_id') != identifier or result.get('prediction_id') != identifier
                        or entry.get('media_id') != original.get('media_id')
                        or original.get('source') != media['source']
                        or original.get('selected_audio') != media['selected_audio']
                        or prediction.get('configuration') != model_configuration):
                    continue
                scores = folder / 'scores.npz'
                metadata = folder / 'prediction.json'
                if (Path(prediction.get('scores_path', '')).resolve() != scores.resolve()
                        or Path(prediction.get('metadata_path', '')).resolve() != metadata.resolve()
                        or scores.resolve().parent != folder.resolve()
                        or metadata.resolve().parent != folder.resolve()
                        or not scores.is_file() or scores.stat().st_size == 0):
                    continue
                with zipfile.ZipFile(scores) as archive:
                    required = {'probabilities.npy', 'class_names.npy', 'frame_onsets.npy',
                                'frame_offsets.npy', 'window_counts.npy'}
                    if not required.issubset(archive.namelist()) or archive.testzip() is not None:
                        continue
                saved_prediction = read_json(metadata)
                if (saved_prediction.get('prediction_id') != identifier
                        or saved_prediction.get('media') != original
                        or saved_prediction.get('configuration') != model_configuration):
                    continue
                service.validate_result(result)
                check_cancelled()
                return result
        except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile, ServiceError) as exc:
            print(f'忽略不可复用的分析记录 {path.name}: {exc}', file=sys.stderr)
    return None


STAGES = {
    'starting': '准备分析', 'extracting_audio': '提取已选音轨',
    'model_loading': '加载本地模型', 'inference': '分析游戏声音',
    'postprocessing': '生成枪声候选', 'completed': '分析完成',
    'cancelling': '正在取消', 'cancelled': '分析已取消', 'failed': '分析失败',
}


def task_progress(task):
    value = task.get('progress')
    if type(value) not in (int, float) or not math.isfinite(value):
        value = None
    elif value is not None:
        value = min(1.0, max(0.0, value))
    stage = task.get('stage') or task.get('status') or 'starting'
    return {'type': 'progress', 'stage': stage, 'message': STAGES.get(stage, '分析进行中'), 'progress': value}


def analyze(service, source, audio_stream, emit, *, check_cancelled=lambda: None,
            wait=time.sleep, core_runtime_check=require_core_runtime):
    emit({'type': 'progress', 'stage': 'validating', 'message': '检查录像、音轨与模型配置', 'progress': None})
    media = service.execute('probe_media', {'path': str(source)})
    check_cancelled()
    media = service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': audio_stream})
    model_configuration = configuration_identity(service.model_workspace, service.checkpoint, check_cancelled)
    check_cancelled()
    emit({'type': 'progress', 'stage': 'cache_lookup', 'message': '检查可复用的完整分析记录', 'progress': None})
    result = cached_result(service, media, model_configuration, check_cancelled)
    if result is not None:
        core_runtime_check()
        emit({'type': 'progress', 'stage': 'cache_rebuild', 'message': '根据已保存预测生成默认 AI 候选', 'progress': None})
        original = result
        result = service.build_result({'task_id': original['result_id']}, original['media'],
                                      service.results_dir / original['result_id'], original['prediction'])
        # These candidates are deliberately not persisted over the old result:
        # the native app saves this complete response beside its new AI draft.
        result['source_result_id'] = original['result_id']
        result['source_candidate_version'] = original['candidate_version']
        if 'analysis' in original:
            result['analysis'] = original['analysis']
        check_cancelled()
        emit({'type': 'progress', 'stage': 'completed', 'message': '已复用验证通过的分析结果', 'progress': 1.0})
        emit({'type': 'result', 'result': result, 'cached': True})
        return
    core_runtime_check()
    check_cancelled()
    submitted = service.execute('analyze', {'media_id': media['media_id']})
    previous = None
    while True:
        check_cancelled()
        task = service.execute('get_task', {'task_id': submitted['task_id']})
        progress = task_progress(task)
        if progress != previous:
            emit(progress)
            previous = progress
        status = task.get('status')
        if status == 'completed':
            identifier = task.get('result_id')
            if not identifier:
                raise BridgeError('invalid_core_response', '分析任务完成但未提供结果标识')
            result = service.execute('get_result', {'result_id': identifier})
            service.validate_result(result)
            check_cancelled()
            emit({'type': 'result', 'result': result, 'cached': False})
            return
        if status in ('failed', 'cancelled'):
            error = task.get('error') or {}
            raise BridgeError(error.get('code') or 'analysis_failed', error.get('message') or STAGES[status])
        if status not in ('running', 'cancelling'):
            raise BridgeError('invalid_core_response', f'未知任务状态：{status}')
        wait(.2)


class ParentGuard:
    """Interrupt the main thread so its finally block closes the shared core."""
    def __init__(self, parent_pid):
        self.parent_pid = parent_pid
        self.done = threading.Event()
        self.reason = None
        self.thread = None
        self.handlers = {}

    def check(self):
        if self.reason:
            raise Cancelled(self.reason, '应用已退出，分析已中断' if self.reason == 'service_interrupted' else '分析已取消')

    def signal(self, signum, frame):
        self.reason = self.reason or 'task_cancelled'
        self.check()

    def __enter__(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            self.handlers[number] = signal.signal(number, self.signal)
        def watch():
            while not self.done.wait(.2):
                if not parent_alive(self.parent_pid) or (os.name != 'nt' and os.getppid() != self.parent_pid):
                    self.reason = 'service_interrupted'
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
        self.thread = threading.Thread(target=watch, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exception):
        self.done.set()
        if self.thread:
            self.thread.join(timeout=1)
        for number, handler in self.handlers.items():
            signal.signal(number, handler)


def parser():
    root = Parser(description=__doc__)
    commands = root.add_subparsers(dest='command', required=True, parser_class=Parser)
    for name in ('probe', 'analyze'):
        command = commands.add_parser(name)
        command.add_argument('--input', required=True)
        command.add_argument('--parent-pid', type=int, default=os.getppid())
        if name == 'analyze':
            command.add_argument('--audio-stream', required=True, type=int)
    return root


def main(argv=None, *, service_factory=ModelService, env=None, output=None):
    output = output or sys.stdout
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    def emit(event):
        output.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + '\n')
        output.flush()
    service, guard, failure = None, None, None
    try:
        args = parser().parse_args(argv)
        source = Path(args.input).expanduser()
        if not source.is_absolute() or not source.is_file():
            raise BridgeError('invalid_path', '--input 必须是存在的本地录像绝对路径')
        if args.parent_pid <= 0 or args.parent_pid == os.getpid():
            raise BridgeError('invalid_request', '--parent-pid 必须指向宿主进程')
        config = configuration(os.environ if env is None else env, analyze=args.command == 'analyze')
        with ParentGuard(args.parent_pid) as guard:
            try:
                with redirect_stdout(sys.stderr):
                    service = service_factory(**config.service_arguments())
                    if service.read_only:
                        raise BridgeError('data_dir_locked', 'AI 数据目录已由另一个分析任务使用')
                    if args.command == 'probe':
                        media = service.execute('probe_media', {'path': str(source.resolve())})
                        guard.check()
                        emit({'type': 'media', 'media': media})
                    else:
                        analyze(service, source.resolve(), args.audio_stream, emit, check_cancelled=guard.check)
            finally:
                # Do not permit a second TERM to interrupt core cleanup.
                guard.done.set()
                for number in (signal.SIGTERM, signal.SIGINT):
                    signal.signal(number, signal.SIG_IGN)
                if service is not None:
                    with redirect_stdout(sys.stderr):
                        service.close(interrupted=guard.reason == 'service_interrupted')
        return 0
    except (BridgeError, ServiceError) as exc:
        failure = {'type': 'error', 'code': exc.code, 'message': str(exc)}
    except BrokenPipeError:
        return 1
    except Exception as exc:
        failure = {'type': 'error', 'code': 'bridge_failed', 'message': str(exc)}
    try:
        emit(failure)
    except BrokenPipeError:
        pass
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
