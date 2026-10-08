"""External model protocol fixture with an observable inference gate."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import wave

import numpy as np

spec = json.loads(Path(sys.argv[1]).read_text())
for line in sys.stdin:
    request = json.loads(line)
    if spec.get('marker'):
        Path(spec['marker']).write_text(json.dumps({'pid': os.getpid(), 'audio': request['audio']}))
    while spec.get('gate') and not Path(spec['gate']).exists():
        time.sleep(0.01)
    with wave.open(request['audio']) as audio:
        duration = audio.getnframes() / audio.getframerate()
    count = int(np.ceil(duration / 0.04))
    starts = np.arange(count) * 0.04
    ends = np.minimum(starts + 0.04, duration)
    scores = np.zeros((count, 3), dtype=np.float32)
    for start, end, category in spec.get('events', []):
        scores[(starts >= start - 1e-8) & (starts < end - 1e-8), category] = 0.75
    np.savez(request['scores_path'], probabilities=scores, frame_onsets=starts,
             frame_offsets=ends, class_names=np.array(['Gunshot, gunfire', 'Machine gun', 'Speech']))
    checkpoint = Path(request['checkpoint']) if request.get('checkpoint') else None
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint else 'controlled-fixture'
    print(json.dumps({'type': 'result', 'model': {'name': 'controlled-edge-fixture',
                      'checkpoint_sha256': digest, 'preprocessing_version': 'fixture-v1'},
                      'valid_duration_s': duration}), flush=True)
