from __future__ import annotations

from pathlib import Path

from victron_loop.nodes import LoopConfig, start_worker
import victron_loop.nodes as nodes


def test_missing_copilot_blocks_worker_creation_and_notifies_once(monkeypatch, tmp_path):
    cfg = LoopConfig(repo="test/repo", dry_run=False, notify_backend="none", worker_backend="headless",
                     copilot_bin=str(tmp_path / "missing"))
    monkeypatch.setattr(nodes, "_ensure_repo", lambda _: (_ for _ in ()).throw(AssertionError("unexpected setup")))
    state = {}
    for _ in range(2):
        state["pick"] = {"branch": "example"}
        start_worker(state, cfg)
        assert state["pick"] == {"reason": "copilot-missing"}
        nodes.notify(state, cfg)
    assert list(state["notifications_sent"]) == ["copilot-missing:cli"]


def test_copilot_defaults_to_local_bin_when_missing_from_path(monkeypatch):
    expected = str(Path.home() / ".local" / "bin" / "copilot")
    monkeypatch.setattr(nodes.shutil, "which", lambda candidate: expected if candidate == expected else None)
    assert nodes._copilot_path({}, LoopConfig(repo="test/repo")) == expected


def fixed_clock():
    return 4102444800.0  # 2100-01-01


def test_start_worker_dry_run_no_side_effects(tmp_path: Path):
    state = {"pick": {"row_id": "R2", "branch": "auto-rx", "brief": "x", "tier": "standard"}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, loop_home=tmp_path, clock=fixed_clock)
    start_worker(state, cfg)
    assert state["active_worker"] is None
    assert not (tmp_path / "logs").exists()
    assert not (tmp_path / "worktrees").exists()

