"""Chinese interactive wizard and non-interactive Typer commands."""
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
import sys

import questionary as q
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeElapsedColumn
from rich.table import Table
from rich.text import Text
import typer

import apex_highlight as core
import highlight_service as service
import audio_chart
import terminal_ui as ui
from media_runtime import tool_path, run_command

app = typer.Typer(help='Apex 音频高能 / 伤害增长片段分析与集锦导出',
                  invoke_without_command=True, no_args_is_help=False, pretty_exceptions_enable=False)
console = Console()
interactive = False


@contextmanager
def reporting():
    with Progress(SpinnerColumn(), TextColumn('{task.description}'), BarColumn(complete_style='cyan', finished_style='green'),
                  TextColumn('{task.fields[count]}'), TimeElapsedColumn(), console=console) as progress:
        task = None
        stage = None
        def update(name, completed, total):
            nonlocal task, stage
            count = f'{completed}/{total}' if total else ''
            if name != stage:
                if task is not None:
                    progress.remove_task(task)
                task = progress.add_task(name, total=total, count=count)
                stage = name
            progress.update(task, completed=completed, total=total, count=count)
        yield update


def show_result(data, result=None):
    damage=data.get('config',{}).get('selection_signal')=='damage_counter_growth'
    if not damage:audio_chart.terminal_chart(console, data)
    else:
        stats=data.get('damage_stats',{})
        console.print(f"伤害数字可读帧：{stats.get('readable_frames',0)}/{stats.get('sampled_frames',0)}")
        for warning in stats.get('warnings',[]):console.print(warning,style='yellow',markup=False)
    if result is not None and data.get('audio_curve'):
        chart = Path(result).resolve().parent / 'analysis.html'
        if chart.is_file():
            console.print('详细曲线（浏览器打开）：' + str(chart), markup=False)
            console.print(Text('打开音频曲线与裁剪时间轴', style=f'link {chart.as_uri()}'))
    table = Table(title='候选片段（伤害计数增长）' if damage else '候选片段（音频能量检测）')
    for name in ('编号', '开始 / 秒', '结束 / 秒', '时长 / 秒', '事件数', '提示'):
        table.add_column(name)
    for i, clip in enumerate(data['clips'], 1):
        table.add_row(str(i), f"{clip['start']:.3f}", f"{clip['end']:.3f}",
            f"{clip['end']-clip['start']:.3f}", str(clip['event_count']),
            '超过建议时长，保留' if clip.get('exceeds_max_duration') else '')
    console.print(table)
    if not data['clips']:
        console.print('未发现候选片段；分析结果已保存，跳过导出。')
    if data.get('format_version') != service.VERSION or not data.get('source'):
        console.print('旧结果仅供查看，请重新分析后导出。', style='yellow')


def report_log():
    import logging
    for handler in core.LOG.handlers:
        if isinstance(handler, logging.FileHandler):
            console.print('日志：' + handler.baseFilename, markup=False)


@contextmanager
def errors():
    try:
        yield
    except (KeyboardInterrupt, EOFError):
        console.print('\n已取消，正在运行的媒体进程已终止。', style='yellow')
        report_log()
        raise typer.Exit(130)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        console.print('错误：' + str(error), style='red', markup=False)
        report_log()
        raise typer.Exit(1)


def do_analyze(source, folder, params, overwrite=False):
    with reporting() as update:
        result = service.analyze(source, folder, params, overwrite=overwrite, progress=update)
    if not interactive:
        console.print('分析结果：' + str(result), markup=False)
        show_result(service.load_result(result), result)
        report_log()
    if params.mode=="damage":do_preview(result,overwrite=overwrite)
    return result


def do_export(result, ids=None, source=None, output=None, overwrite=False):
    with reporting() as update:
        target = service.export_result(result, ids, source=source, output=output,
                                       overwrite=overwrite, progress=update)
    console.print('成片：' + str(target) if target else '没有选中的片段，跳过导出。', markup=False)
    report_log()
    return target


