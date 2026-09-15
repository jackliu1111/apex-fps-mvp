"""Run release with no external executable search path; record local evidence."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = Path(sys.argv[1]).resolve()
APP = BUNDLE / 'apex-highlight'
SOURCE = ROOT / 'build/验收 素材/真实游戏 短录像.mkv'
WORK = ROOT / 'build' / ('isolated-' + str(time.time_ns()))
WORK.mkdir()
ENV = {'PATH':'/nonexistent', 'HOME':str(WORK), 'LANG':'en_US.UTF-8', 'TERM':'xterm-256color'}
LOG = WORK / 'verification.log'


def run(args, expected=0):
    result = subprocess.run([str(x) for x in args], env=ENV, text=True, capture_output=True)
    with LOG.open('a') as log:
        log.write(f'{args}\nexit={result.returncode}\n{result.stdout}\n{result.stderr}\n')
    assert result.returncode == expected, result.stderr + result.stdout
    if '-xerror' in args:
        assert not result.stderr.strip(), result.stderr
    return result


run([APP, 'doctor'])
probe = BUNDLE / 'bin/ffprobe'
probe.rename(probe.with_suffix('.disabled'))
try:
    run([APP, 'doctor'], expected=1)
finally:
    probe.with_suffix('.disabled').rename(probe)
assert 'analyze' in run([APP]).stdout
folder = WORK / '中文 结果'
run([APP, 'analyze', SOURCE, '--output-dir', folder, '--before-s', '.2', '--after-s', '.2',
     '--fight-gap-s', '1', '--min-events', '2'])
result = folder / 'clips.json'
original = result.read_bytes()
assert len(json.loads(original)['clips']) == 8
run([APP, 'export', result, '--clips', '3,1'])
assert result.read_bytes() == original
assert json.loads((folder / 'selection.json').read_text())['clips'] == [1, 3]
run([BUNDLE / 'bin/ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', folder / 'apex_montage.mp4',
     '-fps_mode', 'passthrough', '-f', 'null', '-'])
run([APP, 'export', result], expected=1)
run([APP, 'export', result, '--clips', '0'], expected=1)
run([APP, 'export', result, '--output', SOURCE, '--overwrite'], expected=1)
run([APP, 'inspect', ROOT / 'outputs/clips.json'])
run([APP, 'export', ROOT / 'outputs/clips.json', '--output', WORK / 'legacy.mp4'], expected=1)
# Silent media proves the actual no-candidate path, including skip-export.
silence = WORK / '静音 录像.mkv'
run([BUNDLE / 'bin/ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=10',
     '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', silence])
run([APP, 'run', silence, '--output-dir', WORK / 'silence'])
assert json.loads((WORK / 'silence/clips.json').read_text())['clips'] == []
assert not (WORK / 'silence/apex_montage.mp4').exists()
# Corrupt media: ffprobe failure must be quiet, exit nonzero, and retain details in log.
corrupt = WORK / '损坏.mkv'
corrupt.write_bytes(b'not a recording')
run([APP, 'analyze', corrupt, '--output-dir', WORK / 'corrupt'], expected=1)
assert any('media:' in p.read_text() for p in (WORK / 'corrupt').glob('run-*.log'))
# Re-run default parameters with real video through the one-shot command.
run([APP, 'run', SOURCE, '--output-dir', WORK / 'one-shot'])
assert (WORK / 'one-shot/apex_montage.mp4').exists()
run([BUNDLE / 'bin/ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', WORK / 'one-shot/apex_montage.mp4',
     '-fps_mode', 'passthrough', '-f', 'null', '-'])
print(f'Isolated release end-to-end: PASS\nEvidence: {WORK}')
