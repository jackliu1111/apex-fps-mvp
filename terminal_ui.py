"""Small, page-based terminal presentation shared by the interactive wizard."""
from prompt_toolkit.key_binding import KeyBindings, merge_key_bindings
from prompt_toolkit.layout import HSplit, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.styles import Style, merge_styles
import questionary as q
from rich import box
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from dataclasses import dataclass, field
from pathlib import Path
from prompt_toolkit.application import Application
from prompt_toolkit.data_structures import Point
from prompt_toolkit.layout import Layout


class ReturnHome(Exception):
    """Leave the current interactive page without exiting the application."""


class QuitApplication(Exception):
    """Exit the interactive wizard normally."""


class ReturnBack(ReturnHome):
    """Return to the parent screen; the root falls back to the home menu."""


STYLE = Style.from_dict({
    'qmark': '#5fd7d7', 'question': 'bold', 'answer': '#5fd7d7',
    'pointer': '#5fd7d7 bold', 'highlighted': '#5fd7d7 bold',
    'selected': '#5fd7d7', 'instruction': '', 'text': '',
})


def prepare_prompt(prompt):
    bindings = KeyBindings()

    @bindings.add('escape', eager=True)
    def home(event):
        event.app.exit(exception=ReturnBack())

    app = prompt.application
    menu = getattr(prompt, 'is_menu', False)
    if menu:
        @bindings.add('q', eager=True)
        @bindings.add('Q', eager=True)
        def quit_app(event):
            event.app.exit(exception=QuitApplication())

    hint = ('↑ ↓ 选择 · Enter 确认 · Esc 返回 · Q 退出' if menu
            else 'Esc 返回 · Ctrl+C 退出')
    app.layout.container = HSplit([
        app.layout.container,
        Window(height=1, content=FormattedTextControl([('class:instruction', hint)])),
    ])
    app.key_bindings = merge_key_bindings([app.key_bindings, bindings])
    app.style = merge_styles([app.style, STYLE])
    return prompt


def page(console, title, subtitle='', step=None):
    if console.is_terminal:
        console.clear()
    compact = console.height < 40
    if not compact:
        console.print()
    console.print('  A P E X  /  集锦助手', style='bold cyan')
    if not compact:
        console.print('  从录像中发现片段，挑选后生成集锦', style='dim')
        console.print()
    if step and console.width >= 60:
        trail = Text('  ')
        for i, label in enumerate(('任务设置', '分析录像', '查看与选择', '导出集锦'), 1):
            if i > 1:
                trail.append('  ›  ', 'dim')
            trail.append(label, 'bold cyan' if i == step else 'dim')
        console.print(trail)
    console.rule(Text(title, style='bold'), style='bright_black', align='left')
    if subtitle:
        console.print(Text(subtitle, style='dim'))
    if not compact:
        console.print()


def select(message, choices, **kwargs):
    prompt = q.select(message, choices=choices, instruction=' ', pointer='›', **kwargs)
    prompt.is_menu = True
    return prompt


def context(console, **fields):
    grid = Table.grid(padding=(0, 2), expand=True)
    grid.add_column(style='dim', width=8, ratio=0)
    grid.add_column(overflow='ellipsis', no_wrap=True, ratio=1)
    for key, value in fields.items():
        grid.add_row(Text(key), Text(str(value)))
    console.print(Panel(grid, border_style='bright_black', padding=(0, 1)))


