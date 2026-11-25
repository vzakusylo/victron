from __future__ import annotations

import errno
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

WINDOWS = os.name == "nt"


def priority_options() -> dict:
    return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {}


def background_options() -> dict:
    if WINDOWS:
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.DETACHED_PROCESS}
    return {"start_new_session": True}


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if WINDOWS:
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied, not necessarily exited.
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258  # WAIT_TIMEOUT
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def desktop_notify(backend: str, title: str, message: str) -> None:
    if backend == "notify-send":
        subprocess.run(["notify-send", title, message], check=False)
    elif backend == "windows":
        command = ("if (!(Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue)) "
                   "{ exit 1 }; $ErrorActionPreference = 'Stop'; "
                   "New-BurntToastNotification -Text $env:VLOOP_TITLE,$env:VLOOP_MESSAGE")
        try:
            result = subprocess.run(
                ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
                env={**os.environ, "VLOOP_TITLE": title, "VLOOP_MESSAGE": message},
                capture_output=True, timeout=10,
            )
            if result.returncode == 0:
                return
        except (OSError, subprocess.TimeoutExpired):
            pass
        print(f"\a{title}: {message}", file=sys.stderr, flush=True)


class LockBusyError(RuntimeError):
    pass


def state_root() -> Path:
    if WINDOWS:
        return Path(os.environ["LOCALAPPDATA"]) / "victron-loop" / "state"
    xdg = os.environ.get("XDG_STATE_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "state") / "victron-loop"


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    with path.open("a+b") as handle:
        handle.seek(0)
        if WINDOWS:
            import msvcrt

            try:
                # Windows permits locking a byte beyond EOF.
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                raise LockBusyError("lock is busy") from exc
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise LockBusyError("lock is busy") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