# One option signature is shared by run and analyze to keep defaults identical.
def analysis_command(input: Path = typer.Argument(..., help='录像路径'),
    output_dir: Path | None = typer.Option(None, help='任务目录；默认新建独立目录'),
    sample_rate: int = 16000, frame_ms: float = 25.0, threshold_percentile: float = 96.0,
    event_bridge_ms: float = 200.0, fight_gap_s: float = 4.0, min_events: int = 4,
    before_s: float = 5.0, after_s: float = 8.0, max_clip_s: float = 60.0,
    overwrite: bool = False, mode: str = "audio", damage_fps: int = 30,
    damage_gap_s: float = .3, damage_before_s: float = .1, damage_after_s: float = .2,
    ctx: typer.Context = None):
    with errors():
        params = service.Parameters(sample_rate, frame_ms, threshold_percentile, event_bridge_ms,
                                    fight_gap_s, min_events, before_s, after_s, max_clip_s,
                                    mode,damage_fps,damage_gap_s,damage_before_s,damage_after_s)
        result = do_analyze(input, output_dir, params, overwrite)
        if ctx.command.name == 'run':
            do_export(result, overwrite=overwrite)


app.command('analyze', help='只分析录像并保存完整候选片段；不提问')(analysis_command)
app.command('run', help='分析录像并导出全部候选片段；不提问')(analysis_command)



def do_preview(result, overwrite=False, source=None):
    with reporting() as update:
        target=service.export_result(result,source=source,preview=True,overwrite=overwrite,progress=update)
    if target:
        console.print('编号预览视频（用本地播放器打开）：' + str(target),markup=False,soft_wrap=True)
        console.print(Text('打开编号预览视频',style=f'link {target.as_uri()}'))
    return target

@app.command('preview')
def preview_command(result: Path, overwrite: bool=False, source: Path | None=None):
    """生成带候选编号的预览视频，显示完整路径。"""
    with errors():do_preview(result,overwrite,source)

@app.command('inspect')
def inspect_result(result: Path):
    """查看已有 clips.json。"""
    with errors():
        show_result(service.load_result(result), result)


@app.command('export')
def export_command(result: Path, clips: str | None = typer.Option(None, help='从 1 开始，例如 1,3；省略为全部'),
                   source: Path | None = typer.Option(None, help='重新指定同一源录像'),
                   output: Path | None = typer.Option(None, help='成片路径，默认 apex_montage.mp4'),
                   overwrite: bool = False):
    """按源时间顺序导出所选片段，不重新分析音频。"""
    with errors():
        data = service.load_result(result)
        do_export(result, service.selected_ids(data, clips), source, output, overwrite)


@app.command()
def doctor():
    """检查媒体工具能否运行。"""
    with errors():
        for name in ('ffmpeg', 'ffprobe'):
            path = tool_path(name)
            version = run_command([name, '-version'], capture=True).stdout.splitlines()[0]
            console.print(f'{name}: {path}\n{version}', markup=False)
        console.print('运行环境检查通过。', style='green')


def ask(prompt):
    value = (ui.prepare_prompt(prompt) if interactive else prompt).unsafe_ask()
    if value is None:
        raise KeyboardInterrupt()
    return value


def input_path(message, default=''):
    return Path(ask(q.path(message, default=default)).strip().strip('"').strip("'")).expanduser()


def choose_clips(data):
    return ask(q.checkbox('选择导出片段（空格勾选/取消，回车确认）', instruction='（空格切换 · A 全选）', choices=[
        q.Choice(f"{i}. {c['start']:.3f}–{c['end']:.3f} 秒", value=i, checked=True)
        for i, c in enumerate(data['clips'], 1)]))


def screen(title, subtitle='', step=None):
    ui.page(console, title, subtitle, step)


def pause(message='返回主菜单'):
    ask(q.press_any_key_to_continue(f'按任意键{message}…'))


def open_artifact(path):
    path = Path(path).resolve()
    if not path.exists():
        raise ValueError(f'文件不存在：{path}')
    if typer.launch(str(path)) != 0:
        raise RuntimeError(f'无法打开，请手动打开：{path}')


