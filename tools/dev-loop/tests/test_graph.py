from __future__ import annotations

from pathlib import Path

from victron_loop.graph import build_graph
from victron_loop.nodes import LoopConfig


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

