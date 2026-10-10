"""External model-process fixture; never used as real inference evidence."""
import json
from pathlib import Path
import sys
import wave
import time
import numpy as np

spec = json.loads(Path(sys.argv[1]).read_text())
for line in sys.stdin:
    request = json.loads(line)
    while spec.get('gate') and not Path(spec['gate']).exists():
        time.sleep(0.01)
    if spec.get('error'):
        print(json.dumps({'type': 'error', 'code': spec['error'], 'message': 'controlled model failure'}), flush=True)
        continue
    with wave.open(request['audio']) as audio:
        duration = audio.getnframes() / audio.getframerate()
    count = int(np.ceil(duration / 0.04))
    starts = np.arange(count) * 0.04
    ends = np.minimum(starts + 0.04, duration)
    scores = np.zeros((count, 3), dtype=np.float32)
    for start, end, category in spec.get('events', []):
        scores[(starts >= start - 1e-8) & (starts < end - 1e-8), category] = 0.75
    if spec.get('invalid_scores'):
        scores[0, 0] = np.nan
    np.savez(request['scores_path'], probabilities=scores, frame_onsets=starts,
             frame_offsets=ends, class_names=np.array(['Gunshot, gunfire', 'Machine gun', 'Speech']))
    print(json.dumps({'type': 'result', 'model': {'name': 'controlled-fixture',
          'checkpoint_sha256': 'fixture', 'preprocessing_version': 'fixture-v1'},
          'valid_duration_s': duration}), flush=True)