def wizard_export(result, auto=False):
    data = service.load_result(result)
    if not data['clips'] or data.get('format_version') != service.VERSION or not data.get('source'):
        return
    source = Path(data['input'])
    screen('选择导出片段', '空格勾选 / 取消 · A 全选 / 全不选 · 候选列表可上下滚动', 3)
    ui.context(console, 录像=source.name, 候选=f"{len(data['clips'])} 个", 结果=result)
    if not source.is_file():
        source = input_path('源录像缺失，请指定原录像：')
    if data.get('config', {}).get('selection_signal') == 'damage_counter_growth':
        preview = result.parent / 'candidate_preview.mp4'
        if not preview.exists():
            do_preview(result, source=source)
    ids = service.selected_ids(data) if auto else choose_clips(data)
    if not ids:
        ask(ui.select('未选择片段', choices=['返回结果页']))
        return
    target = result.parent / 'apex_montage.mp4'
    screen('确认导出', step=4)
    duration = sum(data['clips'][i-1]['end'] - data['clips'][i-1]['start'] for i in ids)
    ui.context(console, 已选=f'{len(ids)} 个片段 · 约 {duration:.1f} 秒', 成片=target)
    damage = data.get('config', {}).get('selection_signal') == 'damage_counter_growth'
    console.print('伤害模式将重新编码，按视频帧对齐切点。' if damage else
                  '快速裁剪受关键帧影响，实际切点与时长可能有少量偏差。', style='dim')
    overwrite = False
    if target.exists() or (result.parent / 'selection.json').exists():
        overwrite = ask(q.confirm('已有成片或勾选记录，是否覆盖？', default=False))
        if not overwrite:
            return
    if not auto and not ask(q.confirm(f'确认导出 {len(ids)} 个片段？', default=True)):
        return
    screen('正在导出', '正在校验录像并按源时间顺序拼接；Ctrl+C 取消当前任务。', 4)
    target = do_export(result, ids, source, target, overwrite)
    screen('导出完成', '成片与选择记录已保存。', 4)
    ui.context(console, 成片=target, 片段=f'{len(ids)} 个', 结果=result)
    while True:
        action = ask(ui.select('接下来', choices=['返回结果页', '播放成片', '打开输出目录', '返回主菜单']))
        if action == '返回结果页':
            return
        if action == '返回主菜单':
            raise ui.ReturnHome()
        open_artifact(target if action == '播放成片' else result.parent)


def result_page(result):
    data = service.load_result(result)
    index = 0
    while True:
        screen('分析结果', step=3)
        damage = data.get('config', {}).get('selection_signal') == 'damage_counter_growth'
        ui.context(console, 录像=Path(data['input']).name, 模式='高能剪辑' if damage else '复盘剪辑')
        index, pages = ui.candidates(console, data, index)
        eligible = data.get('format_version') == service.VERSION and data.get('source')
        if not data['clips']:
            console.print('未发现候选片段，分析结果已保存。', style='yellow')
        if not eligible:
            console.print('旧结果仅供查看，请重新分析后导出。', style='yellow')
        choices = []
        if data['clips'] and eligible:
            choices.append('选择片段并导出')
        if pages > 1:
            choices.extend(['下一页', '上一页'])
        if (result.parent / 'candidate_preview.mp4').exists():
            choices.append('播放编号预览')
        if (result.parent / 'analysis.html').exists() and not damage:
            choices.append('打开音频曲线')
        choices.extend(['查看检测说明', '打开输出目录', '查看运行日志', '返回主菜单'])
        action = ask(ui.select('结果操作', choices=choices))
        if action == '返回主菜单':
            return
        if action == '下一页':
            index = (index + 1) % pages
        elif action == '上一页':
            index = (index - 1) % pages
        elif action == '选择片段并导出':
            wizard_export(result)
        elif action == '查看检测说明':
            screen('检测说明')
            if damage:
                stats = data.get('damage_stats', {})
                console.print(f"伤害数字可读帧：{stats.get('readable_frames', 0)}/{stats.get('sampled_frames', 0)}")
                for warning in stats.get('warnings', []):
                    console.print(warning, style='yellow', markup=False)
                console.print('伤害增长不区分伤害来源，也不判断击杀或观战。')
            else:
                console.print('音频能量用于发现候选，不代表已经确认击杀或命中。')
            long_count = sum(bool(c.get('exceeds_max_duration')) for c in data['clips'])
            console.print(f'超过建议时长的候选：{long_count} 个（保留，不截断）。')
            pause('返回结果页')
        elif action == '查看运行日志':
            logs = sorted(result.parent.glob('run-*.log'), key=lambda p: p.stat().st_mtime)
            if logs:
                open_artifact(logs[-1])
            else:
                screen('运行日志')
                console.print('此任务目录没有运行日志。')
                pause('返回结果页')
        else:
            paths = {'播放编号预览': result.parent / 'candidate_preview.mp4',
                     '打开音频曲线': result.parent / 'analysis.html', '打开输出目录': result.parent}
            open_artifact(paths[action])


