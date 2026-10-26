"""Developer-only: download pinned static browser assets into approved storage."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

FILES = {
    'mediabunny.mjs': 'mediabunny@1.25.0/dist/bundles/mediabunny.mjs',
    'mediabunny.LICENSE': 'mediabunny@1.25.0/LICENSE',
    'ort.wasm.min.mjs': 'onnxruntime-web@1.23.2/dist/ort.wasm.min.mjs',
    'ort-wasm-simd-threaded.mjs': 'onnxruntime-web@1.23.2/dist/ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm': 'onnxruntime-web@1.23.2/dist/ort-wasm-simd-threaded.wasm',
    'onnxruntime.LICENSE': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/LICENSE',
}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    args = parser.parse_args()
    vendor = args.assets / 'vendor'
    vendor.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, source in FILES.items():
        target = vendor / name
        url = source if source.startswith('https://') else 'https://cdn.jsdelivr.net/npm/' + source
        if not target.exists():
            temporary = target.with_suffix(target.suffix + '.part')
            subprocess.run(['curl', '-L', '--fail', '--max-time', '120', '-sS', url, '-o', str(temporary)], check=True)
            temporary.rename(target)
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        manifest.append({'name': name, 'url': url, 'bytes': target.stat().st_size, 'sha256': digest})
    (vendor / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))
