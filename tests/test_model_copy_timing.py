"""Requested fast-copy content through public review operations.

Reordered frames outside the request are recorded as a diagnostic. The public
actual_range currently reports the source packet PTS span, not a guarantee that
every presentation frame between its endpoints is included.
"""
from fractions import Fraction
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from model_service import ModelService


class ModelCopyTimingTests(unittest.TestCase):
    def test_fast_copy_preserves_source_frames_inside_the_requested_range(self):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.skipTest('real FFmpeg media tools are required')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        evidence = Path(os.environ.get('COPY_TIMING_EVIDENCE', temporary.name))
        evidence.mkdir(parents=True, exist_ok=True)
        source = evidence / 'closed-gop-b16.mp4'
        subprocess.run([
            ffmpeg, '-nostdin', '-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=20',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
            '-c:v', 'libx264', '-preset', 'medium', '-g', '150', '-keyint_min', '150',
            '-sc_threshold', '0', '-bf', '16', '-x264-params', 'b-adapt=0:open-gop=0',
            '-video_track_timescale', '16000', '-c:a', 'aac', str(source),
        ], check=True)
        data = Path(temporary.name) / 'data'
        data.mkdir()
        spec = data / 'predictions.json'
        spec.write_text(json.dumps({'events': [[6, 6.4, 0]]}), encoding='utf-8')
        service = ModelService(data_dir=data, ffmpeg=ffmpeg, ffprobe=ffprobe,
                               model_command=[sys.executable,
                                              str(Path(__file__).parent / 'fixtures/model_worker.py'), str(spec)])
        self.addCleanup(service.close)

        def wait(submitted):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                task = service.execute('get_task', submitted)
                if task['status'] in ('completed', 'failed', 'cancelled'):
                    self.assertEqual('completed', task['status'], task)
                    return task
                time.sleep(0.01)
            self.fail('public media task did not finish')

        def decoded_frames(path):
            probe = json.loads(subprocess.check_output([
                ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_streams',
                '-show_entries', 'frame=best_effort_timestamp,pict_type:stream=time_base',
                '-of', 'json', str(path),
            ]))
            frame_md5 = subprocess.check_output([
                ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', str(path),
                '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-',
            ], text=True)
            hashes = [line.rsplit(',', 1)[1].strip() for line in frame_md5.splitlines()
                      if line and not line.startswith('#')]
            self.assertEqual(len(probe['frames']), len(hashes), 'independent decoders disagree on frame count')
            unit = Fraction(probe['streams'][0]['time_base'])
            return [{'time_s': float(int(frame['best_effort_timestamp']) * unit),
                     'hash': digest, 'type': frame['pict_type']}
                    for frame, digest in zip(probe['frames'], hashes)]

        media = service.execute('probe_media', {'path': str(source)})
        service.execute('confirm_audio', {'media_id': media['media_id'], 'stream_index': 1})
        analyzed = wait(service.execute('analyze', {'media_id': media['media_id']}))
        result = service.execute('get_result', {'result_id': analyzed['result_id']})
        reference = {'result_id': result['result_id'], 'candidate_version': result['candidate_version']}
        requested = {'start_s': 5.3, 'end_s': 8.84}
        service.execute('update_selection', {**reference, 'clips': [
            {'candidate_id': result['candidates'][0]['candidate_id'], **requested}]})
        exported = wait(service.execute('export', {**reference, 'output_dir': str(evidence / 'exports')}))
        self.assertEqual(1, len(exported['exports']))
        artifact = service.execute('get_artifact', {'artifact_id': exported['exports'][0]['artifact_id']})
        self.assertEqual(('copy', requested), (artifact['mode'], artifact['requested_range']))

        original, copied = decoded_frames(source), decoded_frames(artifact['path'])
        self.assertEqual(len(original), len({frame['hash'] for frame in original}),
                         'the real-media fixture needs distinguishable decoded frames')
        source_indices = {frame['hash']: index for index, frame in enumerate(original)}
        matched = [source_indices.get(frame['hash']) for frame in copied]
        missing = [index for index, frame in enumerate(original)
                   if artifact['actual_range']['start_s'] - 1e-5 <= frame['time_s']
                   < artifact['actual_range']['end_s'] - 1e-5 and index not in matched]
        missing_requested = [index for index, frame in enumerate(original)
                             if requested['start_s'] <= frame['time_s'] < requested['end_s']
                             and index not in matched]
        report = {'scope': 'Requested content regression; outside-request holes are diagnostic, not a stutter fix.',
                  'requested_range': requested, 'actual_range': artifact['actual_range'],
                  'artifact_path': artifact['path'], 'source_frame_count': len(original),
                  'output_frame_count': len(copied), 'unmatched_output_frames': matched.count(None),
                  'missing_in_actual_range': [{'index': index, **original[index]} for index in missing],
                  'missing_in_requested_range': [{'index': index, **original[index]} for index in missing_requested],
                  'source_frames': original, 'output_frames': copied, 'source_indices': matched}
        (evidence / 'presentation-comparison.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        self.assertNotIn(None, matched, 'stream copy must preserve decoded source pixels')
        self.assertEqual(sorted(set(matched)), matched, 'copied source frames must retain presentation order')
        self.assertEqual([], missing_requested,
                         'fast copy loses source frames from the user request; '
                         f'missing source times={[original[index]["time_s"] for index in missing_requested]}')


if __name__ == '__main__':
    unittest.main()
