#!/usr/bin/env python3
"""Real-recording acceptance through the public HTTP and NDJSON operations.

This records machine evidence. Human content, boundary and sync review always
remains required; passing this script does not complete Issue #16.
"""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

import numpy as np

REPOSITORY = Path(__file__).resolve().parents[1]
TOLERANCE = 1e-6


class ValidationFailure(Exception):
    pass


class OperationFailure(ValidationFailure):
    def __init__(self, operation, error):
        super().__init__(f"{operation}: {error.get('code')}: {error.get('message')}")
        self.operation = operation
        self.error = error


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def require(condition, message):
    if not condition:
        raise ValidationFailure(message)


class Lines:
    def __init__(self, stream):
        self.items = queue.Queue()

        def read():
            for line in stream:
                self.items.put(line)
            self.items.put(None)

        self.thread = threading.Thread(target=read, daemon=True)
        self.thread.start()

    def next(self, timeout):
        try:
            value = self.items.get(timeout=timeout)
        except queue.Empty as exc:
            raise ValidationFailure('服务未在指定时间内返回消息') from exc
        require(value is not None, '服务提前退出，请检查 adapter-stderr.log')
        return value


class Adapter:
    def __init__(self, name, folder, arguments):
        self.name, self.folder, self.arguments = name, folder, arguments
        folder.mkdir(parents=True)
        self.error_log = (folder / 'adapter-stderr.log').open('w', encoding='utf-8')
        entry = 'model_web.py' if name == 'http' else 'model_ipc.py'
        command = [arguments.service_python, '-u', str(REPOSITORY / entry),
                   '--data-dir', str(folder / 'data'), '--ffmpeg', arguments.ffmpeg,
                   '--ffprobe', arguments.ffprobe, '--model-workspace', str(arguments.model_workspace),
                   '--checkpoint', str(arguments.checkpoint), '--engine-python', arguments.engine_python]
        if name == 'http':
            command += ['--port', '0']
        self.process = subprocess.Popen(command, cwd=REPOSITORY, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.error_log, text=True, bufsize=1)
        self.lines = Lines(self.process.stdout)
        self.closed = False
        try:
            if name == 'http':
                line = self.lines.next(arguments.timeout_s).strip()
                require(line.startswith('Python Web: '), f'HTTP 启动消息无效: {line}')
                url = urlsplit(line.removeprefix('Python Web: '))
                self.port = url.port
                self.token = parse_qs(url.fragment).get('token', [''])[0]
                require(self.token and self.port, 'HTTP 未提供访问令牌或端口')
            else:
                ready = json.loads(self.lines.next(arguments.timeout_s))
                require(ready == {'type': 'ready', 'schema_version': 1}, f'IPC 未提供 schema 1 ready: {ready}')
        except Exception:
            self.close()
            raise
        save(folder / 'entry.json', {'adapter': name, 'command': command,
            'transport': 'HTTP loopback' if name == 'http' else 'NDJSON stdio',
            'data_dir': str(folder / 'data')})

    def execute(self, operation, payload):
        if self.name == 'ipc':
            identifier = uuid.uuid4().hex
            self.process.stdin.write(json.dumps({'id': identifier, 'operation': operation,
                'payload': payload}, ensure_ascii=False, allow_nan=False) + '\n')
            self.process.stdin.flush()
            response = json.loads(self.lines.next(self.arguments.timeout_s))
            require(response.get('type') == 'response' and response.get('id') == identifier,
                    f'IPC 响应标识不匹配: {response}')
            if 'error' in response:
                raise OperationFailure(operation, response['error'])
            return response['result']
        posts = {'probe_media': '/api/probe', 'confirm_audio': '/api/confirm-audio',
            'analyze': '/api/analyze', 'recompute_candidates': '/api/recompute-candidates',
            'update_selection': '/api/update-selection', 'request_preview': '/api/preview',
            'export': '/api/export', 'cancel_task': '/api/cancel'}
        if operation in posts:
            method, path, body = 'POST', posts[operation], json.dumps(
                payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        else:
            method, body = 'GET', None
            if operation == 'get_config':
                path = '/api/config'
            elif operation == 'read_scores':
                path = '/api/scores/' + payload['prediction_id'] + '?' + urlencode({
                    'start_s': payload['start_s'], 'end_s': payload['end_s']})
            else:
                routes = {'get_task': ('tasks', 'task_id'), 'get_result': ('results', 'result_id'),
                          'get_media': ('media', 'media_id'), 'get_artifact': ('artifacts', 'artifact_id')}
                directory, key = routes[operation]
                path = f'/api/{directory}/{payload[key]}'
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=self.arguments.timeout_s)
        try:
            connection.request(method, path, body=body, headers={
                'Content-Type': 'application/json', 'X-Apex-Token': self.token})
            response = connection.getresponse()
            result = json.loads(response.read())
            if response.status >= 400:
                raise OperationFailure(operation, {**result['error'], 'status': response.status})
            return result
        finally:
            connection.close()

    def wait(self, submitted, label, *, allow_failure=False):
        deadline = time.monotonic() + self.arguments.timeout_s
        previous = None
        with (self.folder / f'{label}-progress.jsonl').open('w', encoding='utf-8') as history:
            while time.monotonic() < deadline:
                task = self.execute('get_task', {'task_id': submitted['task_id']})
                current = (task['status'], task['stage'], task.get('progress'), task.get('current_index'))
                if current != previous:
                    history.write(json.dumps(task, ensure_ascii=False, allow_nan=False) + '\n')
                    history.flush()
                    previous = current
                if task['status'] not in ('running', 'cancelling'):
                    save(self.folder / f'{label}-task.json', task)
                    if not allow_failure:
                        require(task['status'] == 'completed', f"{self.name} {label} 未完成: {task.get('error')}")
                    return task
                time.sleep(.2)
        raise ValidationFailure(f'{self.name} {label} 超时；停止服务后未完成任务将取消')

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process.poll() is None:
            if self.name == 'ipc':
                try:
                    self.process.stdin.close()
                except BrokenPipeError:
                    pass
            elif os.name != 'nt':
                self.process.send_signal(signal.SIGINT)
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if not self.process.stdin.closed:
            self.process.stdin.close()
        self.process.stdout.close()
        self.error_log.close()


