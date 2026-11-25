from __future__ import annotations

from pathlib import Path

from victron_loop.nodes import LoopConfig, start_worker


def fixed_clock():
    return 4102444800.0  # 2100-01-01


def test_start_worker_dry_run_no_side_effects(tmp_path: Path):
    state = {"pick": {"row_id": "R2", "branch": "auto-rx", "brief": "x", "tier": "standard"}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, loop_home=tmp_path, clock=fixed_clock)
    start_worker(state, cfg)
    assert state["active_worker"] is None
    assert not (tmp_path / "logs").exists()
    assert not (tmp_path / "worktrees").exists()

