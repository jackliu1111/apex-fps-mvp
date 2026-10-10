"""Directory leases and supervised child-process lifecycle."""
import os
import weakref
import signal
import subprocess
import sys
import time
from pathlib import Path

_directory_owners = {}


def acquire_directory(service):
    key = str(service.data_dir)
    reference = _directory_owners.get(key)
    owner = reference() if reference else None
    if owner is not None and not owner.closing:
        return None
    stream = (service.data_dir / '.service.lock').open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0)
            stream.write(b'0')
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close()
        raise
    _directory_owners[key] = weakref.ref(service)
    return stream


def guarded_command(command):
    launcher = [sys.executable, '--process-guardian'] if getattr(sys, 'frozen', False) else [
        sys.executable, '-u', str(Path(__file__).resolve())]
    return [*launcher, str(os.getpid()), '--', *map(str, command)]


def parent_alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied is not proof of exit.
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x00000102
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def guardian_main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    parent_pid = int(arguments[0])
    command = arguments[2:]
    stopping = False

    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    child = subprocess.Popen(command, start_new_session=os.name != 'nt')

    def stop_child(force=False):
        if child.poll() is not None:
            return
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            try:
                os.killpg(child.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                child.kill() if force else child.terminate()

    try:
        while child.poll() is None:
            if stopping or not parent_alive(parent_pid):
                stop_child()
                try:
                    child.wait(timeout=.8)
                except subprocess.TimeoutExpired:
                    stop_child(force=True)
                    child.wait(timeout=2)
                break
            time.sleep(.05)
        return child.wait()
    finally:
        stop_child(force=True)
        child.wait()


if __name__ == '__main__':
    raise SystemExit(guardian_main())
