#!/usr/bin/env python3
"""Build on Windows using a locally extracted Windows FFmpeg distribution."""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg-dir', type=Path, default=ROOT / 'bin' / ('windows-arm64' if platform.machine().lower() == 'arm64' else 'windows-amd64'),
                        help='FFmpeg distribution root or directory containing ffmpeg.exe and ffprobe.exe')
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('Run this script on Windows; cross-compiling from macOS/Linux is not supported.')
    media_root = args.ffmpeg_dir.resolve()
    media_bin = media_root / 'bin' if (media_root / 'bin' / 'ffmpeg.exe').is_file() else media_root
    for name in ('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe'):
        if not (media_bin / name).is_file():
            parser.error(f'Missing {media_bin / name}; use --ffmpeg-dir with an extracted Windows FFmpeg build.')
        run([media_bin / name, '-version'], stdout=subprocess.DEVNULL)

    build = ROOT / 'build' / 'windows'
    dist = ROOT / 'dist' / 'windows'
    build.mkdir(parents=True, exist_ok=True)
    env = os.environ | {'PYINSTALLER_CONFIG_DIR': str(build / 'pyinstaller-cache')}
    run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
         '--console', '--noupx', '--name', 'apex-highlight', '--specpath', build,
         '--workpath', build / 'pyinstaller', '--distpath', dist, ROOT / 'highlight_cli.py'],
        cwd=ROOT, env=env)
    bundle = dist / 'apex-highlight'
    tools = bundle / 'bin'
    tools.mkdir(exist_ok=True)
    for src in media_bin.iterdir():
        if src.is_file() and (src.name.lower() in ('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe') or src.suffix.lower() == '.dll'):
            shutil.copy2(src, tools / src.name)
    licenses = bundle / 'licenses'
    licenses.mkdir(exist_ok=True)
    # Preserve the supplier's license/source notices when supplied with FFmpeg.
    for src in media_root.iterdir():
        if src.name.lower().startswith(('license', 'copying', 'notice', 'readme')):
            if src.is_dir():
                shutil.copytree(src, licenses / 'FFmpeg' / src.name, dirs_exist_ok=True)
            elif src.is_file():
                target = licenses / 'FFmpeg' / src.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
    packages = {}
    for package in metadata.distributions():
        name = package.metadata['Name']
        packages[name] = package.version
        for file in package.files or []:
            if '..' in file.parts or not any(token in str(file).lower() for token in ('license', 'copying', 'notice')):
                continue
            src = Path(package.locate_file(file))
            if src.is_file() and src.suffix.lower() not in ('.py', '.pyc', '.pyd', '.dll'):
                target = licenses / name / str(file)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if python_license.is_file():
        shutil.copy2(python_license, licenses / 'Python-LICENSE.txt')
    shutil.copy2(ROOT / 'README.md', bundle / 'README.txt')
    versions = {}
    for name in ('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe'):
        result = run([tools / name, '-version'], capture_output=True)
        versions[name] = result.stdout.decode('utf-8', errors='replace')
    manifest = {'architecture': platform.machine(), 'windows': platform.version(),
                'python': sys.version, 'packages': packages, 'media_versions': versions,
                'media_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in tools.iterdir() if p.is_file()}, 'signed': False}
    (bundle / 'build-info.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Start away from the checkout, with no FFmpeg/Python available through PATH.
    smoke_env = os.environ | {'PATH': str(Path(os.environ['SystemRoot']) / 'System32')}
    with tempfile.TemporaryDirectory(prefix='apex windows smoke ') as folder:
        for command in ('--help', 'doctor'):
            run([bundle / 'apex-highlight.exe', command], cwd=folder, env=smoke_env)
    archive = ROOT / 'dist' / f'apex-highlight-windows-{platform.machine().lower()}'
    print(shutil.make_archive(str(archive), 'zip', root_dir=dist, base_dir=bundle.name))


if __name__ == '__main__':
    main()
