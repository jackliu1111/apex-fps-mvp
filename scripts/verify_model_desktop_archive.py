#!/usr/bin/env python3
"""Verify a native ditto archive by comparing bytes, symlink targets and modes after extraction."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def entries(root):
    found = {}
    pending = [root]
    while pending:
        path = pending.pop()
        relative = '.' if path == root else str(path.relative_to(root))
        info = path.lstat()
        item = {'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISLNK(info.st_mode):
            item.update(kind='symlink', target=os.readlink(path))
        elif stat.S_ISDIR(info.st_mode):
            item.update(kind='directory')
            pending.extend(path.iterdir())
        elif stat.S_ISREG(info.st_mode):
            item.update(kind='file', size=info.st_size, sha256=sha(path))
        else:
            item.update(kind='other')
        found[relative] = item
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=ROOT / 'dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-local.zip')
    parser.add_argument('--source', type=Path, default=ROOT / 'dist/model-desktop/mac-arm64/Apex Model Review.app')
    parser.add_argument('--extract-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'outputs/desktop-archive-audit')
    args = parser.parse_args()
    source = args.source.resolve()
    extraction = args.extract_dir.resolve()
    subprocess.run(['/usr/bin/ditto', '-x', '-k', str(args.archive.resolve()), str(extraction)], check=True)
    restored = extraction / source.name
    original, extracted = entries(source), entries(restored)
    differences = [name for name in sorted(original.keys() | extracted.keys()) if original.get(name) != extracted.get(name)]
    report = {
        'platform': platform.platform(), 'uid': os.getuid(), 'source': str(source),
        'archive': str(args.archive.resolve()), 'archive_size': args.archive.stat().st_size,
        'archive_sha256': sha(args.archive), 'extracted_app': str(restored),
        'entry_count': len(original), 'file_count': sum(item['kind'] == 'file' for item in original.values()),
        'symlink_count': sum(item['kind'] == 'symlink' for item in original.values()),
        'executable_file_count': sum(item['kind'] == 'file' and item['mode'] & 0o111 != 0 for item in original.values()),
        'differences': differences, 'status': 'passed' if not differences else 'failed',
        'scope': 'local native archive fidelity; no clean-machine, signing, external redistribution or human sync acceptance',
    }
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'archive-fidelity.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'entry-manifest.json').write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    if differences:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
