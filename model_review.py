"""Versioned review, on-demand previews and independent media exports."""
import copy
import math
import json
from pathlib import Path
import tempfile
import time
import uuid


def service_error(code, message, status=422):
    # The mixin is imported by the public service, so resolve its error lazily.
    from model_service import ServiceError
    return ServiceError(code, message, status)


class ModelReviewMixin:
    def execute_review(self, operation, request):
        required = {'update_selection': ('result_id', 'candidate_version', 'clips'),
                    'request_preview': ('result_id', 'candidate_version', 'candidate_id'),
                    'export': ('result_id', 'candidate_version', 'output_dir'),
                    'get_artifact': ('artifact_id',)}.get(operation, ())
        if any(key not in request for key in required):
            raise service_error('invalid_request', '请求缺少必要字段', 400)
        if operation == 'update_selection':
            clips = request['clips']
            if (not isinstance(clips, list) or any(not isinstance(clip, dict)
                    or not isinstance(clip.get('candidate_id'), str)
                    or ('selected' in clip and type(clip['selected']) is not bool) for clip in clips)):
                raise service_error('invalid_request', '选择必须包含候选标识和有效的勾选值', 400)
            # Content checks may read a large recording; keep status queries free.
            result = self.review_result(request)
            with self.lock:
                current = self.execute('get_result', {'result_id': result['result_id']})
                if current['candidate_version'] != result['candidate_version']:
                    raise service_error('stale_candidates', '候选版本已更新，请重新复核', 409)
                result = current
                selections = {item['candidate_id']: item for item in result['selection']}
                for clip in request['clips']:
                    item = selections.get(clip['candidate_id'])
                    if item is None:
                        raise service_error('candidate_not_found', '候选不存在，请重新复核', 404)
                    start, end = clip.get('start_s', item['start_s']), clip.get('end_s', item['end_s'])
                    if (type(start) not in (int, float) or type(end) not in (int, float)
                            or not math.isfinite(start) or not math.isfinite(end)
                            or not 0 <= start < end <= result['media']['duration_s']):
                        raise service_error('invalid_range', '范围必须满足 0 ≤ start < end ≤ 录像时长')
                    item.update({k: clip[k] for k in ('selected',) if k in clip})
                    item.update(start_s=start, end_s=end)
                    item['revision'] += 1
                self.save_record(self.results_dir / result['result_id'] / 'result.json', result)
                return result
        if operation == 'request_preview':
            result = self.review_result(request)
            selection = self.review_selection(result, request.get('candidate_id'))
            for record in (self.data_dir / 'artifacts').glob('*.json'):
                artifact = json.loads(record.read_text(encoding='utf-8'))
                if (artifact['kind'] == 'preview' and artifact['result_id'] == result['result_id']
                        and artifact['candidate_version'] == result['candidate_version']
                        and artifact['candidate_id'] == selection['candidate_id']
                        and artifact['requested_range'] == {k: selection[k] for k in ('start_s', 'end_s')}
                        and Path(artifact['path']).is_file()):
                    return self.start_task('preview', lambda task: self.update_task(
                        task, preview_id=artifact['artifact_id']), result_id=result['result_id'])
            return self.start_task('preview', lambda task: self.generate_preview(task, result, selection),
                                   result_id=result['result_id'])
        if operation == 'export':
            result = self.review_result(request)
            if request.get('mode', 'copy') != 'copy':
                raise service_error('export_mode_unavailable', '当前仅启用快速复制；精确重编码尚未验收')
            audio_index = result['media']['selected_audio']['stream_index']
            audio = next(t for t in result['media']['audio_tracks'] if t['stream_index'] == audio_index)
            if (result['media']['video']['codec'] not in ('h264', 'hevc', 'av1', 'mpeg4')
                    or audio['codec'] not in ('aac', 'mp3', 'alac')):
                raise service_error('copy_incompatible', '源音视频编码未通过 MP4 快速复制支持范围；不会自动重编码')
            selected = sorted((item for item in result['selection'] if item['selected']),
                              key=lambda item: (item['start_s'], item['end_s']))
            if not selected:
                raise service_error('empty_selection', '请先选择至少一个候选片段')
            try:
                destination = request['output_dir']
                if not isinstance(destination, str) or not destination.strip() or '\0' in destination:
                    raise ValueError('invalid path')
                output = Path(destination).expanduser().resolve()
                protected = [self.results_dir, self.records_dir, self.tasks_dir, self.data_dir / 'artifacts']
                if (output.exists() and not output.is_dir()) or any(
                        output == directory or directory in output.parents for directory in protected):
                    raise ValueError('protected destination')
            except (OSError, ValueError, TypeError) as exc:
                raise service_error('invalid_output_dir', '请选择可写输出目录，不能写入源录像或分析记录') from exc
            return self.start_task('export', lambda task: self.generate_exports(task, result, selected, output),
                                   result_id=result['result_id'], exports=[])
        if operation == 'get_artifact':
            artifact = self.read_record(self.data_dir / 'artifacts', request.get('artifact_id'),
                                        'artifact_not_found')
            if artifact['kind'] == 'preview':
                result = self.execute('get_result', {'result_id': artifact['result_id']})
                self.validate_result(result)
                selection = next((item for item in result['selection']
                                  if item['candidate_id'] == artifact['candidate_id']), None)
                if (result['candidate_version'] != artifact['candidate_version'] or selection is None
                        or artifact['requested_range'] != {k: selection[k] for k in ('start_s', 'end_s')}):
                    raise service_error('stale_preview', '预览对应旧版本或旧范围，请重新生成', 409)
            path = Path(artifact['path'])
            if not path.is_file():
                raise service_error('artifact_not_found', '文件不存在，请重新生成', 404)
            return {**artifact, 'size': path.stat().st_size}
        return NotImplemented

    def review_selection(self, result, candidate_id):
        if not isinstance(candidate_id, str):
            raise service_error('candidate_not_found', '候选不存在', 404)
        selection = next((item for item in result['selection']
                          if item['candidate_id'] == candidate_id), None)
        if selection is None:
            raise service_error('candidate_not_found', '候选不存在', 404)
        return selection

    def generate_preview(self, task, result, selection):
        started = time.perf_counter()
        artifact_id = uuid.uuid4().hex
        folder = self.results_dir / result['result_id'] / 'previews'
        folder.mkdir(exist_ok=True)
        path = folder / (artifact_id + '.mp4')
        media = result['media']
        start, end = selection['start_s'], selection['end_s']
        self.update_task(task, stage='previewing', progress=0, pending_paths=[str(path)],
                         media_log=str(folder / 'media.log'))
        try:
            self.review_process(task, [self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-n',
                            '-protocol_whitelist', 'file,pipe', '-seek_timestamp', '1',
                            '-ss', str(media['video']['start_time_s'] + start),
                            '-i', media['source']['path'], '-t', str(end - start),
                            '-map', f"0:{media['video']['stream_index']}",
                            '-map', f"0:{media['selected_audio']['stream_index']}",
                            '-vf', 'scale=min(1280\\,iw):-2', '-c:v', 'libx264',
                            '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                            '-movflags', '+faststart', str(path)], folder / 'media.log')
            self.validate_result(result)
            self.check_cancelled(task)
            artifact = {'artifact_id': artifact_id, 'kind': 'preview', 'path': str(path),
                        'content_type': 'video/mp4', 'result_id': result['result_id'],
                        'candidate_version': result['candidate_version'],
                        'candidate_id': selection['candidate_id'], 'selection_revision': selection['revision'],
                        'requested_range': {'start_s': start, 'end_s': end}}
            self.save_artifact(artifact)
            self.update_task(task, preview_id=artifact_id, pending_paths=[],
                             timings={'previewing': time.perf_counter() - started})
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            self.update_task(task, timings={'previewing': time.perf_counter() - started})

    def save_artifact(self, artifact):
        folder = self.data_dir / 'artifacts'
        folder.mkdir(exist_ok=True)
        self.save_record(folder / (artifact['artifact_id'] + '.json'), artifact)

    def review_process(self, task, command, log_path, stdout=None):
        return self.run_process(task, command, log_path, stdout=stdout)

    def packets(self, task, source, stream_index, log_path, *, hashes=False):
        # Spool ffprobe output rather than retaining full long-video packet JSON.
        command = [self.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
                   '-select_streams', str(stream_index), '-show_packets',
                   '-show_entries', 'packet=pts_time,duration_time,flags' + (',data_hash' if hashes else ''),
                   '-of', 'compact=p=0:nk=0']
        if hashes:
            command += ['-show_data_hash', 'sha256']
        command.append(str(source))
        with tempfile.TemporaryFile() as stream:
            self.review_process(task, command, log_path, stdout=stream)
            stream.seek(0)
            for line in stream:
                fields = dict(part.split('=', 1) for part in line.decode().strip().split('|') if '=' in part)
                if 'pts_time' in fields:
                    yield fields

    def generate_exports(self, task, result, selected, output):
        started = time.perf_counter()
        self.check_cancelled(task)
        media = result['media']
        folder = output / media['media_id'] / task['task_id']
        folder.mkdir(parents=True, exist_ok=False)
        log_path = folder / 'media.log'
        self.update_task(task, stage='preparing_export', media_log=str(log_path))
        # Review-stage optimization: hash the source's encoded video packets once
        # per export task, then reuse a disk spool for every measured output.
        with tempfile.TemporaryFile(mode='w+t', encoding='utf-8') as source_packets:
            keyframes = []
            for packet in self.packets(task, media['source']['path'], media['video']['stream_index'],
                                       log_path, hashes=True):
                source_packets.write(json.dumps(packet) + '\n')
                if 'K' in packet.get('flags', ''):
                    keyframes.append(float(packet['pts_time']) - media['video']['start_time_s'])
            source_packets.flush()
            self.update_task(task, timings={'preparing_export': time.perf_counter() - started})
            self.copy_exports(task, result, selected, folder, log_path, keyframes, source_packets)

    def copy_exports(self, task, result, selected, folder, log_path, keyframes, source_packets):
        media = result['media']
        origin = media['video']['start_time_s']
        export_started = time.perf_counter()
        for index, selection in enumerate(selected):
            self.validate_result(result)
            self.check_cancelled(task)
            start, end = selection['start_s'], selection['end_s']
            anchor = max((key for key in keyframes if key <= start + 1e-8), default=0.0)
            path = folder / f'{index + 1:03d}.mp4'
            self.update_task(task, stage='exporting', progress=index / len(selected),
                             pending_paths=[str(path)], media_log=str(log_path))
            try:
                self.review_process(task, [self.ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-n',
                    '-protocol_whitelist', 'file,pipe', '-seek_timestamp', '1', '-ss', str(origin + anchor),
                    '-i', media['source']['path'], '-t', str(end - anchor),
                    '-map', f"0:{media['video']['stream_index']}",
                    '-map', f"0:{media['selected_audio']['stream_index']}",
                    '-c', 'copy', '-movflags', '+faststart', str(path)], log_path)
                actual = self.measure_copy_range(task, media, path, anchor, log_path, source_packets)
                self.validate_result(result)
                self.check_cancelled(task)
                artifact = {'artifact_id': uuid.uuid4().hex, 'kind': 'export', 'path': str(path),
                            'content_type': 'video/mp4', 'status': 'completed', 'mode': 'copy',
                            'result_id': result['result_id'], 'prediction_id': result['prediction_id'],
                            'candidate_version': result['candidate_version'],
                            'candidate_id': selection['candidate_id'], 'selection': selection,
                            'source': media['source'], 'selected_audio': media['selected_audio'],
                            'requested_range': {'start_s': start, 'end_s': end}, 'actual_range': actual,
                            'measurement': 'source-video-packet-sha256-sequence-and-presentation-timestamps'}
                self.save_artifact(artifact)
                self.update_task(task, exports=[*task['exports'], artifact], pending_paths=[])
                self.save_record(folder / 'exports.json', {'task_id': task['task_id'], 'exports': task['exports']})
            except Exception as exc:
                path.unlink(missing_ok=True)
                interrupted = task.get('shutdown_reason') == 'service_interrupted'
                cancelled = self.cancel_events[task['task_id']].is_set() and not interrupted
                failed = {'candidate_id': selection['candidate_id'], 'status': 'cancelled' if cancelled else 'failed',
                          'mode': 'copy', 'path': None, 'actual_range': None,
                          'requested_range': {'start_s': start, 'end_s': end},
                          'error': {'code': 'service_interrupted' if interrupted else 'task_cancelled' if cancelled else getattr(exc, 'code', 'media_failed'),
                                    'message': '入口异常退出，当前导出中断；已完成片段保留' if interrupted else str(exc)}}
                self.update_task(task, exports=[*task['exports'], failed], pending_paths=[])
                self.save_record(folder / 'exports.json', {'task_id': task['task_id'], 'exports': task['exports']})
                raise
            finally:
                self.update_task(task, timings={'exporting': time.perf_counter() - export_started})

    def measure_copy_range(self, task, media, path, anchor, log_path, source_packets):
        output = list(self.packets(task, path, 0, log_path, hashes=True))
        if not output:
            raise service_error('actual_range_unavailable', '输出没有可验证的视频包')
        matched = []
        origin = media['video']['start_time_s']
        source_packets.seek(0)
        for line in source_packets:
            self.check_cancelled(task)
            packet = json.loads(line)
            if not matched:
                if (abs(float(packet['pts_time']) - origin - anchor) > 1e-5
                        or packet['data_hash'] != output[0]['data_hash']):
                    continue
            if packet['data_hash'] != output[len(matched)]['data_hash']:
                raise service_error('actual_range_unavailable', '输出视频包无法与源录像连续对应')
            matched.append(packet)
            if len(matched) == len(output):
                return {'start_s': min(float(p['pts_time']) for p in matched) - origin,
                        'end_s': max(float(p['pts_time']) + float(p['duration_time']) for p in matched) - origin}
        raise service_error('actual_range_unavailable', '未找到完整输出视频包的源时间范围')

    def review_result(self, request):
        result = self.execute('get_result', {'result_id': request.get('result_id')})
        self.validate_result(result)
        if request.get('candidate_version') != result['candidate_version']:
            raise service_error('stale_candidates', '候选版本已更新，请重新复核', 409)
        if 'selection' not in result:
            result['selection'] = [dict(candidate_id=c['candidate_id'], selected=True,
                                        start_s=c['start_s'], end_s=c['end_s'], revision=1)
                                   for c in result['candidates']]
        return copy.deepcopy(result)