def configure_task():
    screen('任务设置 · 录像', '输入或拖入录像路径。', 1)
    source = input_path('录像路径：').resolve()
    if not source.is_file():
        raise ValueError(f'录像文件不存在：{source}')
    screen('任务设置 · 输出与模式', step=1)
    ui.context(console, 录像=source)
    folder = input_path('输出目录：', str(service.new_output_dir())).resolve()
    mode = ask(ui.select('选片方式', choices=[
        q.Choice('1. 复盘剪辑（片段更长且覆盖战斗全周期，用于复盘背锅）', value='audio'),
        q.Choice('2. 高能剪辑（只剪辑击中状态，唐比必备）', value='damage')]))
    params = service.Parameters(mode=mode)
    if ask(q.confirm('修改高级检测参数？', default=False)):
        labels = {'sample_rate':'采样率 Hz', 'frame_ms':'分析帧长 ms',
            'threshold_percentile':'能量阈值百分位', 'event_bridge_ms':'事件桥接 ms',
            'fight_gap_s':'战斗聚类间隔 秒', 'min_events':'最少事件数',
            'before_s':'前置缓冲 秒', 'after_s':'后置缓冲 秒', 'max_clip_s':'建议最大时长 秒（只提示）',
            'damage_fps':'伤害数字采样 FPS（10–60）', 'damage_gap_s':'伤害事件合并间隔 秒',
            'damage_before_s':'伤害片段前置缓冲 秒', 'damage_after_s':'伤害片段后置缓冲 秒'}
        for key, value in asdict(params).items():
            if key == 'mode' or (key.startswith('damage_') != (mode == 'damage')):
                continue
            screen('高级检测参数', step=1)
            text = ask(q.text(labels[key], default=str(value),
                       validate=lambda text, cast=type(value): valid_number(text, cast)))
            setattr(params, key, type(value)(text))
    params.validate(source)
    screen('任务确认', step=1)
    ui.context(console, 录像=source, 输出=folder, 模式='高能剪辑' if mode == 'damage' else '复盘剪辑')
    overwrite = False
    if any((folder / name).exists() for name in ('clips.json', 'events.json', 'analysis.html')):
        overwrite = ask(q.confirm('输出目录已有分析结果，是否覆盖？', default=False))
        if not overwrite:
            raise ui.ReturnHome()
    if not ask(q.confirm('开始分析？', default=True)):
        raise ui.ReturnHome()
    return source, folder, params, overwrite


def wizard():
    global interactive
    interactive = True
    try:
        # Keep the shell's existing output intact; always restore it on exit.
        with console.screen():
            while True:
                try:
                    screen('主菜单', '选择一项开始；每个任务的结果与日志独立保存。')
                    action = ask(ui.select('主菜单', choices=[
                        q.Choice('一键集锦     自动分析并导出全部候选', value='auto'),
                        q.Choice('高级剪辑     检测候选，预览后选择导出', value='analyze'),
                        q.Choice('已有结果     打开 clips.json，查看或继续导出', value='open'),
                        q.Choice('运行环境     检查 FFmpeg 与 ffprobe', value='doctor')]))
                    if action == 'doctor':
                        screen('运行环境')
                        doctor()
                        pause()
                    elif action == 'open':
                        screen('打开已有结果', '无需重新分析，可继续预览和导出。')
                        result = input_path('clips.json 路径：').resolve()
                        result_page(result)
                    else:
                        source, folder, params, overwrite = configure_task()
                        screen('正在分析', 'Ctrl+C 取消当前任务；运行详情写入任务日志。', 2)
                        ui.context(console, 录像=source.name, 输出=folder)
                        result = do_analyze(source, folder, params, overwrite)
                        if action == 'auto':
                            wizard_export(result, auto=True)
                        result_page(result)
                except ui.ReturnHome:
                    continue
                except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
                    screen('任务未完成', '检查下面的原因后，可返回主菜单重新操作。')
                    console.print(str(error), style='red', markup=False)
                    report_log()
                    try:
                        pause()
                    except ui.ReturnHome:
                        pass
                except typer.Exit as error:
                    if error.exit_code != 0:
                        pause()
    except ui.QuitApplication:
        return
    finally:
        interactive = False


def valid_number(text, cast):
    import math
    try:
        return True if math.isfinite(cast(text)) else '请输入有限数值'
    except ValueError:
        return '请输入有效数字'


@app.callback()
def entry(ctx: typer.Context):
    if ctx.invoked_subcommand is None:
        if sys.stdin.isatty() and sys.stdout.isatty():
            with errors():
                wizard()
        else:
            console.print(ctx.get_help())


def main():
    app()


if __name__ == '__main__':
    main()
