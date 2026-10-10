#!/usr/bin/env python3
"""Build native PyInstaller onedir resources and an Electron installer on that OS."""
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

ROOT = Path(__file__).resolve().parents[1]


def run(command, **kwargs):
    subprocess.run(command, check=True, **kwargs)


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-workspace', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--ffmpeg', type=Path, required=True)
    parser.add_argument('--ffprobe', type=Path, required=True)
    parser.add_argument('--media-license-dir', type=Path, required=True,
                        help='Licenses/source/build provenance for the supplied media tools')
    parser.add_argument('--stage-only', action='store_true', help='Build resources without the Electron installer')
    args = parser.parse_args()
    target = ('mac-arm64' if sys.platform == 'darwin' and platform.machine() == 'arm64' else
              'win-x64' if sys.platform == 'win32' and platform.machine().lower() in ('amd64', 'x86_64') else None)
    if target is None:
        parser.error('Build on native macOS arm64 or Windows x64; cross-compilation is unsupported')
    workspace = args.model_workspace.expanduser().resolve()
    checkpoint = (args.checkpoint or workspace / 'checkpoints' / 'BEATs_strong_1.pt').expanduser().resolve()
    required = [workspace / 'scripts' / 'infer_apex_audio.py', workspace / 'PretrainedSED' / 'config.py',
                checkpoint, args.ffmpeg, args.ffprobe]
    if any(not path.is_file() for path in required) or not args.media_license_dir.is_dir():
        parser.error('Missing model, native media tools, or media redistribution provenance')
    for tool in (args.ffmpeg, args.ffprobe):
        run([str(tool.resolve()), '-version'], stdout=subprocess.DEVNULL)
    try:
        import PyInstaller  # noqa: F401
        import torch
        import torchaudio  # noqa: F401
    except ImportError as exc:
        parser.error(f'Use an inference/build Python environment: {exc}')
    desktop = ROOT / 'desktop'
    if not (desktop / 'node_modules' / '.bin').is_dir():
        parser.error('Run npm ci --prefix desktop before packaging')
    build = ROOT / 'build' / 'model-desktop' / target
    build.mkdir(parents=True, exist_ok=True)
    resources = desktop / 'resources'
    if resources.exists():
        shutil.rmtree(resources)
    resources.mkdir()
    separator = ';' if os.name == 'nt' else ':'
    env = os.environ | {'PYINSTALLER_CONFIG_DIR': str(build / 'pyinstaller-cache')}
    run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
         '--name', 'apex-model-service', '--specpath', str(build), '--workpath', str(build / 'pyinstaller'),
         '--distpath', str(resources), '--collect-all', 'torch', '--collect-all', 'torchaudio',
         '--collect-all', 'soundfile', '--collect-submodules', 'scipy', '--hidden-import', 'numpy',
         '--hidden-import', 'model_inference', '--add-data', str(ROOT / 'model_inference.py') + separator + '.',
         '--add-binary', str(args.ffmpeg.resolve()) + separator + 'bin',
         '--add-binary', str(args.ffprobe.resolve()) + separator + 'bin',
         str(ROOT / 'model_ipc.py')], env=env)
    # copytree(symlinks=True) keeps upstream links, native library links and permissions.
    ignored = shutil.ignore_patterns('.git', '.venv*', '__pycache__', '*.pyc', 'outputs', 'checkpoints')
    model = resources / 'model'
    shutil.copytree(workspace / 'PretrainedSED', model / 'PretrainedSED', symlinks=True, ignore=ignored)
    (model / 'scripts').mkdir(parents=True)
    shutil.copy2(workspace / 'scripts' / 'infer_apex_audio.py', model / 'scripts' / 'infer_apex_audio.py')
    (model / 'checkpoints').mkdir()
    shutil.copy2(checkpoint, model / 'checkpoints' / checkpoint.name)
    for filename in ('provenance.json', 'README.md', 'README.zh-CN.md'):
        if (workspace / filename).is_file():
            shutil.copy2(workspace / filename, model / filename)
    licenses = resources / 'licenses'
    shutil.copytree(args.media_license_dir, licenses / 'media-tools', symlinks=True)
    packages = {}
    for distribution in metadata.distributions():
        packages[distribution.metadata['Name']] = distribution.version
        for filename in distribution.files or []:
            if '..' in filename.parts or not any(word in str(filename).lower() for word in ('license', 'copying', 'notice')):
                continue
            source = Path(distribution.locate_file(filename))
            if source.is_file() and source.suffix not in ('.py', '.pyc', '.so', '.dylib'):
                dest = licenses / distribution.metadata['Name'] / str(filename)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, dest)
    ui = desktop / 'ui'
    if ui.exists():
        shutil.rmtree(ui)
    shutil.copytree(ROOT / 'model_web_ui', ui, ignore=shutil.ignore_patterns('__pycache__', '*.py'))
    suffix = '.exe' if os.name == 'nt' else ''
    manifest = {
        'schema_version': 1, 'platform': target, 'python': sys.version, 'torch': torch.__version__,
        'service': f'apex-model-service/apex-model-service{suffix}',
        'ffmpeg': f'apex-model-service/_internal/bin/ffmpeg{suffix}',
        'ffprobe': f'apex-model-service/_internal/bin/ffprobe{suffix}',
        'model_workspace': 'model', 'checkpoint': 'model/checkpoints/' + checkpoint.name,
        'checkpoint_sha256': digest(checkpoint), 'packages': packages,
        'ui_sha256': {path.name: digest(path) for path in (ROOT / 'model_web_ui').iterdir()
            if path.is_file() and path.suffix in ('.html', '.js', '.css')},
        'desktop_sha256': {path.name: digest(path) for path in desktop.iterdir()
            if path.is_file() and path.name != 'build-native.cjs' and path.suffix in ('.cjs', '.html', '.js')},
        'source_sha256': {name: digest(ROOT / name) for name in ('model_service.py', 'model_review.py',
            'model_runtime.py', 'model_identity.py', 'model_inference.py', 'model_ipc.py')},
        'acceptance': 'unverified; installer creation is not clean-machine acceptance',
    }
    (resources / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    service = resources / manifest['service']
    staged = subprocess.run([str(service), '--data-dir', str(build / 'smoke-data'),
                            '--ffmpeg', str(resources / manifest['ffmpeg']), '--ffprobe', str(resources / manifest['ffprobe'])],
                           input='{"id":"package-smoke","operation":"get_config","payload":{}}\n',
                           text=True, capture_output=True, timeout=30, check=True)
    responses = [json.loads(line) for line in staged.stdout.splitlines()]
    if len(responses) != 2 or 'result' not in responses[1]:
        raise SystemExit('Staged runtime NDJSON readiness/config failed')
    (build / 'runtime-smoke.json').write_text(staged.stdout)
    if not args.stage_only:
        executable = desktop / 'node_modules' / '.bin' / ('electron-builder.cmd' if os.name == 'nt' else 'electron-builder')
        run([str(executable), '--mac' if target.startswith('mac') else '--win', '--arm64' if target.startswith('mac') else '--x64'], cwd=desktop)
    print(f'Native resources staged: {resources}. Clean-machine acceptance remains required.')


if __name__ == '__main__':
    main()
