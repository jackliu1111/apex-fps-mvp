"""Diagnostic streamcopy timer; never overwrites output or decodes/re-encodes audio."""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('report', type=Path)
parser.add_argument('--input-packet-bytes', type=int, default=0, help='file protocol pkt_size; 0 leaves FFmpeg default')
args = parser.parse_args()
if args.input_packet_bytes < 0:
    raise SystemExit('Input packet size must be nonnegative')
if args.output.exists() or args.report.exists():
    raise SystemExit('Output/report already exists; choose new paths')
command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'verbose', '-nostats',
           '-benchmark', '-n', '-copyts', *(['-pkt_size', str(args.input_packet_bytes)] if args.input_packet_bytes else []),
           '-i', str(args.source), '-map', '0:a:0',
           '-vn', '-sn', '-dn', '-c:a', 'copy', '-avoid_negative_ts', 'disabled', str(args.output)]
version = subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]
started = time.perf_counter()
result = subprocess.run(command, capture_output=True, text=True)
returncode, stderr = result.returncode, result.stderr
elapsed = (time.perf_counter() - started) * 1000
report = {'command': command, 'version': version, 'source': str(args.source),
          'sourceBytes': args.source.stat().st_size, 'output': str(args.output),
          'outputBytes': args.output.stat().st_size if args.output.exists() else None,
          'totalMs': elapsed, 'exitCode': returncode, 'cacheCleared': False,
          'inputMode': 'direct-file',
          'inputPacketBytes': args.input_packet_bytes,
          'scope': 'process startup, demux, streamcopy mux, writes and normal process exit; no fsync durability timing',
          'stderr': stderr}
with args.report.open('x') as output_report:
    output_report.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'stderr'}, ensure_ascii=False, indent=2))
raise SystemExit(returncode)
