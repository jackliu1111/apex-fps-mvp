"""Dependency-free audio energy plots for the terminal and offline reports."""
from html import escape
import math

import numpy as np
from rich.text import Text


def summarize(rms, frame_seconds, limit=12000):
    """Keep each bucket's extrema at their original times, preserving brief peaks."""
    stride = max(1, math.ceil(len(rms) / (limit // 2)))
    points = []
    for start in range(0, len(rms), stride):
        block = rms[start:start + stride]
        for offset in sorted(set((int(np.argmin(block)), int(np.argmax(block))))):
            points.append([round((start + offset) * frame_seconds, 6),
                           round(float(block[offset]), 3)])
    return {'points': points, 'frame_seconds': frame_seconds,
            'bucket_seconds': stride * frame_seconds, 'unit': 'dBFS'}


def bounds(points, threshold):
    values = [p[1] for p in points] + [threshold]
    return min(-60, math.floor(min(values) / 10) * 10), max(0, math.ceil(max(values) / 10) * 10)


def terminal_chart(console, data):
    audio = data.get('audio_curve')
    if not audio or not audio.get('points'):
        console.print('此结果未保存音频曲线；重新分析后可显示曲线和裁剪时间轴。', style='yellow')
        return
    points = audio['points']
    duration = data['duration_seconds']
    threshold = data['config']['threshold_dbfs']
    low, high = bounds(points, threshold)
    width = max(12, min(100, console.width - 12))
    height = 9
    columns = [[] for _ in range(width)]
    for time, value in points:
        columns[min(width - 1, int(time / duration * (width - 1)))].append(value)
    rows = [[' ' for _ in range(width)] for _ in range(height)]
    level = lambda value: min(height - 1, max(0, round((high - value) / (high - low) * (height - 1))))
    for x, values in enumerate(columns):
        if values:
            for y in range(level(max(values)), level(min(values)) + 1):
                rows[y][x] = '●' if y == level(max(values)) else '│'
    console.print('\n音频能量曲线 / dBFS', style='bold cyan')
    for y, row in enumerate(rows):
        line = Text(f'{high - y * (high-low)/(height-1):6.0f} ┤')
        for x, char in enumerate(row):
            t = x / (width - 1) * duration
            selected = any(c['start'] <= t <= c['end'] for c in data['clips'])
            line.append(char if char != ' ' or y != level(threshold) else '┄',
                        'cyan on #163d3a' if selected else 'cyan')
        console.print(line)
    console.print('       └' + '─' * width)
    labels = [' '] * width
    for frac in (0, .5, 1):
        label = f'{duration * frac:.1f}s'
        pos = min(width - len(label), max(0, round(frac * (width - 1)) - len(label)//2))
        labels[pos:pos + len(label)] = label
    console.print('        ' + ''.join(labels))
    for i, clip in enumerate(data['clips'], 1):
        left = min(width - 2, int(clip['start'] / duration * (width - 1)))
        right = min(width - 1, max(left + 1, round(clip['end'] / duration * (width - 1))))
        console.print(Text('        ' + ' ' * left + '├' + '─' * (right-left-1) + '┤', style='green'))
        console.print(f"        #{i}  {clip['start']:.3f}s → {clip['end']:.3f}s", style='green')
    console.print(f'虚线：检测阈值 {threshold:.1f} dBFS；绿色：候选裁剪范围（含缓冲）。')


def svg_chart(data, start, end, clips):
    points = data['audio_curve']['points']
    threshold = data['config']['threshold_dbfs']
    low, high = bounds(points, threshold)
    x = lambda t: 76 + (t-start)/(end-start)*1048
    y = lambda v: 220 - (v-low)/(high-low)*184
    parts = ['<svg viewBox="0 0 1200 330" role="img" aria-label="音频能量与候选裁剪时间轴">']
    for value in np.linspace(low, high, 5):
        parts.append(f'<path d="M76 {y(value):.2f}H1124" class="grid"/><text x="65" y="{y(value)+4:.2f}" text-anchor="end">{value:.0f}</text>')
    parts.append('<text x="76" y="20">音频能量 / dBFS</text>')
    for i, clip in clips:
        a, b = max(start, clip['start']), min(end, clip['end'])
        parts.append(f'<a href="#clip-{i}"><rect x="{x(a):.2f}" y="36" width="{x(b)-x(a):.2f}" height="184" class="range"><title>#{i}: {clip["start"]:.3f}s – {clip["end"]:.3f}s</title></rect></a>')
        ra, rb = max(a, clip['raw_start']), min(b, clip['raw_end'])
        if rb > ra:
            parts.append(f'<rect x="{x(ra):.2f}" y="36" width="{x(rb)-x(ra):.2f}" height="184" class="core"/>')
    visible = [(t, v) for t, v in points if start <= t <= end]
    coords = ' '.join(f'{x(t):.2f},{y(v):.2f}' for t, v in visible)
    parts.append(f'<polyline points="{coords}" class="curve"/>')
    parts.append(f'<path d="M76 {y(threshold):.2f}H1124" class="threshold"/>')
    parts.append('<path d="M76 36V220H1124" class="axis"/>')
    for time in np.linspace(start, end, 6):
        parts.append(f'<path d="M{x(time):.2f} 220v6" class="axis"/><text x="{x(time):.2f}" y="245" text-anchor="middle">{time:.1f}s</text>')
    # Detail plots put both exact cut points directly on the time axis.
    if len(clips) == 1:
        i, clip = clips[0]
        for time, anchor, row, name in ((clip['start'], 'start', 280, '开始'), (clip['end'], 'end', 308, '结束')):
            parts.append(f'<path d="M{x(time):.2f} 36V{row-14}" class="boundary"/><text x="{x(time):.2f}" y="{row}" text-anchor="{anchor}" class="cut-label">{name} {time:.3f}s</text>')
    parts.append('</svg>')
    return ''.join(parts)


def html_report(data):
    title = escape(data['input'])
    duration = data['duration_seconds']
    clips = list(enumerate(data['clips'], 1))
    content = [f'<h1>音频候选分析</h1><p class="source">{title}</p>',
               f'<p>{duration:.3f} 秒 · {len(clips)} 个候选 · 检测阈值 {data["config"]["threshold_dbfs"]:.1f} dBFS</p>',
               '<p>青色曲线：音频 RMS 能量 · 橙色虚线：检测阈值 · 绿色区域：候选裁剪范围（含前后缓冲） · 深绿色：事件聚类范围</p>',
               '<p>时间轴为源录像秒数。曲线按区间保留极值；快速导出的实际切点受关键帧影响。</p>',
               '<h2>全片概览</h2><p>点击绿色区间或下方编号查看局部曲线。</p>',
               '<nav>' + ' '.join(f'<a href="#clip-{i}">#{i} · {c["start"]:.3f}–{c["end"]:.3f}s</a>' for i, c in clips) + '</nav>',
               '<div class="plot">' + svg_chart(data, 0, duration, clips) + '</div>']
    if not clips:
        content.append('<p>未发现候选片段，仍可查看完整音频能量曲线。</p>')
    for i, clip in clips:
        pad = max(2, (clip['end']-clip['start']) * .12)
        content.append(f'<section id="clip-{i}"><h2>#{i} · {clip["start"]:.3f}–{clip["end"]:.3f}s</h2><p>时长 {clip["end"]-clip["start"]:.3f} 秒 · {clip["event_count"]} 个事件</p><div class="plot">')
        content.append(svg_chart(data, max(0, clip['start']-pad), min(duration, clip['end']+pad), [(i, clip)]))
        content.append('</div><a href="#top">返回概览 ↑</a></section>')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>音频候选分析</title>
<style>body{margin:0;background:#0c1422;color:#dce7f6;font:15px system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:32px 24px}h1{font-size:30px}h2{font-size:20px}p{color:#aabbd0;line-height:1.7}.source{overflow-wrap:anywhere}section{margin-top:28px;padding-top:16px;border-top:1px solid #28364a;scroll-margin-top:20px}.plot{overflow-x:auto;background:#121f31;border:1px solid #28364a;border-radius:14px;margin:16px 0}svg{display:block;width:100%;min-width:760px}svg text{fill:#aabbd0;font:13px system-ui,sans-serif}.grid{stroke:#26364b}.axis{fill:none;stroke:#657a93}.range{fill:#36cda0;fill-opacity:.16}.core{fill:#36cda0;fill-opacity:.14;pointer-events:none}.curve{fill:none;stroke:#64d8ed;stroke-width:1.3;pointer-events:none}.threshold{stroke:#f2b66b;stroke-dasharray:6 5}.boundary{stroke:#59d8a7;stroke-dasharray:4 4}.cut-label{fill:#72e9b8;font-weight:600}a{color:#72e9b8}nav{display:flex;gap:12px;flex-wrap:wrap}nav a{padding:8px 12px;background:#17342f;border-radius:8px;text-decoration:none}</style>
<main id="top">''' + ''.join(content) + '</main></html>'
