#!/usr/bin/env python3
"""Make a local macOS launcher using this checkout and its existing AI runtime."""
from pathlib import Path
import plistlib
import shlex

ROOT = Path(__file__).resolve().parents[2]
binary = ROOT / 'outputs/filmcraft-ai-prototype/filmcraft/target/debug/filmcraft'
if not binary.is_file():
    raise SystemExit('Build FilmCraft AI before creating its local launcher.')
bundle = ROOT / 'outputs/filmcraft-ai-prototype/FilmCraft AI.app'
macos = bundle / 'Contents/MacOS'
macos.mkdir(parents=True, exist_ok=True)
launcher = macos / 'FilmCraft-AI'
launcher.write_text('#!/bin/sh\nexec /bin/sh ' + shlex.quote(str(ROOT / 'integrations/filmcraft/run.sh')) + ' "$@"\n')
launcher.chmod(0o755)
with (bundle / 'Contents/Info.plist').open('wb') as stream:
    plistlib.dump({
        'CFBundleName': 'FilmCraft AI',
        'CFBundleDisplayName': 'FilmCraft AI',
        'CFBundleIdentifier': 'local.apex.filmcraft-ai-prototype',
        'CFBundleExecutable': 'FilmCraft-AI',
        'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '0.7.2.1',
        'CFBundleShortVersionString': '0.7.2-ai-prototype',
        'NSHighResolutionCapable': True,
        'NSPrincipalClass': 'NSApplication',
    }, stream)
print(bundle)
