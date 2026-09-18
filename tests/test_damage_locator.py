import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from damage_detector import analyze_video, read_located_counter
from damage_locator import Anchor, HudLocator, Matcher, resize
from damage_detector import BANKS


class LocatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with np.load(Path(__file__).parent/'data/damage_hud.npz') as data:
            cls.frames = data['frames'].copy()
            cls.expected = data['expected'].copy()

    def canvas(self, index, width, height, scale, x, y):
        frame = np.full((height, width, 3), 35, np.uint8)
        hud = resize(self.frames[index], round(90*scale), round(200*scale)).astype(np.uint8)
        frame[y:y+len(hud), x:x+hud.shape[1]] = hud
        return frame

    def test_ncc_matches_direct_calculation(self):
        rng = np.random.default_rng(8)
        frame = rng.uniform(0, 255, (27, 33)).astype(np.float32)
        template = frame[9:16, 11:20].copy()
        scores = Matcher(frame).scores(template)
        self.assertEqual((9, 11), np.unravel_index(scores.argmax(), scores.shape))
        patch = frame[3:10, 7:16]
        a, b = patch-patch.mean(), template-template.mean()
        self.assertAlmostEqual(float((a*b).sum()/np.sqrt((a*a).sum()*(b*b).sum())),
                               float(scores[3, 7]), places=5)
        self.assertTrue(np.isfinite(Matcher(np.zeros((20, 30))).scores(template)).all())

    def test_existing_real_hud_and_negative_samples(self):
        for frame, value in zip(self.frames, self.expected):
            with self.subTest(value=value):
                anchor = HudLocator(30).locate(frame, 0)
                actual = read_located_counter(frame, anchor) if anchor else None
                self.assertEqual(None if value < 0 else value, actual)

    def test_resolution_position_and_aspect_ratio(self):
        # Deliberately vary placement independently of screen proportions.
        cases = [(3840, 2160, 1., 3100, 230), (2560, 1440, 2/3, 2050, 140),
                 (1920, 1080, .5, 800, 500), (1280, 720, 1/3, 900, 100),
                 (2560, 1080, .5, 2000, 80), (720, 1280, .5, 400, 600),
                 (1280, 720, 1.5, 700, 300)]
        for width, height, scale, x, y in cases:
            with self.subTest(size=(width, height), scale=scale):
                frame = self.canvas(2, width, height, scale, x, y)
                anchor = HudLocator(30).locate(frame, 0)
                self.assertIsNotNone(anchor)
                self.assertAlmostEqual(x+26*scale, anchor.x, delta=4)
                self.assertAlmostEqual(y+20*scale, anchor.y, delta=3)
                self.assertAlmostEqual(scale, anchor.scale, delta=.06)
                self.assertEqual(103, read_located_counter(frame, anchor))

    def test_tracking_relocation_and_unknown(self):
        locator = HudLocator(4)
        frame = self.canvas(2, 640, 360, .5, 400, 40)
        self.assertIsNotNone(locator.locate(frame, 0))
        shifted = self.canvas(3, 640, 360, .5, 400, 40)
        anchor = locator.locate(shifted, 1)
        self.assertEqual(117, read_located_counter(shifted, anchor))
        self.assertEqual(1, locator.searches)
        self.assertIsNone(locator.locate(np.zeros_like(frame), 2))
        moved = self.canvas(2, 640, 360, .5, 100, 220)
        self.assertIsNone(locator.locate(moved, 3))
        anchor = locator.locate(moved, 4)
        self.assertIsNotNone(anchor)
        self.assertEqual(103, read_located_counter(moved, anchor))

    def test_ambiguous_duplicate_icons_rejected(self):
        frame = self.canvas(2, 640, 360, 1., 50, 30)
        frame[200:290, 400:600] = self.frames[2]
        self.assertIsNone(HudLocator(30).locate(frame, 0))

    def test_four_and_five_digits_without_prefix_truncation(self):
        for digits in ([1, 0, 1, 0], [1, 0, 1, 0, 1]):
            frame = np.zeros((100, 260, 3), np.uint8)
            for i, digit in enumerate(digits):
                frame[24:54, 90+i*22:110+i*22] = BANKS['white_180'][digit][:, :, None]*255
            anchor = Anchor(20, 20, 1., 1.)
            self.assertEqual(int(''.join(map(str, digits))), read_located_counter(frame, anchor))
        # Cut through a final glyph; never accept the intact prefix as the count.
        self.assertIsNone(read_located_counter(frame[:, :190], anchor))

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_non_16_9_video_events_and_localization_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'portrait.mkv'
            frames = [self.canvas(i, 360, 640, .5, 220, 80) for i in [2, 2, 3, 3]]
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', '360x640', '-r', '4', '-i', '-', '-c:v', 'ffv1',
                            '-y', str(source)], input=np.stack(frames).tobytes(), check=True)
            media = {'streams': [{'codec_type': 'video', 'width': 360, 'height': 640}],
                     'duration_seconds': 1.}
            events, clips, readings, stats = analyze_video(source, media, fps=4)
            self.assertEqual([(103, 117)], [(e['previous'], e['value']) for e in events])
            self.assertEqual(.5, events[0]['time'])
            self.assertEqual(1, len(clips))
            self.assertEqual(4, stats['readable_frames'])
            self.assertEqual(4, stats['localization']['located_frames'])
            self.assertEqual('multiscale_icon_ncc', stats['localization']['method'])


if __name__ == '__main__':
    unittest.main()
