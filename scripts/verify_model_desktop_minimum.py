#!/usr/bin/env python3
"""Bounded public macOS app declaration vs actual Mach-O load-command audit."""
import argparse
import json
from pathlib import Path
import plistlib
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
MAGIC = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def version(value):
    return tuple([int(part) for part in value.split('.')] + [0] * (3 - len(value.split('.'))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT / 'dist/model-desktop/mac-arm64/Apex Model Review.app')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    start = time.monotonic()
    bundle = args.app.resolve()
    declared = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())['LSMinimumSystemVersion']
    native_tool = subprocess.check_output(['/usr/bin/xcrun', '--find', 'vtool'], text=True, timeout=5).strip()
    found, seen = [], set()
    for target in bundle.rglob('*'):
        if target.is_symlink() or not target.is_file():
            continue
        with target.open('rb') as stream:
            if stream.read(4) not in MAGIC:
                continue
        canonical = str(target.resolve())
        if canonical in seen:
            continue
        seen.add(canonical)
        if len(seen) > 500 or time.monotonic() - start > 120:
            raise RuntimeError('bounded native scan exceeded 500 files/120 seconds')
        output = subprocess.check_output([native_tool, '-show-build', str(target)], text=True, timeout=5)
        floors = []
        for block in re.split(r'Load command \d+', output):
            if 'cmd LC_BUILD_VERSION' in block:
                platform = re.search(r'\bplatform\s+(\S+)', block)
                minimum = re.search(r'\bminos\s+([0-9.]+)', block)
                if platform and platform.group(1) in ('1', 'MACOS') and minimum:
                    floors.append(minimum.group(1))
            elif 'cmd LC_VERSION_MIN_MACOSX' in block:
                minimum = re.search(r'\bversion\s+([0-9.]+)', block)
                if minimum:
                    floors.append(minimum.group(1))
        found.append({'path': str(target.relative_to(bundle)), 'macos_minima': floors})
    maximum = max((floor for entry in found for floor in entry['macos_minima']), key=version)
    violations = [entry for entry in found if any(version(floor) > version(declared) for floor in entry['macos_minima'])]
    report = {'app': str(bundle), 'declared_minimum': declared, 'maximum_native_macos_floor': maximum,
              'native_count': len(found), 'native_entries': found, 'violations': violations,
              'elapsed_s': time.monotonic() - start, 'status': 'failed' if violations else 'passed',
              'scope': 'static public Info.plist/load-command consistency only; does not prove runtime on the lowest declared OS'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('declared_minimum', 'maximum_native_macos_floor', 'native_count', 'elapsed_s', 'status')}))
    if violations:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
