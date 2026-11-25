from __future__ import annotations

import io
import json
import sys
from types import SimpleNamespace
from urllib.error import URLError

import pytest

from victron_loop import main, scheduler
from victron_loop.control import apply_control
from victron_loop.nodes import LoopConfig
from victron_loop.state import StateStore


def test_scheduler_runs_periodic_and_requested_cycles_and_stops_cleanly(tmp_path, capsys):
    now = [1_000.0]
    loop = scheduler.Scheduler(lambda: now[0], 10)
    cfg = LoopConfig(repo="test/repo", scheduler=loop)
    store = StateStore.open(tmp_path)
    event = loop.wake

    def wait(delay):
        if event.is_set():
            return True
        now[0] += delay
        return False

    event.wait = wait
    observed = []

    def cycle():
        observed.append(now[0])
        assert loop.running_cycle
        if len(observed) == 2:
            assert apply_control(store, cfg, "run-now")["message"] == "Run queued"
        if len(observed) == 3:
            loop.stop()
        return 0, "observed"

    assert loop.run(cycle) == 0
    assert observed == [1000, 1010, 1010]
    assert not loop.running_cycle and loop.next_at is None
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 3 and lines[-1].endswith("observed | next: -")


def test_once_returns_cycle_exit_status():
    loop = scheduler.Scheduler(lambda: 1000, 60)
    assert loop.run(lambda: (1, "failed"), once=True) == 1
    assert loop.next_at is None


@pytest.mark.parametrize(("live", "paused", "reason"), [
    (True, False, "peer-loop-active"), (True, True, None), (False, False, None),
])
def test_peer_guard_blocks_before_running_tick(tmp_path, monkeypatch, live, paused, reason):
    cfg = LoopConfig(repo="test/repo", dry_run=False, instance_name="pc",
                     peer_status_url="http://peer.test:8790/api/peer-status")
    reply = json.dumps({"instance_name": "peer", "live": live, "paused": paused}).encode()
    monkeypatch.setattr(scheduler, "urlopen", lambda *_, **_kw: io.BytesIO(reply))
    called = []
    monkeypatch.setattr(main, "run_tick", lambda *_: called.append("tick") or "idle")
    store = StateStore.open(tmp_path)
    assert main.run_cycle(store, cfg, SimpleNamespace(), echo=False) == (0, reason or "idle")
    assert called == ([] if reason else ["tick"])
    assert store.last_run()["result"] == (reason or "idle")


def test_configured_peer_outage_blocks_live_not_dry_run(monkeypatch):
    def offline(*_, **_kw):
        raise URLError("unreachable")

    cfg = LoopConfig(repo="test/repo", dry_run=False, peer_status_url="http://peer.test/api/peer-status")
    monkeypatch.setattr(scheduler, "urlopen", offline)
    assert scheduler.peer_blocker(cfg) == "peer-status-unavailable"
    cfg.dry_run = True
    assert scheduler.peer_blocker(cfg) is None


def test_windows_foreground_stderr_reaches_console_and_run_log(tmp_path, monkeypatch, capsys):
    def tick(*_):
        print("cycle diagnostic", file=sys.stderr)
        return "observed"

    monkeypatch.setattr(main, "WINDOWS", True)
    monkeypatch.setattr(main, "run_tick", tick)
    cfg = LoopConfig(repo="test/repo", notify_backend="none")
    store = StateStore.open(tmp_path)
    assert main.run_cycle(store, cfg, SimpleNamespace(), echo=False) == (0, "observed")
    assert capsys.readouterr().err == "cycle diagnostic\n"
    assert store.run_logs()[0].read_text(encoding="utf-8") == "cycle diagnostic\n"
