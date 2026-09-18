"""Shared analysis, result validation and transactional montage export."""
from dataclasses import asdict, dataclass, fields
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import uuid

import apex_highlight as core
import audio_chart
import damage_detector
import precise_render

VERSION = 1


@dataclass
class Parameters:
    sample_rate: int = 16000
    frame_ms: float = 25.0
    threshold_percentile: float = 96.0
    event_bridge_ms: float = 200.0
    fight_gap_s: float = 4.0
    min_events: int = 4
    before_s: float = 5.0
    after_s: float = 8.0
    max_clip_s: float = 60.0

    mode: str = "audio"
    damage_fps: int = 30
    damage_gap_s: float = .3
    damage_before_s: float = .1
    damage_after_s: float = .2

    def validate(self, source):
        from argparse import Namespace
        if self.mode not in ('audio', 'damage'):
            raise ValueError('mode 须为 audio 或 damage')
        if not all(math.isfinite(v) for k,v in asdict(self).items() if k != 'mode'):
            raise ValueError('参数必须是有限数值')
        if not isinstance(self.sample_rate, int) or not isinstance(self.min_events, int):
            raise ValueError('采样率和最少事件数必须是整数')
        if not isinstance(self.damage_fps,int) or not 10 <= self.damage_fps <= 60:
            raise ValueError('damage-fps 须为 10–60 的整数')
        if min(self.damage_gap_s,self.damage_before_s,self.damage_after_s)<0:
            raise ValueError('伤害模式的间隔和缓冲不能为负数')
        core.validate_args(Namespace(input=source, **asdict(self)))


def new_output_dir():
    return Path.cwd() / 'outputs' / (datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6])


def same_file(a, b):
    return a.resolve() == b.resolve() or (a.exists() and b.exists() and os.path.samefile(a, b))


def protect(target, source, overwrite=False):
    if same_file(target, source):
        raise ValueError(f'禁止覆盖源录像：{source}')
    if target.exists() and not overwrite:
        raise FileExistsError(f'文件已存在：{target}；请另选目录/文件或使用 --overwrite')
    if target.is_dir():
        raise ValueError(f'目标是目录：{target}')


def identity(source):
    """Full digest permits relocation while rejecting changed recordings."""
    before = source.stat()
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('源录像正在变化，请等待录制完成后重新分析')
    return {'size': after.st_size, 'mtime_ns': after.st_mtime_ns, 'sha256': digest.hexdigest()}


def publish(temp, target, overwrite):
    if overwrite:
        os.replace(temp, target)
    else:
        # Atomic no-clobber even if another writer appears after preflight.
        os.link(temp, target)
        temp.unlink()


def save_json(target, payload, overwrite=False):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.apex-json-', dir=target.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
        publish(temp, target, overwrite)
    finally:
        temp.unlink(missing_ok=True)


def logging_to(folder):
    folder.mkdir(parents=True, exist_ok=True)
    # Unique logs never overwrite source files or earlier diagnostics.
    path = folder / ('run-' + uuid.uuid4().hex + '.log')
    core.configure_logging(path, False)
    for handler in core.LOG.handlers[:]:
        import logging
        if not isinstance(handler, logging.FileHandler):
            core.LOG.removeHandler(handler)
            handler.close()
    return path


def analyze(source, output_dir=None, params=None, *, overwrite=False, progress=None):
    source = Path(source).expanduser().resolve()
    params = params or Parameters()
    params.validate(source)
    folder = Path(output_dir or new_output_dir()).expanduser().resolve()
    targets = [folder / name for name in ('events.json', 'clips.json', 'analysis.html')]
    for target in targets:
        protect(target, source, overwrite)
    log = logging_to(folder)
    notify = progress or (lambda *args: None)
    try:
        core.require_tools()
        notify('校验源录像', 0, None)
        info = identity(source)
        notify('读取媒体信息', 0, None)
        media = core.probe_media(source)
        duration = media['duration_seconds']
        if not math.isfinite(duration):
            raise ValueError('无效媒体时长')
        readings=[];stats={}
        if params.mode == 'damage':
            events,clips,readings,stats=damage_detector.analyze_video(source,media,
                fps=params.damage_fps,gap=params.damage_gap_s,before=params.damage_before_s,
                after=params.damage_after_s,progress=notify)
            rms=None;threshold=None
        else:
            rms = core.stream_frame_rms_dbfs(source, params.sample_rate, params.frame_ms,
                lambda count: notify('解码音频', count, round(duration * params.sample_rate)))
            notify('检测候选片段', 0, None)
            threshold, events = core.detect_events(rms, frame_ms=params.frame_ms,
                threshold_percentile=params.threshold_percentile, event_bridge_ms=params.event_bridge_ms)
            clips = core.cluster_events(events, duration=duration, fight_gap_s=params.fight_gap_s,
                min_events=params.min_events, before_s=params.before_s, after_s=params.after_s,
                max_clip_s=params.max_clip_s)
        stat = source.stat()
        if (stat.st_size, stat.st_mtime_ns) != (info['size'], info['mtime_ns']):
            raise ValueError('分析期间源录像发生变化，请重新分析')
        common = {'format_version': VERSION, 'analysis_id': uuid.uuid4().hex,
                  'input': str(source), 'source': info, 'duration_seconds': duration,
                  'config': asdict(params) | {'threshold_dbfs': round(threshold, 3) if threshold is not None else None,
                                           'selection_signal': 'damage_counter_growth' if params.mode == 'damage' else 'audio_rms_only'}, 'log': str(log)}
        save_json(targets[0], common | {'frame_count': stats.get('sampled_frames') if rms is None else int(rms.size),
                  'events': events if rms is None else [asdict(e) for e in events],
                  'damage_readings': readings}, overwrite)
        data = common | {'total_selected_seconds': round(sum(c.duration for c in clips), 3),
                        'clips': [asdict(c) | {'duration': round(c.duration, 3)} for c in clips],
                        'damage_stats': stats,
                        'audio_curve': [] if rms is None else audio_chart.summarize(rms,
                            max(1, round(params.sample_rate * params.frame_ms / 1000)) / params.sample_rate)}
        if rms is None:
            data.update(damage_readings=readings, damage_events=events)
        notify('保存伤害候选' if params.mode=='damage' else '绘制音频曲线', 0, None)
        fd, name = tempfile.mkstemp(prefix='.apex-chart-', dir=folder)
        temp = Path(name)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                if params.mode == 'damage':
                    stream.write('<meta charset="utf-8"><title>伤害集锦候选</title><h1>伤害增长候选</h1>'
                        + '<p>计数增长选片；不区分伤害来源。编号预览由终端生成并给出路径。</p>'
                        + '<table><tr><th>编号</th><th>开始</th><th>结束</th></tr>'
                        + ''.join(f'<tr><td>{i}</td><td>{c.start:.3f}</td><td>{c.end:.3f}</td></tr>' for i,c in enumerate(clips,1))+'</table>')
                else:stream.write(audio_chart.html_report(data))
            publish(temp, targets[2], overwrite)
        finally:
            temp.unlink(missing_ok=True)
        save_json(targets[1], data, overwrite)
        return targets[1]
    except BaseException:
        core.LOG.exception('分析失败；日志：%s', log)
        raise


