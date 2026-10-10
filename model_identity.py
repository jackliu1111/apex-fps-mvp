"""Content identities for local recordings and inference configuration."""
import hashlib
import json
from pathlib import Path


def file_identity(path, cancel_check=None):
    path = Path(path)
    before = path.stat()
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            if cancel_check:
                cancel_check()
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise OSError('文件在身份校验过程中变化，请重新操作')
    return {'size_bytes': after.st_size, 'mtime_ns': after.st_mtime_ns,
            'sha256': digest.hexdigest(), 'identity_strategy': 'sha256-size-mtime-ns-v1'}


def configuration_identity(workspace, checkpoint, cancel_check=None):
    files = {'checkpoint': checkpoint, 'adapter': Path(__file__).with_name('model_inference.py'),
             'loader': workspace / 'scripts/infer_apex_audio.py' if workspace else None}
    return {'workspace': str(workspace) if workspace else None,
            'files': {name: {'path': str(path), 'sha256': file_identity(path, cancel_check)['sha256']}
                      if path and path.is_file() else {'path': str(path) if path else None, 'sha256': None}
                      for name, path in files.items()},
            'preprocessing_version': 'beats-16k-mono-10s-5s-mean-v1', 'schema_version': 1}


def prediction_cache_key(media, configuration):
    return hashlib.sha256(json.dumps({'source': media['source'], 'audio': media['selected_audio'],
        'configuration': configuration, 'schema_version': 1}, sort_keys=True).encode()).hexdigest()
