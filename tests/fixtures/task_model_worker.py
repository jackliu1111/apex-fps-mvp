"""External process fixture reporting its PID for orphan-process checks."""
import json
import os
from pathlib import Path
import runpy
import sys

spec = json.loads(Path(sys.argv[1]).read_text())
Path(spec['pid_path']).write_text(str(os.getpid()))
runpy.run_path(str(Path(__file__).with_name('model_worker.py')), run_name='__main__')