def load_result(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('clips'), list):
        raise ValueError('无效的 clips.json：缺少候选片段列表')
    try:
        duration = float(data['duration_seconds'])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        for c in data['clips']:
            clip = core.Clip(**{f.name: c[f.name] for f in fields(core.Clip) if f.name in c})
            if not all(math.isfinite(v) for v in (clip.start, clip.end, clip.raw_start, clip.raw_end, clip.peak_dbfs)):
                raise ValueError()
            if not 0 <= clip.start < clip.end <= duration + .001:
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError('候选片段数据或时间范围无效') from None
    return data


def selected_ids(data, text=None):
    if text is None:
        ids = list(range(1, len(data['clips']) + 1))
    else:
        try:
            ids = [int(i.strip()) for i in text.split(',')]
        except ValueError:
            raise ValueError('--clips 应为从 1 开始的编号，例如 1,3') from None
        if not ids or any(i < 1 or i > len(data['clips']) for i in ids):
            raise ValueError('片段编号超出范围')
    return sorted(set(ids), key=lambda i: (data['clips'][i-1]['start'], i))


def export_result(result, ids=None, *, source=None, output=None, overwrite=False,
                  progress=None, keep_work=False, preview=False):
    result = Path(result).expanduser().resolve()
    data = load_result(result)
    ids = selected_ids(data, ','.join(map(str, ids))) if ids else ([] if ids == [] else selected_ids(data))
    if not ids:
        return None
    if data.get('format_version') != VERSION or not isinstance(data.get('source'), dict):
        raise ValueError('旧结果缺少源文件信息或版本不支持：允许查看，请重新分析后导出')
    src = Path(source or data['input']).expanduser().resolve()
    if not src.is_file():
        raise ValueError('源录像缺失，请使用 --source 重新指定原录像')
    output = Path(output or result.parent / ('candidate_preview.mp4' if preview else 'apex_montage.mp4')).expanduser().resolve()
    selection = result.parent / ('preview.json' if preview else 'selection.json')
    for target in (output, selection):
        protect(target, src, overwrite)
        if same_file(target, Path(data["input"])):
            raise ValueError("禁止覆盖原始源录像")
        for reserved in (result, result.parent / 'events.json', result.parent / 'analysis.html',
                         result.parent / ('selection.json' if preview else 'preview.json')):
            if same_file(target, reserved):
                raise ValueError('导出目标不能覆盖分析结果')
    if same_file(output, selection):
        raise ValueError('成片路径不能是 selection.json')
    if output.suffix.lower() not in ('.mp4', '.mkv', '.mov'):
        raise ValueError('成片扩展名须为 .mp4、.mkv 或 .mov')
    log = logging_to(result.parent)
    notify = progress or (lambda *args: None)
    try:
        notify('校验源录像', 0, None)
        current = identity(src)
        if any(current.get(k) != data['source'].get(k) for k in ('size', 'sha256')):
            raise ValueError('源文件信息不匹配，请重新分析')
        core.require_tools()
        clips = [core.Clip(**{f.name: data['clips'][i-1][f.name] for f in fields(core.Clip)
                            if f.name in data['clips'][i-1]}) for i in ids]
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.apex-export-', dir=output.parent) as name:
            staging = Path(name)
            work = (output.parent / ('work-' + uuid.uuid4().hex)) if keep_work else staging / 'cuts'
            temp = staging / output.name
            notify('裁剪', 0, len(clips))
            render_info={}
            if preview or data.get('config',{}).get('selection_signal')=='damage_counter_growth':
                render_info=precise_render.render(src,clips,temp,work,notify,ids if preview else None)
            else:core.render_fast_montage(src, clips, temp, work, progress=notify)
            publish(temp, output, overwrite)
        save_json(selection, {'format_version': VERSION, 'analysis_id': data.get('analysis_id'),
            'result': str(result), 'source': str(src), 'clips': ids, 'output': str(output), 'log': str(log), 'render': render_info, 'preview': preview}, overwrite)
        return output
    except BaseException:
        core.LOG.exception('导出失败；日志：%s', log)
        raise
