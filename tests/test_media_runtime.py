from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import media_runtime


class WindowsToolDiscoveryTests(unittest.TestCase):
    def test_frozen_windows_tools_in_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='apex tools ') as folder:
            root = Path(folder)
            (root / 'bin').mkdir()
            tool = root / 'bin' / 'ffmpeg.exe'
            tool.touch()
            tool.chmod(0o755)
            with patch.object(media_runtime.sys, 'platform', 'win32'), \
                 patch.object(media_runtime.sys, 'frozen', True, create=True), \
                 patch.object(media_runtime.sys, 'executable', str(root / 'apex-highlight.exe')), \
                 patch.object(media_runtime.shutil, 'which') as which:
                self.assertEqual(str(tool), media_runtime.tool_path('ffmpeg'))
                self.assertEqual(str(tool), media_runtime.tool_path('ffmpeg.exe'))
                with self.assertRaises(RuntimeError):
                    media_runtime.tool_path('ffprobe')
                which.assert_not_called()

    def test_windows_ffmpeg_receives_nostdin(self):
        with patch.object(media_runtime, 'tool_path', return_value='C:/tools/ffmpeg.exe'), \
             patch.object(media_runtime.subprocess, 'Popen') as popen:
            popen.return_value.wait.return_value = 0
            popen.return_value.poll.return_value = 0
            with media_runtime.media_process(['ffmpeg', '-version']):
                pass
            self.assertEqual(['C:/tools/ffmpeg.exe', '-nostdin', '-version'], popen.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
