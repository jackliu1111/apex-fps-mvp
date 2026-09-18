#!/usr/bin/env python3
"""Build a local-architecture onedir archive. Run with the project build venv."""
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
ARCHIVE = BUILD / 'ffmpeg-7.1.1.tar.xz'
SHA256 = '733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1'
URL = 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz'
CONFIG = ['--disable-autodetect', '--disable-shared', '--enable-static', '--disable-doc',
          '--disable-debug', '--disable-ffplay', '--disable-network', '--disable-x86asm']


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def dependencies(path):
    lines = subprocess.check_output(['/usr/bin/otool', '-L', str(path)], text=True).splitlines()[1:]
    return [line.strip().split(' (')[0] for line in lines]


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS build only')
    os.chdir(ROOT)
    BUILD.mkdir(exist_ok=True)
    if not ARCHIVE.exists():
        run(['/usr/bin/curl', '-fL', URL, '-o', str(ARCHIVE)])
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != SHA256:
        raise SystemExit('FFmpeg source SHA-256 mismatch')
    source = BUILD / 'ffmpeg-7.1.1'
    if not source.exists():
        with tarfile.open(ARCHIVE) as tar:
            tar.extractall(BUILD, filter='data')
    if not (source / 'ffmpeg').exists() or not (source / 'ffprobe').exists():
        env = os.environ | {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}
        with (BUILD / 'ffmpeg-configure.log').open('w') as log:
            run(['./configure', *CONFIG], cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
        with (BUILD / 'ffmpeg-build.log').open('w') as log:
            run(['/usr/bin/make', '-j8'], cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
    tools = ROOT / 'bin'
    tools.mkdir(exist_ok=True)
    if not (tools / 'ffplay').is_file():
        raise SystemExit('Missing bin/ffplay; prepare a standalone macOS ffplay before packaging.')
    run([str(tools / 'ffplay'), '-version'])
    for dep in dependencies(tools / 'ffplay'):
        if not dep.startswith(('/usr/lib/', '/System/Library/')):
            raise SystemExit(f'Non-system ffplay dependency: {dep}')
    for name in ('ffmpeg', 'ffprobe'):
        shutil.copy2(source / name, tools / name)
        for dep in dependencies(tools / name):
            if not dep.startswith(('/usr/lib/', '/System/Library/')):
                raise SystemExit(f'Non-system media dependency: {dep}')
    # Keep PyInstaller's cache inside the writable build tree.
    env = os.environ | {'PYINSTALLER_CONFIG_DIR': str(BUILD / 'pyinstaller-cache')}
    run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
         '--name', 'apex-highlight', '--specpath', str(BUILD), '--workpath', str(BUILD / 'pyinstaller'),
         '--distpath', str(ROOT / 'dist'), 'highlight_cli.py'], env=env)
    bundle = ROOT / 'dist' / 'apex-highlight'
    (bundle / 'bin').mkdir(exist_ok=True)
    for name in ('ffmpeg', 'ffprobe', 'ffplay'):
        shutil.copy2(tools / name, bundle / 'bin' / name)
    licenses = bundle / 'licenses'
    licenses.mkdir(exist_ok=True)
    if (tools / 'licenses').is_dir():
        shutil.copytree(tools / 'licenses', licenses / 'media-tools', dirs_exist_ok=True)
    for name in ('COPYING.LGPLv2.1', 'LICENSE.md'):
        shutil.copy2(source / name, licenses / ('FFmpeg-' + name))
    shutil.copy2(ARCHIVE, licenses / ARCHIVE.name)
    shutil.copy2(source / 'ffbuild' / 'config.mak', licenses / 'FFmpeg-config.mak')
    (licenses / 'FFmpeg-source.txt').write_text(
        f'FFmpeg 7.1.1, unmodified upstream source included as {ARCHIVE.name}.\n'
        f'Source: {URL}\nSHA256: {SHA256}\n'
        f'Build: ./configure {" ".join(CONFIG)} && make -j8\n'
        'LGPL 2.1 or later. Static FFmpeg libraries, no optional third-party libraries.\n'
        'Executables can be replaced in bin/; OS libraries are provided by macOS.\n')
    packages = {}
    for dist in metadata.distributions():
        packages[dist.metadata['Name']] = dist.version
        for file in dist.files or []:
            if any(word in str(file).lower() for word in ('license', 'copying', 'notice')):
                src = Path(dist.locate_file(file))
                if src.is_file() and src.suffix not in ('.py', '.pyc', '.so'):
                    target = licenses / dist.metadata['Name'] / str(file)
                    if '..' in file.parts:
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, target)
    python_license = Path(sys.base_prefix) / 'Resources' / 'English.lproj' / 'License.rtf'
    if not python_license.exists():
        python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if python_license.exists():
        shutil.copy2(python_license, licenses / ('Python-' + python_license.name))
    else:
        # CPython embeds its complete license text in the standard library site helper.
        import builtins
        builtins.license._Printer__setup()
        (licenses / 'Python-LICENSE.txt').write_text('\n'.join(builtins.license._Printer__lines))
    shutil.copy2(ROOT / 'README.md', bundle / 'README.txt')
    if (ROOT / 'VALIDATION.md').exists():
        shutil.copy2(ROOT / 'VALIDATION.md', bundle / 'VALIDATION.txt')
    manifest = {'architecture': platform.machine(), 'build_macos': platform.mac_ver()[0],
                'python': sys.version, 'packages': packages, 'ffmpeg_source_sha256': SHA256,
                'developer_signed': False, 'notarized': False}
    (bundle / 'build-info.json').write_text(json.dumps(manifest, indent=2))
    audit = {}
    for path in bundle.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        kind = subprocess.check_output(['/usr/bin/file', '-b', str(path)], text=True)
        if 'Mach-O' not in kind:
            continue
        deps = dependencies(path)
        for dep in deps:
            if not dep.startswith(('/usr/lib/', '/System/Library/', '@loader_path/', '@rpath/', '@executable_path/')):
                raise SystemExit(f'External dependency in {path}: {dep}')
        audit[str(path.relative_to(bundle))] = deps
    (bundle / 'dependency-audit.json').write_text(json.dumps(audit, indent=2))
    # PyInstaller trims Python.framework resources; seal the final framework
    # layout so its ad-hoc signature matches the files we actually distribute.
    framework = bundle / '_internal' / 'Python.framework'
    run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(framework)])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(framework)])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle / 'apex-highlight')])
    archive = ROOT / 'dist' / f'apex-highlight-macos-{platform.machine()}.zip'
    # ditto preserves executable bits and the framework symlinks used by Python.
    run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(bundle), str(archive)])
    print(archive)


if __name__ == '__main__':
    main()
