"""Media process lifetime, bundled tool discovery and quiet disk-backed stderr."""
from contextlib import contextmanager
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

LOG = logging.getLogger('apex-highlight')


def tool_path(name):
    root = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).parent
    filename = name + '.exe' if sys.platform == 'win32' and not name.lower().endswith('.exe') else name
    bundled = root / 'bin' / filename
    if bundled.is_file() and os.access(bundled, os.X_OK):
        return str(bundled)
    if not getattr(sys, 'frozen', False):
        found = shutil.which(name)
        if found:
            return found
    raise RuntimeError(f'缺少媒体工具 {name}；请检查发布包 bin 目录，源码运行请安装 FFmpeg。')


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@contextmanager
def media_process(command):
    command = [tool_path(command[0]), *command[1:]]
    if Path(command[0]).stem.lower() == 'ffmpeg':
        command.insert(1, '-nostdin')
    LOG.debug('command: %r', command)
    # A disk-backed file avoids stderr pipe deadlocks and unbounded RAM usage.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=errors)
        try:
            yield process
            code = process.wait()
            if code:
                errors.seek(0, 2)
                size = errors.tell()
                errors.seek(max(0, size - 4096))
                tail = errors.read().decode('utf-8', errors='replace')
                raise RuntimeError(f'{Path(command[0]).name} 失败（退出码 {code}）：{tail.strip()}')
        finally:
            stop(process)
            if process.stdout:
                process.stdout.close()
            errors.seek(0)
            for line in errors:
                LOG.debug('media: %s', line.decode('utf-8', errors='replace').rstrip())


def run_command(command, *, capture=False):
    with media_process(command) as process:
        output = process.stdout.read().decode('utf-8', errors='replace')
    return subprocess.CompletedProcess(command, 0, output if capture else None, '')
