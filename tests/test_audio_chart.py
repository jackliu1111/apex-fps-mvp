import io
import unittest

import numpy as np
from rich.console import Console

import audio_chart


class AudioChartTests(unittest.TestCase):
    def test_long_recording_preserves_peak_time_and_bounds_size(self):
        rms = np.full(200000, -60.)
        rms[137951] = -2.
        curve = audio_chart.summarize(rms, .025)
        self.assertLessEqual(len(curve['points']), 12000)
        self.assertIn([round(137951 * .025, 6), -2.], curve['points'])
        self.assertEqual(sorted(curve['points']), curve['points'])

    def test_report_exact_boundaries_and_escaped_source(self):
        data = {'input': '<script>alert(1)</script>.mkv', 'duration_seconds': 20,
                'config': {'threshold_dbfs': -20},
                'audio_curve': audio_chart.summarize(np.array([-40., -5., -40.]), 5),
                'clips': [{'start': 3.125, 'end': 8.75, 'raw_start': 5., 'raw_end': 6., 'event_count': 4}]}
        report = audio_chart.html_report(data)
        self.assertIn('开始 3.125s', report)
        self.assertIn('结束 8.750s', report)
        self.assertIn('href="#clip-1"', report)
        self.assertNotIn('<script>', report)
        stream = io.StringIO()
        audio_chart.terminal_chart(Console(file=stream, width=60), data)
        self.assertIn('3.125s → 8.750s', stream.getvalue())
        data['clips'] = []
        self.assertIn('未发现候选片段', audio_chart.html_report(data))
        data.pop('audio_curve')
        audio_chart.terminal_chart(Console(file=stream), data)
        self.assertIn('重新分析', stream.getvalue())
