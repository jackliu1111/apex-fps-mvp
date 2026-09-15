import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from typer.testing import CliRunner
import apex_highlight as core
import highlight_service as service
from highlight_cli import app, choose_clips
import media_runtime


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='apex 中文 ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / '录像 space.mkv'
        self.source.write_bytes(b'video fixture')
        self.folder = self.root / 'result'
        self.rms = np.full(800, -40., dtype=np.float32)
        self.rms[[40, 80, 120, 160, 440, 480, 520, 560]] = -5.
        self.params = service.Parameters(before_s=.2, after_s=.2, fight_gap_s=1.1)

    def analyze(self, rms=None):
        with patch.object(core, 'require_tools'), patch.object(core, 'probe_media', return_value={'duration_seconds': 20}), \
             patch.object(core, 'stream_frame_rms_dbfs', return_value=self.rms if rms is None else rms):
            return service.analyze(self.source, self.folder, self.params)

    def test_same_detector_results_and_metadata(self):
        result = self.analyze()
        data = service.load_result(result)
        _, events = core.detect_events(self.rms, frame_ms=25, threshold_percentile=96, event_bridge_ms=200)
        expected = core.cluster_events(events, duration=20, fight_gap_s=1.1,
            min_events=4, before_s=.2, after_s=.2, max_clip_s=60)
        self.assertEqual([(c.start, c.end) for c in expected], [(c['start'], c['end']) for c in data['clips']])
        self.assertEqual(2, len(data['clips']))
        self.assertEqual(service.identity(self.source), data['source'])
        self.assertIn('audio_curve', data)
        self.assertTrue((self.folder / 'analysis.html').is_file())
        inspected = CliRunner().invoke(app, ['inspect', str(result)])
        self.assertEqual(0, inspected.exit_code, inspected.exception)
        self.assertIn('音频能量曲线', inspected.stdout)
        with self.assertRaises(FileExistsError):
            self.analyze()

    def test_selection_relocation_order_and_immutable_candidates(self):
        result = self.analyze()
        original = result.read_bytes()
        moved = self.root / '搬迁 录像.mkv'
        self.source.rename(moved)
        def render(source, clips, output, work, progress=None):
            self.assertEqual(moved.resolve(), source)
            self.assertEqual([.8, 10.8], [c.start for c in clips])
            output.write_bytes(b'valid movie')
        with patch.object(core, 'render_fast_montage', side_effect=render):
            output = service.export_result(result, [2, 1, 2], source=moved)
        self.assertEqual(original, result.read_bytes())
        self.assertEqual([1, 2], json.loads((self.folder / 'selection.json').read_text())['clips'])
        self.assertEqual(b'valid movie', output.read_bytes())
        with self.assertRaises(FileExistsError):
            service.export_result(result, source=moved)

    def test_source_mismatch_legacy_invalid_selection(self):
        result = self.analyze()
        self.source.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, '不匹配'):
            service.export_result(result)
        data = service.load_result(result)
        for text in ('0', '3', '', 'a', '-1', '1,'):
            with self.assertRaises(ValueError):
                service.selected_ids(data, text)
        data.pop('source')
        result.write_text(json.dumps(data))
        service.load_result(result)
        with self.assertRaisesRegex(ValueError, '旧结果'):
            service.export_result(result)

    def test_empty_and_all_deselected(self):
        result = self.analyze(np.full(800, -40.))
        with patch.object(core, 'render_fast_montage') as render:
            self.assertIsNone(service.export_result(result))
            self.assertIsNone(service.export_result(result, []))
            render.assert_not_called()

    def test_source_and_metadata_never_overwritten(self):
        result = self.analyze()
        alias = self.root / 'alias.mp4'
        os.link(self.source, alias)
        for output in (self.source, alias, result, self.folder / 'events.json', self.folder / 'selection.json'):
            with self.assertRaises(ValueError):
                service.export_result(result, output=output, overwrite=True)

    def test_failure_and_interrupt_clean_staging_preserve_existing(self):
        result = self.analyze()
        output = self.folder / 'apex_montage.mp4'
        output.write_bytes(b'old movie')
        for error in (RuntimeError('ffmpeg error'), KeyboardInterrupt()):
            def fail(source, clips, temp, work, progress=None):
                temp.write_bytes(b'incomplete')
                raise error
            with patch.object(core, 'render_fast_montage', side_effect=fail):
                with self.assertRaises(type(error)):
                    service.export_result(result, overwrite=True)
            self.assertEqual(b'old movie', output.read_bytes())
            self.assertFalse(list(self.folder.glob('.apex-export-*')))
            self.assertFalse((self.folder / 'selection.json').exists())

    def test_menu_default_checks_and_cancel_choice(self):
        result = self.analyze()
        with patch('highlight_cli.q.checkbox') as checkbox:
            checkbox.return_value.unsafe_ask.return_value = [2]
            self.assertEqual([2], choose_clips(service.load_result(result)))
            choices = checkbox.call_args.kwargs['choices']
            self.assertTrue(all(c.checked for c in choices))

    def test_noninteractive_help_and_errors(self):
        runner = CliRunner()
        self.assertIn('analyze', runner.invoke(app, []).stdout)
        outcome = runner.invoke(app, ['analyze', str(self.root / 'missing')])
        self.assertEqual(1, outcome.exit_code)
        self.assertIn('错误', outcome.stdout)
        self.assertNotIn('主菜单', outcome.stdout)

    def test_missing_tools_frozen_does_not_fall_back(self):
        with patch.object(media_runtime.sys, 'frozen', True, create=True), \
             patch.object(media_runtime.sys, 'executable', str(self.root / 'app')):
            with self.assertRaisesRegex(RuntimeError, '缺少媒体工具'):
                media_runtime.tool_path('ffmpeg')

    def test_actual_audio_progress_and_interrupt(self):
        import wave
        try:
            media_runtime.tool_path('ffmpeg')
        except RuntimeError:
            self.skipTest('FFmpeg unavailable')
        wav = self.root / '长音频.wav'
        with wave.open(str(wav), 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(16000)
            stream.writeframes(b'\0' * 16000 * 2 * 100)
        processes = []
        real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        samples = []
        def cancel(count):
            samples.append(count)
            raise KeyboardInterrupt()
        with patch.object(media_runtime.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(KeyboardInterrupt):
                core.stream_frame_rms_dbfs(wav, 16000, 25, progress=cancel)
        self.assertEqual([102400], samples)
        self.assertIsNotNone(processes[0].poll())


    def test_subprocess_stderr_failure_and_interrupt(self):
        script = self.root / 'fake'
        script.write_text('#!/bin/sh\nprintf "failure detail" >&2\nexit 7\n')
        script.chmod(0o755)
        with patch.object(media_runtime, 'tool_path', return_value=str(script)):
            with self.assertRaisesRegex(RuntimeError, 'failure detail'):
                media_runtime.run_command(['fake'])
        script.write_text('#!/bin/sh\nexec /bin/sleep 60\n')
        with patch.object(media_runtime, 'tool_path', return_value=str(script)):
            with self.assertRaises(KeyboardInterrupt):
                with media_runtime.media_process(['fake']) as process:
                    raise KeyboardInterrupt()
            self.assertIsNotNone(process.poll())


if __name__ == '__main__':
    unittest.main()