def inspect_output(adapter, artifact, label, arguments):
    path = Path(artifact['path'])
    probe = subprocess.run([arguments.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_format', '-show_streams', '-of', 'json', str(path)], capture_output=True, text=True)
    save(adapter.folder / f'{label}-probe.json', {'path': str(path), 'returncode': probe.returncode,
        'probe': json.loads(probe.stdout) if probe.returncode == 0 else None, 'stderr': probe.stderr})
    require(probe.returncode == 0, f'{label} 无法探测: {probe.stderr}')
    command = [arguments.ffmpeg, '-nostdin', '-v', 'error', '-xerror',
        '-protocol_whitelist', 'file,pipe', '-i', str(path), '-map', '0:v:0',
        '-map', '0:a:0', '-f', 'null', '-']
    started = time.perf_counter()
    log_path = adapter.folder / f'{label}-full-decode.log'
    with log_path.open('wb') as log:
        decoded = subprocess.run(command, stdout=log, stderr=log)
    evidence = {'artifact_id': artifact['artifact_id'], 'path': str(path), 'command': command,
        'returncode': decoded.returncode, 'elapsed_s': time.perf_counter() - started,
        'log': str(log_path), 'scope': 'all video and selected output audio, complete file'}
    save(adapter.folder / f'{label}-decode.json', evidence)
    require(decoded.returncode == 0, f'{label} 全量解码失败: {log_path}')
    return evidence


def run_entry(adapter, arguments):
    config = adapter.execute('get_config', {})
    save(adapter.folder / 'configuration.json', config)
    media = []
    for position, (source, stream) in enumerate(zip(arguments.source, arguments.audio_stream), 1):
        probed = adapter.execute('probe_media', {'path': str(source)})
        save(adapter.folder / f'{position:03d}-probe.json', probed)
        require(any(track['stream_index'] == stream for track in probed['audio_tracks']),
                f'{source} 没有显式指定的音轨 #{stream}，不会默认选择第一轨')
        confirmed = adapter.execute('confirm_audio', {'media_id': probed['media_id'], 'stream_index': stream})
        save(adapter.folder / f'{position:03d}-confirmed.json', confirmed)
        media.append(confirmed)
    batch = adapter.wait(adapter.execute('analyze', {'media_ids': [item['media_id'] for item in media]}), 'batch')
    require(len(batch['results']) == len(media) and all(item['status'] == 'completed' for item in batch['results']),
            f'{adapter.name} 批量包含失败录像，请查看 batch-task.json')
    baseline = []
    for position, item in enumerate(batch['results'], 1):
        result = adapter.execute('get_result', {'result_id': item['result_id']})
        save(adapter.folder / f'{position:03d}-analysis.json', result)
        baseline.append(result)
    warm_task = adapter.wait(adapter.execute('analyze', {'media_id': media[0]['media_id']}), 'warm')
    warm = adapter.execute('get_result', {'result_id': warm_task['result_id']})
    save(adapter.folder / 'warm-result.json', warm)
    runtime = [result['prediction']['runtime'] for result in [*baseline, warm]]
    require(all(item.get('reported_by') == 'engine' and item.get('load_count') == 1 for item in runtime),
            f'{adapter.name} 缺少真实引擎加载证据；不能用夹具或耗时推断复用')
    require(len({item['engine_instance_id'] for item in runtime}) == 1
            and [item['inference_index'] for item in runtime] == list(range(1, len(runtime) + 1))
            and [item['model_reused'] for item in runtime] == [False, *([True] * (len(runtime) - 1))],
            f'{adapter.name} 批量和后续任务未复用同一引擎')
    results, outputs = [], []
    for position, result in enumerate(baseline, 1):
        prefix = f'{position:03d}'
        parameters = {key: result['parameters'][key] for key in ('threshold', 'merge_gap_s', 'before_s', 'after_s')}
        updated = adapter.execute('recompute_candidates', {'result_id': result['result_id'],
            'candidate_version': result['candidate_version'], 'parameters': parameters})
        require(updated['candidate_version'] != result['candidate_version']
                and updated['prediction'] == result['prediction'], '重算必须换候选版本并完整保留预测')
        save(adapter.folder / f'{prefix}-recomputed.json', updated)
        clips = []
        for candidate in updated['candidates']:
            start, end = candidate['start_s'], candidate['end_s']
            trim = arguments.trim_s if end - start > 2 * arguments.trim_s else 0
            clips.append({'candidate_id': candidate['candidate_id'], 'selected': True,
                          'start_s': start + trim, 'end_s': end - trim})
        selected = adapter.execute('update_selection', {'result_id': updated['result_id'],
            'candidate_version': updated['candidate_version'], 'clips': clips})
        save(adapter.folder / f'{prefix}-selection.json', selected)
        previewed = []
        limit = len(clips) if arguments.preview_all else arguments.preview_limit
        for index, clip in enumerate(clips[:limit], 1):
            label = f'{prefix}-preview-{index:03d}'
            task = adapter.wait(adapter.execute('request_preview', {'result_id': selected['result_id'],
                'candidate_version': selected['candidate_version'], 'candidate_id': clip['candidate_id']}), label)
            artifact = adapter.execute('get_artifact', {'artifact_id': task['preview_id']})
            require(artifact['requested_range'] == {key: clip[key] for key in ('start_s', 'end_s')},
                    '预览引用没有保留已保存的请求范围')
            save(adapter.folder / f'{label}-artifact.json', artifact)
            previewed.append(artifact)
            outputs.append(inspect_output(adapter, artifact, label, arguments))
        exported = []
        if clips:
            task = adapter.wait(adapter.execute('export', {'result_id': selected['result_id'],
                'candidate_version': selected['candidate_version'], 'output_dir': str(adapter.folder / 'exports'),
                'mode': 'copy'}), f'{prefix}-export', allow_failure=True)
            for index, item in enumerate(task['exports'], 1):
                if item['status'] != 'completed':
                    continue
                artifact = adapter.execute('get_artifact', {'artifact_id': item['artifact_id']})
                require(artifact['status'] == 'completed' and artifact['mode'] == 'copy', '导出不能静默重编码')
                require(artifact['requested_range'] == {key: clips[index - 1][key] for key in ('start_s', 'end_s')},
                        '独立导出没有保留所选候选的请求范围')
                label = f'{prefix}-export-{index:03d}'
                save(adapter.folder / f'{label}-artifact.json', artifact)
                exported.append(artifact)
                outputs.append(inspect_output(adapter, artifact, label, arguments))
            require(task['status'] == 'completed', f"{adapter.name} 导出未完成；已完成输出解码已保留: {task.get('error')}")
            require(len(task['exports']) == len(clips), '所选候选必须分别生成输出，不拼接或丢弃')
        else:
            save(adapter.folder / f'{prefix}-no-candidates.json', {
                'prediction_preserved': True, 'preview': 'not_requested', 'export': 'not_requested',
                'reason': '没有候选，不伪造输出成功'})
        results.append({'baseline': result, 'selected': selected, 'previews': previewed, 'exports': exported})
    evidence = {'adapter': adapter.name, 'batch_task_id': batch['task_id'], 'warm_task_id': warm_task['task_id'],
        'runtime': runtime, 'batch_records': batch['results'], 'warm_analysis': warm['analysis'],
        'output_count': len(outputs), 'full_decode': outputs}
    save(adapter.folder / 'evidence.json', evidence)
    return {'media': media, 'results': results, 'evidence': evidence}


def compare_numbers(left, right, label):
    first, second = np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)
    require(first.shape == second.shape, f'{label} 维度不同: {first.shape} / {second.shape}')
    difference = float(np.max(np.abs(first - second))) if first.size else 0.0
    require(np.isfinite(first).all() and np.isfinite(second).all()
            and difference <= TOLERANCE, f'{label} 超出绝对容差 {TOLERANCE}: {difference}')
    return difference


def candidate_values(result):
    return [[candidate[key] for key in ('event_start_s', 'event_end_s', 'start_s', 'end_s')]
            for candidate in result['candidates']]


def compare_entries(http, ipc, first, second, report_folder):
    comparisons = []
    with (report_folder / 'score-pages.jsonl').open('w', encoding='utf-8') as pages:
        for position, (left, right) in enumerate(zip(first['results'], second['results']), 1):
            media_a, media_b = first['media'][position - 1], second['media'][position - 1]
            require({key: value for key, value in media_a.items() if key != 'media_id'}
                    == {key: value for key, value in media_b.items() if key != 'media_id'},
                    f'录像 {position} 的探测、显式音轨或时间原点不一致')
            original_a, original_b = left['baseline'], right['baseline']
            prediction_a, prediction_b = original_a['prediction'], original_b['prediction']
            require(prediction_a['classes'] == prediction_b['classes'], f'录像 {position} 类别顺序不一致')
            require(prediction_a['configuration'] == prediction_b['configuration'], f'录像 {position} 模型配置不一致')
            require(prediction_a['frame_count'] == prediction_b['frame_count'], f'录像 {position} 原始帧数不一致')
            compare_numbers([prediction_a[key] for key in ('valid_duration_s', 'frame_step_s', 'audio_to_video_offset_s')],
                            [prediction_b[key] for key in ('valid_duration_s', 'frame_step_s', 'audio_to_video_offset_s')],
                            f'录像 {position} 预测时间元数据')
            require([event['classes'] for event in original_a['events']]
                    == [event['classes'] for event in original_b['events']], f'录像 {position} 事件类别不一致')
            compare_numbers([[event['start_s'], event['end_s']] for event in original_a['events']],
                            [[event['start_s'], event['end_s']] for event in original_b['events']],
                            f'录像 {position} 事件范围')
            for name in ('baseline', 'selected'):
                require(left[name]['parameters'] == right[name]['parameters'], f'录像 {position} {name} 后处理参数不一致')
                compare_numbers(candidate_values(left[name]), candidate_values(right[name]), f'录像 {position} {name} 候选')
            require([selection['selected'] for selection in left['selected']['selection']]
                    == [selection['selected'] for selection in right['selected']['selection']], '选中状态不一致')
            compare_numbers([[item['start_s'], item['end_s']] for item in left['selected']['selection']],
                            [[item['start_s'], item['end_s']] for item in right['selected']['selection']], '请求导出范围')
            require(len(left['exports']) == len(right['exports']), '两入口独立输出数量不一致')
            for index, (export_a, export_b) in enumerate(zip(left['exports'], right['exports']), 1):
                compare_numbers([export_a['actual_range'][key] for key in ('start_s', 'end_s')],
                                [export_b['actual_range'][key] for key in ('start_s', 'end_s')],
                                f'录像 {position} 导出 {index} 实际范围')
            start, end, count, maximum = 0.0, media_a['duration_s'], 0, 0.0
            while start < end:
                page_a = http.execute('read_scores', {'prediction_id': original_a['prediction_id'], 'start_s': start, 'end_s': end})
                page_b = ipc.execute('read_scores', {'prediction_id': original_b['prediction_id'], 'start_s': start, 'end_s': end})
                require(page_a['classes'] == page_b['classes'] == prediction_a['classes'], '分数分页类别顺序不一致')
                time_error = max(compare_numbers(page_a['frame_onsets_s'], page_b['frame_onsets_s'], '真实映射帧起点'),
                                 compare_numbers(page_a['frame_offsets_s'], page_b['frame_offsets_s'], '真实映射帧终点'))
                error = compare_numbers(page_a['scores'], page_b['scores'], '原始分数')
                require(len(page_a['scores']) <= 1000, '分数读取超过公共分页大小')
                require(page_a['next_start_s'] == page_b['next_start_s'], '分数分页引用不一致')
                count += len(page_a['scores'])
                maximum = max(maximum, error)
                pages.write(json.dumps({'recording': position, 'start_s': start, 'end_s': end,
                    'frame_count': len(page_a['scores']), 'max_abs_score_difference': error,
                    'max_abs_time_difference_s': time_error, 'atol': TOLERANCE, 'rtol': 0,
                    'http_scores_float32_sha256': hashlib.sha256(np.asarray(page_a['scores'], dtype=np.float32).tobytes()).hexdigest(),
                    'ipc_scores_float32_sha256': hashlib.sha256(np.asarray(page_b['scores'], dtype=np.float32).tobytes()).hexdigest()},
                    ensure_ascii=False, allow_nan=False) + '\n')
                pages.flush()
                next_start = page_a['next_start_s']
                if next_start is None:
                    break
                require(start < next_start < end, '分数分页没有向前推进')
                start = next_start
                del page_a, page_b
            comparisons.append({'recording': position, 'classes': len(prediction_a['classes']),
                'raw_frame_count': prediction_a['frame_count'], 'compared_frame_count': count,
                'range_s': [0, end], 'max_abs_score_difference': maximum,
                'atol': TOLERANCE, 'rtol': 0, 'baseline_candidate_count': len(original_a['candidates']),
                'export_count': len(left['exports']), 'status': 'passed',
                'scope': 'all public score frames intersecting the original video timeline; full NPZ references retained'})
    save(report_folder / 'parity.json', comparisons)
    return comparisons


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, action='append', required=True, help='每份真实录像各给一次，可重复')
    parser.add_argument('--audio-stream', type=int, action='append', required=True,
                        help='按 source 顺序逐份明确给出容器音轨索引；不默认第一轨')
    parser.add_argument('--model-workspace', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--service-python', default=sys.executable)
    parser.add_argument('--engine-python', default=sys.executable)
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    parser.add_argument('--output-dir', type=Path, default=Path('outputs/issue16-validation'))
    parser.add_argument('--timeout-s', type=float, default=7200)
    parser.add_argument('--preview-limit', type=int, default=1, help='每份录像按需预览前 N 个候选，默认 1')
    parser.add_argument('--preview-all', action='store_true', help='为全部候选生成并解码预览')
    parser.add_argument('--trim-s', type=float, default=.04, help='验证选择编辑：首尾各缩小这些秒，默认 .04；0 保留自动范围')
    arguments = parser.parse_args()
    if len(arguments.source) != len(arguments.audio_stream):
        parser.error('每个 --source 必须有按顺序对应的 --audio-stream')
    if any(index < 0 for index in arguments.audio_stream):
        parser.error('音轨索引必须为非负容器流索引')
    for name in ('ffmpeg', 'ffprobe', 'service_python', 'engine_python'):
        executable = shutil.which(str(getattr(arguments, name))) if getattr(arguments, name) else None
        if not executable:
            parser.error(f'找不到可执行文件 {name}')
        setattr(arguments, name, executable)
    arguments.source = [source.expanduser().resolve() for source in arguments.source]
    if any(not source.is_file() for source in arguments.source):
        parser.error('每份 source 都必须是存在的本地文件')
    arguments.model_workspace = arguments.model_workspace.expanduser().resolve()
    arguments.checkpoint = (arguments.checkpoint or arguments.model_workspace / 'checkpoints/BEATs_strong_1.pt').expanduser().resolve()
    if not arguments.model_workspace.is_dir() or not arguments.checkpoint.is_file():
        parser.error('需要存在的模型工作目录和本地权重')
    if (not math.isfinite(arguments.timeout_s) or arguments.timeout_s <= 0
            or not math.isfinite(arguments.trim_s) or arguments.trim_s < 0 or arguments.preview_limit < 1):
        parser.error('timeout 必须为有限正数，trim 为有限非负数，preview-limit 至少为 1')
    arguments.output_dir = arguments.output_dir.expanduser().resolve()
    return arguments


def main():
    arguments = options()
    started = time.perf_counter()
    timestamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d_%H-%M-%S')
    folder = arguments.output_dir / f'{timestamp}-{uuid.uuid4().hex[:8]}'
    folder.mkdir(parents=True)
    report = {'schema_version': 1, 'recorded_at': datetime.now(timezone(timedelta(hours=8))).isoformat(),
        'platform': platform.platform(), 'machine': platform.machine(), 'python': sys.version,
        'cpu_count': os.cpu_count(), 'sources': [str(source) for source in arguments.source],
        'explicit_audio_streams': arguments.audio_stream, 'output_dir': str(folder),
        'parameters': {'preview_limit': arguments.preview_limit, 'preview_all': arguments.preview_all,
                       'scripted_range_trim_s': arguments.trim_s, 'scores_atol': TOLERANCE, 'scores_rtol': 0},
        'technical_status': 'running', 'issue16_complete': False,
        'manual_review': {'status': 'required', 'confirmed': False, 'items': [
            'preview and exported content', 'requested versus measured actual boundaries',
            'original video timeline mapping', 'perceptual audio/video sync',
            'actual Electron playback and both user-facing entries']},
        'clean_machine_acceptance': {'status': 'not_evaluated', 'confirmed': False},
        'scope': 'real local BEATs, HTTP and NDJSON IPC; source-level evidence, not clean-machine or recognition-quality acceptance'}
    save(folder / 'report.json', report)
    adapters = []
    try:
        for tool in ('ffmpeg', 'ffprobe'):
            version = subprocess.run([getattr(arguments, tool), '-version'], capture_output=True, text=True, check=True)
            (folder / f'{tool}-version.txt').write_text(version.stdout + version.stderr, encoding='utf-8')
        for name in ('http', 'ipc'):
            adapter = Adapter(name, folder / name, arguments)
            adapters.append(adapter)
            evidence = run_entry(adapter, arguments)
            report[name] = evidence['evidence']
            report.setdefault('dimensions', [
                [media['video']['width'], media['video']['height']] for media in evidence['media']])
            if name == 'http':
                first = evidence
            else:
                second = evidence
            save(folder / 'report.json', report)
        report['parity'] = compare_entries(adapters[0], adapters[1], first, second, folder)
        report['resolution_coverage'] = {'1080p': [1920, 1080] in report['dimensions'],
                                       '4k': any(size in ([3840, 2160], [4096, 2160]) for size in report['dimensions'])}
        report['technical_status'] = 'passed'
    except KeyboardInterrupt:
        report['technical_status'] = 'cancelled'
        report['error'] = {'type': 'KeyboardInterrupt', 'message': '验收已中断，已完成证据保留，服务将停止'}
    except Exception as exc:
        report['technical_status'] = 'failed'
        report['error'] = {'type': type(exc).__name__, 'message': str(exc)}
        if isinstance(exc, OperationFailure):
            report['error'].update(operation=exc.operation, service_error=exc.error)
    finally:
        for adapter in reversed(adapters):
            try:
                adapter.close()
            except Exception as exc:
                report.setdefault('cleanup_errors', []).append({'adapter': adapter.name, 'message': str(exc)})
                report['technical_status'] = 'failed'
        report['elapsed_s'] = time.perf_counter() - started
        try:
            import resource
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            report['child_resource_observation'] = {'user_cpu_s': usage.ru_utime, 'system_cpu_s': usage.ru_stime,
                'max_rss': usage.ru_maxrss, 'max_rss_unit': 'bytes' if sys.platform == 'darwin' else 'KiB',
                'scope': 'aggregate reaped child processes; not per-stage peak or a device budget'}
        except ImportError:
            report['child_resource_observation'] = {'status': 'unavailable'}
        save(folder / 'report.json', report)
    print(json.dumps({'technical_status': report['technical_status'], 'report': str(folder / 'report.json'),
        'manual_review': 'required', 'issue16_complete': False}, ensure_ascii=False))
    return 0 if report['technical_status'] == 'passed' else 130 if report['technical_status'] == 'cancelled' else 1


if __name__ == '__main__':
    raise SystemExit(main())
