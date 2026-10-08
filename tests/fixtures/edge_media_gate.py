"""External FFmpeg wrapper that gates one media output, then runs real FFmpeg."""
import json
import os
from pathlib import Path
import sys
import time

spec = json.loads(Path(sys.argv[1]).read_text())
arguments = sys.argv[2:]
target = Path(arguments[-1])
controlled = (spec['mode'] == 'preview' and target.parent.name == 'previews') or (
    spec['mode'] == 'second_export' and target.name == '002.mp4')
if controlled:
    target.write_bytes(b'controlled unfinished media')
    Path(spec['marker']).write_text(json.dumps({'pid': os.getpid(), 'path': str(target)}))
    while not Path(spec['release']).exists():
        time.sleep(0.01)
    # -n belongs to the real FFmpeg invocation; the gate's temporary bytes are
    # removed before delegating so the fixture does not cause an unrelated error.
    target.unlink(missing_ok=True)
os.execv(spec['ffmpeg'], [spec['ffmpeg'], *arguments])
