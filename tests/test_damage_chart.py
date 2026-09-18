import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rich.console import Console
from typer.testing import CliRunner

import damage_chart
import highlight_cli as cli
import highlight_service as service


def example():
    return {'input': '录像.mkv', 'duration_seconds': 8., 'analysis_id': 'test-axis',
            'config': {'selection_signal': 'damage_counter_growth'}, 'clips': [],
            'damage_readings': [{'time': t, 'value': v} for t, v in
                                [(0., None), (2., 64), (3., 89), (3.4, 103),
                                 (3.433, 117), (4., None), (5., 160), (6., 10), (7., 20)]],
            'damage_events': [{'time': 3., 'previous': 64, 'value': 89, 'increase': 25},
                              {'time': 3.433, 'previous': 89, 'value': 117, 'increase': 28},
                              {'time': 7., 'previous': 10, 'value': 20, 'increase': 10}]}


class DamageChartTests(unittest.TestCase):
    def test_unknown_and_reset_do_not_invent_growth(self):
        data = example()
        spans = list(damage_chart.segments(data, 3.9, 6.5))
        self.assertEqual([(3.9, 4., 117), (4., 5., None), (5., 6., 160), (6., 6.5, 10)], spans)
        rows = list(damage_chart.changes(data, 0., 8.))
        self.assertIn('未确认增长', next(r for r in rows if r['value'] == 103)['detail'])
        self.assertIn('待两帧确认基线', next(r for r in rows if r['value'] == 160)['detail'])
        self.assertIn('下降 / 重置', next(r for r in rows if r['time'] == 6.)['detail'])
        self.assertEqual(3, sum('确认增长 ' in r['detail'] for r in rows))

    def test_short_unknown_gap_and_spike_survive_overview(self):
        data = example()
        data['damage_readings'] = [{'time': t, 'value': v} for t, v in
                                   [(0, 10), (100.1, 100), (100.11, 10),
                                    (500.1, None), (500.11, 10), (800, 0)]]
        data['duration_seconds'] = 1000.
        grid, state, _, _, top = damage_chart.raster(data, 0, 1000, 100, 8)
        self.assertEqual(100, top)
        self.assertNotEqual(' ', grid[0][10])
        self.assertEqual('~', state[50])
        self.assertTrue(any(row[50] == '•' for row in grid))
        self.assertEqual('R', state[80])
        # Reset to zero has endpoints only, no misleading continuous fall.
        self.assertTrue(all(grid[y][80] == ' ' for y in range(1, 6)))

    def test_frequent_unknowns_keep_observed_values_without_connecting_gaps(self):
        data = example()
        data['duration_seconds'] = 100.
        data['damage_readings'] = [{'time': t, 'value': v} for t, v in
                                   [(0, None), (1, 10), (2, None), (3, 90), (4, None),
                                    (10, 20), (11, None), (12, 80), (13, None),
                                    (90, 30), (91, None)]]
        grid, state, _, _, _ = damage_chart.raster(data, 0, 100, 10, 10)
        self.assertEqual('~', state[0])
        self.assertEqual(2, sum(row[0] == '•' for row in grid))
        self.assertTrue(all(row[0] in ('•', ' ') for row in grid))
        self.assertEqual('?', state[5])
        self.assertTrue(all(row[5] == ' ' for row in grid))
        # Only two actually observed values appear, not an invented 10..90 line.
        self.assertEqual(2, sum(row[1] == '•' for row in grid))

    def test_legacy_evidence_matches_analysis_and_does_not_modify_files(self):
        with tempfile.TemporaryDirectory() as folder:
            result = Path(folder)/'clips.json'
            data = example()
            readings, events = data.pop('damage_readings'), data.pop('damage_events')
            result.write_text(json.dumps(data))
            sidecar = result.with_name('events.json')
            sidecar.write_text(json.dumps({'analysis_id': data['analysis_id'],
                                           'damage_readings': readings, 'events': events}))
            original = result.read_bytes()
            loaded = damage_chart.with_evidence(data, result)
            self.assertEqual(readings, loaded['damage_readings'])
            self.assertEqual(events, loaded['damage_events'])
            self.assertEqual(original, result.read_bytes())
            self.assertNotIn('damage_readings', data)
            sidecar.write_text(json.dumps({'analysis_id': 'another-run'}))
            rejected = damage_chart.with_evidence(data, result)
            self.assertEqual([], rejected['damage_readings'])
            self.assertIn('不属于同一次分析', rejected['damage_timeline_note'])

    def test_command_range_and_exact_values(self):
        with tempfile.TemporaryDirectory() as folder:
            result = Path(folder)/'clips.json'
            result.write_text(json.dumps(example()))
            response = CliRunner().invoke(cli.app, ['damage-axis', str(result), '--start', '3', '--end', '4'])
            self.assertEqual(0, response.exit_code, response.exception)
            self.assertIn('伤害数字轴', response.stdout)
            self.assertIn('3.433', response.stdout)
            self.assertIn('89 → 117 (+28)', response.stdout)
            self.assertIn('103', response.stdout)
            self.assertIn('未确认增长', response.stdout)
            bad = CliRunner().invoke(cli.app, ['damage-axis', str(result), '--end', '9'])
            self.assertEqual(1, bad.exit_code)
            inspected = CliRunner().invoke(cli.app, ['inspect', str(result)])
            self.assertIn('伤害数字轴', inspected.stdout)

    def test_small_terminal_and_empty_data(self):
        stream = io.StringIO()
        console = Console(file=stream, width=48, height=24, color_system=None)
        damage_chart.terminal_chart(console, example(), height=3)
        self.assertLessEqual(len(stream.getvalue().splitlines()), 13)
        self.assertIn('R=下降/重置', stream.getvalue())
        data = example()
        data['damage_readings'] = []
        damage_chart.terminal_chart(console, data)
        self.assertIn('没有伤害读数', stream.getvalue())
        data['damage_readings'] = [{'time': 0, 'value': None}]
        damage_chart.terminal_chart(console, data)
        self.assertIn('?', stream.getvalue())

    def test_result_menu_event_navigation_and_details_return(self):
        data = example()
        prompts = []
        def prompt(message, choices):
            prompts.append((message, choices))
            return object()
        with patch.object(service, 'load_result', return_value=data), \
             patch.object(cli, 'console', Console(file=io.StringIO(), width=80, height=24)), \
             patch.object(cli.ui, 'select', side_effect=prompt), \
             patch.object(cli.ui, 'review_app') as review, \
             patch.object(cli, 'ask', side_effect=['下一次增长', '查看读数明细',
                                                  '下一页', '返回时间轴', '上一次增长',
                                                  '返回结果页']):
            review.return_value.run.side_effect = ['curve', 'back']
            cli.result_page(Path('/tmp/damage-axis-test/clips.json'))
        self.assertTrue(review.call_args.kwargs['curve'])
        self.assertEqual('时间轴操作', prompts[-1][0])
        self.assertEqual(2, review.return_value.run.call_count)


if __name__ == '__main__':
    unittest.main()
