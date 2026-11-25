from __future__ import annotations

import subprocess
import sys

import pytest

from victron_loop.state import LockBusyError, StateStore
from victron_loop.platform import WINDOWS


def test_lock_contention_raises_lockbusy(tmp_path):
    store = StateStore.open(tmp_path / "s")
    with store.lock():
        with pytest.raises(LockBusyError):
            with store.lock():
                pytest.fail("contending lock was acquired")
    with store.lock():
        pass


def test_default_state_root_matches_platform(tmp_path):
    expected = tmp_path / ("localappdata" if WINDOWS else "xdg") / "victron-loop"
    assert StateStore.open().root == (expected / "state" if WINDOWS else expected)


def test_process_exit_releases_lock(tmp_path):
    store = StateStore.open(tmp_path)
    child = (
        "import os, sys\n"
        "from pathlib import Path\n"
        "from victron_loop.platform import exclusive_lock\n"
        "with exclusive_lock(Path(sys.argv[1])):\n"
        "    print('locked', flush=True)\n"
        "    sys.stdin.readline()\n"
        "    os._exit(7)\n"
    )
    with subprocess.Popen([sys.executable, "-c", child, str(store.lock_file)],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as process:
        try:
            assert process.stdout.readline().strip() == "locked"
            with pytest.raises(LockBusyError):
                with store.lock():
                    pytest.fail("child's lock was acquired")
        finally:
            process.communicate("\n", timeout=5)
        assert process.returncode == 7
    with store.lock():
        pass

