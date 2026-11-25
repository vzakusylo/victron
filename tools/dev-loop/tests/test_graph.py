from __future__ import annotations

from pathlib import Path

import victron_loop.nodes as nodes
from victron_loop.graph import LoopState, build_graph
from victron_loop.nodes import LoopConfig, check_state, notify, pick_task, start_worker, watch_pr


def fixed_clock():
    return 4102444800.0


class FakeGh:
    def list_open_prs(self):
        return []

    def list_runs(self, workflow, branch, limit):
        if workflow == "deploy-gx-code.yml":
            return [{"databaseId": 11, "headSha": "a", "conclusion": "success"}]
        if workflow == "test-gx.yml":
            return [{"databaseId": 12, "headSha": "a", "conclusion": "success"}]
        return []

    def view_run_jobs(self, run_id):
        if run_id == 11:
            return [{"steps": [{"name": "Monitor post-deploy health", "conclusion": "failure"}]}]
        return []

    def list_prs(self, state="open", head_branch=None):
        return []


def test_graph_invoke_preserves_failed_rows_and_routes_notifications(tmp_path: Path):
    backlog = tmp_path / "BACKLOG.md"
    backlog.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | docs task | open | ready |
""",
        encoding="utf-8",
    )
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    app = build_graph(cfg, FakeGh(), backlog)
    state = {
        "approved": [],
        "active_worker": None,
        "failed_rows": ["X1"],
        "notifications_sent": {},
        "daily_counts": {},
    }
    out = app.invoke(state)
    assert out["failed_rows"] == ["X1"]
    assert any(k.startswith("deploy-health-red:11") for k in out["notifications_sent"].keys())


def test_graph_invoke_fetch_failure_sets_repo_refresh_failed_reason(tmp_path: Path, monkeypatch):
    backlog = tmp_path / "BACKLOG.md"
    backlog.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | docs task | open | ready |
""",
        encoding="utf-8",
    )
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, notify_backend="none", clock=fixed_clock)
    monkeypatch.setattr(nodes, "_fetch_origin_niced", lambda _cfg: False)
    app = build_graph(cfg, FakeGh(), backlog)
    out = app.invoke({"approved": [], "active_worker": None, "daily_counts": {}})
    assert out["repo_refresh_failed"] is True
    assert out["pick"]["reason"] == "repo-refresh-failed"


def test_all_node_output_keys_are_declared_in_loopstate(tmp_path: Path, monkeypatch):
    backlog = tmp_path / "BACKLOG.md"
    backlog.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | docs task | open | ready |
""",
        encoding="utf-8",
    )
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    gh = FakeGh()

    base = {"approved": [], "active_worker": None, "daily_counts": {}, "notifications_sent": {}}
    states = [
        check_state(dict(base), cfg, gh),
        pick_task(dict(base, observed={"open_prs": [], "deploy_applied": True, "deploy_health": "success"}), cfg, backlog),
        start_worker(dict(base, pick={"row_id": "R1", "branch": "r1", "brief": "x", "tier": "standard"}), cfg),
        watch_pr(dict(base, active_worker={"branch": "b1", "row_id": "R1", "retry_count": 0, "worktree": str(tmp_path), "log_path": str(tmp_path / "w.log")}), cfg, gh),
        notify(dict(base, pending_notifications=[{"condition": "c", "subject_id": "1", "message": "m"}]), cfg),
    ]
    declared = set(LoopState.__annotations__.keys())
    produced = set().union(*(set(s.keys()) for s in states))
    assert produced.issubset(declared)

