from __future__ import annotations

from pathlib import Path

import victron_loop.nodes as nodes
import shlex
from victron_loop.nodes import _retry_worker, _spawn_copilot, LoopConfig


def fixed_clock():
    return 4102444800.0


def test_spawn_uses_nice_19_when_not_systemd(monkeypatch, tmp_path: Path):
    calls = []
    original_exists = Path.exists

    class DummyProc:
        pid = 123

    monkeypatch.setattr(nodes.Path, "exists", lambda self: False if str(self) == "/run/systemd/system" else original_exists(self))
    monkeypatch.setattr(nodes.subprocess, "Popen", lambda cmd, **kwargs: calls.append((cmd, kwargs)) or DummyProc())
    pid = _spawn_copilot(tmp_path, "copilot -p x")
    assert pid == 123
    assert "nice -n 19" in calls[0][0][2]
    assert calls[0][1]["start_new_session"]


def test_retry_uses_nice_spawn(monkeypatch, tmp_path: Path, mock_copilot_path):
    monkeypatch.setattr(nodes, "WINDOWS", False)
    models = tmp_path / "models.json"
    models.write_text('{"tiers":{"standard":{"model":"gpt-x","effort":"low"}}}', encoding="utf-8")
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, model_tiers_file=models)
    worker = {"tier": "standard", "worktree": str(tmp_path), "log_path": str(tmp_path / "w.log"), "retry_count": 0}
    captured = {}
    monkeypatch.setattr(nodes, "_spawn_copilot", lambda _wt, cmd: captured.setdefault("cmd", cmd) or 456)
    _retry_worker({}, cfg, worker, "fix now")
    assert " --allow-all " in captured["cmd"]
    assert shlex.split(captured["cmd"])[0] == mock_copilot_path
    assert "--model gpt-x" in captured["cmd"]
    assert "--reasoning-effort low" in captured["cmd"]
    assert worker["retry_count"] == 1


def test_missing_copilot_does_not_replace_active_worker_pick(tmp_path):
    state = {"pick": {"reason": "worker-active"}}
    worker = {"retry_count": 0}
    cfg = LoopConfig(repo="test/repo", copilot_bin=str(tmp_path / "missing"))
    _retry_worker(state, cfg, worker, "fix now")
    assert state["pick"] == {"reason": "worker-active"}
    assert worker["retry_count"] == 0
    assert state["pending_notifications"][0]["condition"] == "copilot-missing"

