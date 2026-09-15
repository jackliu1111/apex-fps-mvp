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


class ReturnHome(Exception):
    """Leave the current interactive page without exiting the application."""


class QuitApplication(Exception):
    """Exit the interactive wizard normally."""


STYLE = Style.from_dict({
    'qmark': '#5fd7d7', 'question': 'bold', 'answer': '#5fd7d7',
    'pointer': '#5fd7d7 bold', 'highlighted': '#5fd7d7 bold',
    'selected': '#5fd7d7', 'instruction': '#808080', 'text': '',
})


def prepare_prompt(prompt):
    bindings = KeyBindings()

    @bindings.add('escape', eager=True)
    def home(event):
        event.app.exit(exception=ReturnHome())

    app = prompt.application
    menu = getattr(prompt, 'is_menu', False)
    if menu:
        @bindings.add('q', eager=True)
        @bindings.add('Q', eager=True)
        def quit_app(event):
            event.app.exit(exception=QuitApplication())

    hint = ('↑ ↓ 选择 · Enter 确认 · Esc 主菜单 · Q 退出' if menu
            else 'Esc 主菜单 · Ctrl+C 退出')
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
    compact = console.height < 32
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


def select(message, choices):
    prompt = q.select(message, choices=choices, instruction=' ', pointer='›')
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
