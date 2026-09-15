import unittest

import numpy as np

from apex_highlight import Event, cluster_events, detect_events


class DetectEventsTests(unittest.TestCase):
    def test_bridges_short_gaps_and_splits_long_gaps(self):
        rms = np.full(40, -40.0, dtype=np.float32)
        rms[[2, 3, 6, 20, 21]] = -5.0
        threshold, events = detect_events(
            rms,
            frame_ms=25.0,
            threshold_percentile=85.0,
            event_bridge_ms=50.0,
        )
        self.assertEqual(threshold, -40.0)
        self.assertEqual(len(events), 2)
        self.assertAlmostEqual(events[0].start, 0.05)
        self.assertAlmostEqual(events[0].end, 0.175)
        self.assertEqual(events[0].active_frames, 3)


class ClusterEventsTests(unittest.TestCase):
    def test_filters_clusters_adds_buffers_and_merges_overlaps(self):
        events = [
            Event(10.0, 10.1, -5.0, 1),
            Event(11.0, 11.1, -4.0, 1),
            Event(12.0, 12.1, -3.0, 1),
            Event(18.0, 18.1, -5.0, 1),
            Event(19.0, 19.1, -4.0, 1),
            Event(20.0, 20.1, -2.0, 1),
            Event(40.0, 40.1, -1.0, 1),
        ]
        clips = cluster_events(
            events,
            duration=100.0,
            fight_gap_s=2.0,
            min_events=3,
            before_s=5.0,
            after_s=8.0,
            max_clip_s=60.0,
        )
        self.assertEqual(len(clips), 1)
        self.assertEqual((clips[0].start, clips[0].end), (5.0, 28.1))
        self.assertEqual(clips[0].event_count, 6)
        self.assertEqual(clips[0].peak_dbfs, -2.0)

    def test_preserves_long_clip_and_marks_warning(self):
        events = [Event(float(i), float(i) + 0.1, -5.0, 1) for i in range(0, 70, 2)]
        clips = cluster_events(
            events,
            duration=100.0,
            fight_gap_s=3.0,
            min_events=3,
            before_s=5.0,
            after_s=8.0,
            max_clip_s=60.0,
        )
        self.assertEqual(len(clips), 1)
        self.assertGreater(clips[0].duration, 60.0)
        self.assertTrue(clips[0].exceeds_max_duration)


if __name__ == "__main__":
    unittest.main()