def candidates(console, data, index=0):
    size = max(1, min(8, console.height - 23))
    clips = data['clips']
    pages = max(1, (len(clips) + size - 1) // size)
    index = min(index, pages - 1)
    table = Table(box=box.SIMPLE, expand=True, padding=(0, 1))
    for name in ('编号', '开始 / 秒', '结束 / 秒', '时长 / 秒', '事件'):
        table.add_column(name, justify='right', style='cyan' if name == '编号' else None)
    for i, clip in enumerate(clips[index * size:(index + 1) * size], index * size + 1):
        table.add_row(str(i), f"{clip['start']:.3f}", f"{clip['end']:.3f}",
                      f"{clip['end'] - clip['start']:.3f}", str(clip['event_count']))
    console.print(table)
    console.print(f'候选 {len(clips)} 个 · 第 {index + 1}/{pages} 页', style='dim')
    return index, pages


@dataclass
class ReviewState:
    selected: set = field(default_factory=set)
    cursor: int = 0


def review_app(data, state, *, eligible=True, preview=False, curve=False, input=None, output=None):
    """One resizable keyboard view owns both candidate details and selection."""
    clips = data['clips']
    state.cursor = max(0, min(state.cursor, len(clips)-1))
    keys = KeyBindings()
    notice = ['']
    app = None

    def header():
        mode = '伤害增长片段' if data.get('config', {}).get('selection_signal') == 'damage_counter_growth' else '音频片段'
        return [('bold', 'APEX / 查看与选择'), ('', f"\n{Path(data['input']).name}\n{mode} · 源录像时间 / 秒")]

    def status():
        duration = sum(clips[i-1]['end']-clips[i-1]['start'] for i in state.selected)
        position = f'{state.cursor+1}/{len(clips)}' if clips else '0/0'
        return f'当前 {position} · 已选 {len(state.selected)} 个 · {duration:.1f} 秒'

    def rows():
        if not clips:
            return [('', '未发现候选片段。可按 C 查看曲线，或 M 查看检测说明。')]
        width = app.output.get_size().columns
        lines = []
        for i, c in enumerate(clips, 1):
            marker = '[x]' if i in state.selected else '[ ]'
            lead = '›' if i-1 == state.cursor else ' '
            # Narrow terminals use a compact row; exact details remain below.
            if width < 70:
                label = f'{lead} {marker} {i:>3}  {c["start"]:.3f}–{c["end"]:.3f}'
            else:
                label = (f'{lead} {marker} {i:>3}  {c["start"]:>10.3f} → {c["end"]:>10.3f}'
                         f'  {c["end"]-c["start"]:>7.3f}s  {c["event_count"]:>4}次')
            lines.append(('bold reverse' if i-1 == state.cursor else '', label + ('\n' if i < len(clips) else '')))
        return lines

    def detail():
        if not clips:
            return '分析结果已保存；可调整参数重新分析。'
        c = clips[state.cursor]
        return (f"#{state.cursor+1} · 时长 {c['end']-c['start']:.3f}s · 事件 {c['event_count']} 次"
                + (' · 超过建议时长' if c.get('exceeds_max_duration') else ''))

    def footer():
        text = '↑↓ 移动 · PgUp/PgDn 翻页'
        if eligible and clips:
            text += '\n空格 勾选 · A 全选/全不选 · E 导出'
        actions = []
        if preview:
            actions.append('P 编号预览')
        if curve:
            actions.append('C 曲线')
        text += '\n' + ' · '.join(actions + ['M 更多', 'Esc 返回', 'Q 退出'])
        return text

    def move(delta):
        state.cursor = max(0, min(len(clips)-1, state.cursor+delta))

    @keys.add('up')
    def up(event): move(-1)

    @keys.add('down')
    def down(event): move(1)

    @keys.add('pageup')
    def pageup(event): move(-max(1, listing.render_info.window_height if listing.render_info else 1))

    @keys.add('pagedown')
    def pagedown(event): move(max(1, listing.render_info.window_height if listing.render_info else 1))

    @keys.add('home')
    def home(event): state.cursor = 0

    @keys.add('end')
    def end(event): state.cursor = max(0, len(clips)-1)

    @keys.add(' ')
    def toggle(event):
        if eligible and clips:
            i = state.cursor+1
            state.selected.symmetric_difference_update({i})
            notice[0] = ''

    @keys.add('a')
    @keys.add('A')
    def all_clips(event):
        if eligible:
            state.selected = set() if len(state.selected) == len(clips) else set(range(1, len(clips)+1))
            notice[0] = ''

    @keys.add('e')
    @keys.add('E')
    def export(event):
        if eligible and state.selected:
            event.app.exit(result='export')
        else:
            notice[0] = '请先用空格勾选片段。' if eligible else '旧结果仅供查看，请重新分析后导出。'

    for key, action, enabled in [('p', 'preview', preview), ('c', 'curve', curve), ('m', 'more', True)]:
        if enabled:
            def finish(event, action=action): event.app.exit(result=action)
            keys.add(key)(finish)
            keys.add(key.upper())(finish)

    @keys.add('escape')
    def back(event): event.app.exit(result='back')

    @keys.add('q')
    @keys.add('Q')
    def quit_app(event): event.app.exit(exception=QuitApplication())

    @keys.add('c-c')
    def cancel(event): event.app.exit(exception=KeyboardInterrupt())

    control = FormattedTextControl(rows, focusable=True,
                                   get_cursor_position=lambda: Point(x=0, y=state.cursor))
    listing = Window(control, wrap_lines=False)
    layout = HSplit([
        Window(FormattedTextControl(header), height=3, wrap_lines=False),
        Window(FormattedTextControl(status), height=1),
        Window(FormattedTextControl('选择  编号       开始 → 结束 / 秒       时长    事件'), height=1),
        listing,
        Window(FormattedTextControl(detail), height=1),
        Window(FormattedTextControl(lambda: notice[0] or ('' if eligible else '旧结果仅供查看，请重新分析后导出。')), height=1),
        Window(FormattedTextControl(footer), height=4, wrap_lines=True),
    ], height=lambda: max(1, app.output.get_size().rows-1))
    app = Application(layout=Layout(layout, focused_element=control), key_bindings=keys,
                      full_screen=False, erase_when_done=True, input=input, output=output)
    return app
