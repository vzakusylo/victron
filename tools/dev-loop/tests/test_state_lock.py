from __future__ import annotations

import pytest

import victron_loop.state as state_mod
from victron_loop.state import LockBusyError, StateStore


def test_lock_contention_raises_lockbusy(monkeypatch, tmp_path):
    if state_mod.fcntl is None:
        pytest.skip("fcntl unavailable on this platform")
    store = StateStore.open(tmp_path / "s")

    def raise_busy(_fd, _flags):
        raise OSError("busy")

    monkeypatch.setattr(state_mod.fcntl, "flock", raise_busy)
    with pytest.raises(LockBusyError):
        with store.lock():
            pass

