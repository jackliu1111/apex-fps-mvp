"""Damage recognition evidence and a terminal step chart in source-video time."""
from bisect import bisect_right
import json
import math
from pathlib import Path

from rich import box
from rich.table import Table
from rich.text import Text


def with_evidence(data, result=None):
    """Older clips.json keeps evidence in its sibling events.json. Never rewrite it."""
    data = dict(data)
    if 'damage_readings' in data and 'damage_events' in data:
        return data
    if result is not None:
        try:
            evidence = json.loads(Path(result).with_name('events.json').read_text(encoding='utf-8'))
            if not data.get('analysis_id') or evidence.get('analysis_id') != data['analysis_id']:
                raise ValueError('events.json 与此分析结果不属于同一次分析')
            data['damage_readings'] = evidence['damage_readings']
            data['damage_events'] = evidence['events']
            return data
        except (OSError, ValueError, KeyError, TypeError) as error:
            data['damage_timeline_note'] = f'无法加载读数证据：{error}'
    data.setdefault('damage_readings', [])
    data.setdefault('damage_events', [])
    return data


def window(data, start=0., end=None):
    duration = float(data['duration_seconds'])
    end = duration if end is None else float(end)
    start = float(start)
    if not all(math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= duration:
        raise ValueError(f'时间范围须满足 0 ≤ 开始 < 结束 ≤ {duration:.3f} 秒')
    return start, end


def segments(data, start, end):
    """Piecewise constant raw reads. None remains a gap, never zero or a carry."""
    readings = data.get('damage_readings', [])
    times = [r['time'] for r in readings]
    index = bisect_right(times, start)-1
    value = readings[index]['value'] if index >= 0 else None
    cursor = start
    for reading in readings[index+1:]:
        time = reading['time']
        if time >= end:
            break
        if time > cursor:
            yield cursor, time, value
        cursor, value = time, reading['value']
    if cursor < end:
        yield cursor, end, value


def changes(data, start, end):
    events = {round(e['time'], 6): e for e in data.get('damage_events', [])}
    previous = None
    seen = False
    for reading in data.get('damage_readings', []):
        time, value = reading['time'], reading['value']
        event = events.get(round(time, 6))
        if value is None:
            detail = '无法识别；中断比较'
        elif event:
            detail = f"确认增长 {event['previous']} → {event['value']} (+{event['increase']})"
        elif previous is None:
            detail = '恢复读数；待两帧确认基线' if seen else '首次读数；待两帧确认基线'
        elif value < previous:
            detail = '下降 / 重置；重新建立基线'
        else:
            detail = '原始读数变化；未确认增长'
        if start <= time < end:
            yield {'time': time, 'value': value, 'detail': detail}
        previous = value
        seen = seen or value is not None


def raster(data, start, end, width, height):
    spans = list(segments(data, start, end))
    values = [v for _, _, v in spans if v is not None]
    top = max(1, max(values, default=0))
    grid = [[' ']*width for _ in range(height)]
    unknown, growth, cuts = [' ']*width, [' ']*width, [' ']*width
    known_rows = [set() for _ in range(width)]
    col = lambda t: max(0, min(width-1, int((t-start)/(end-start)*width)))
    row = lambda v: max(0, min(height-1, round((1-v/top)*(height-1))))
    for a, b, value in spans:
        left, right = col(a), max(col(a), min(width-1, math.ceil((b-start)/(end-start)*width)-1))
        for x in range(left, right+1):
            if value is None:
                unknown[x] = '?'
            else:
                grid[row(value)][x] = '─'
                known_rows[x].add(row(value))
    # Only join adjacent increasing raw reads. Never bridge a gap or reset.
    for before, after in zip(spans, spans[1:]):
        a, b = before[2], after[2]
        if a is not None and b is not None:
            x = col(after[0])
            if b >= a:
                for y in range(row(b), row(a)+1):
                    grid[y][x] = '│' if grid[y][x] == ' ' else '┼'
            elif unknown[x] != '?':
                unknown[x] = 'R'
    # A bucket may contain both valid reads and gaps. Preserve its observed
    # values as points, but remove connecting strokes: neither erase the whole
    # bucket nor imply a continuous read across its unknown samples.
    for x, marker in enumerate(unknown):
        if marker == '?':
            for y, line in enumerate(grid):
                line[x] = '•' if y in known_rows[x] else ' '
            if known_rows[x]:
                unknown[x] = '~'
    for event in data.get('damage_events', []):
        if start <= event['time'] < end:
            growth[col(event['time'])] = '+'
    for clip in data.get('clips', []):
        a, b = max(start, clip['start']), min(end, clip['end'])
        if a < b:
            for x in range(col(a), max(col(a)+1, min(width, math.ceil((b-start)/(end-start)*width)))):
                cuts[x] = '#'
    return grid, unknown, growth, cuts, top


def terminal_chart(console, data, start=0., end=None, height=7):
    start, end = window(data, start, end)
    console.print(f'伤害数字轴 · {start:.3f}–{end:.3f} 秒', style='bold cyan')
    if not data.get('damage_readings'):
        console.print(data.get('damage_timeline_note', '此结果没有伤害读数，请重新分析伤害模式。'),
                      style='yellow', markup=False)
        return
    max_value = max((v for _, _, v in segments(data, start, end) if v is not None), default=0)
    label_width = max(5, len(str(max_value)))
    width = max(12, min(110, console.width-label_width-3))
    height = max(3, height)
    grid, unknown, growth, cuts, top = raster(data, start, end, width, height)
    for i, line in enumerate(grid):
        label = str(round(top*(1-i/(height-1)))) if i in (0, height//2, height-1) else ''
        console.print(Text(f'{label:>{label_width}} │', style='dim') + Text(''.join(line), style='cyan'))
    prefix = ' '*(label_width+2)
    console.print(' '*label_width+' └'+'─'*width, style='dim')
    ticks = [' ']*width
    tick_values = [(0, start), (width-len(f'{end:.3f}s'), end)]
    if width >= 55:
        tick_values.insert(1, (width//2-5, (start+end)/2))
    for x, value in tick_values:
        label = f'{value:.3f}s'
        ticks[max(0, x):max(0, x)+len(label)] = label
    console.print(prefix+''.join(ticks), style='dim', markup=False)
    for label, lane, color in [('状态', unknown, 'yellow'), ('增长', growth, 'green'), ('候选', cuts, 'magenta')]:
        console.print(Text(' '*(label_width-4)+label+' │', style='dim')+Text(''.join(lane), style=color))
    console.print('─/•=原始读数（含短暂值） +=确认增长', style='dim', highlight=False)
    console.print('?=全未知 ~=部分未知 R=下降/重置 #=候选', style='dim', highlight=False)


def detail_table(console, data, start, end, page=0, size=6):
    rows = list(changes(data, start, end))
    pages = max(1, math.ceil(len(rows)/size))
    page = max(0, min(page, pages-1))
    table = Table(box=box.SIMPLE, expand=True, padding=(0, 1))
    table.add_column('源时间 / 秒', justify='right', no_wrap=True)
    table.add_column('读数', justify='right', no_wrap=True)
    table.add_column('识别状态')
    for item in rows[page*size:(page+1)*size]:
        table.add_row(f"{item['time']:.3f}", '未知' if item['value'] is None else str(item['value']),
                      item['detail'])
    console.print(table)
    console.print(f'读数变化 {len(rows)} 条 · 第 {page+1}/{pages} 页', style='dim')
    return page, pages
