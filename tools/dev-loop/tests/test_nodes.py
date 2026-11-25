from __future__ import annotations

import subprocess
from pathlib import Path

from victron_loop.nodes import LoopConfig, check_state, notify, parse_backlog, pick_task, requires_owner_approval
import victron_loop.nodes as nodes


def fixed_clock():
    return 4102444800.0  # 2100-01-01


def test_parse_backlog_allowed_sections_only():
    text = """
### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | Done row | Done | ok |
| R3 | Open row | open | ready |
### Something else
| ID | Task | State | Notes |
|---|---|---|---|
| X1 | Should skip | open | ready |
### Production backlog
| ID | Phase | Task | State |
|---|---|---|---|
| P1 | a | P task | open |
"""
    rows = parse_backlog(text)
    assert [r["row_id"] for r in rows] == ["R1", "R3", "P1"]


def test_requires_owner_approval_allowlist_and_production_block():
    safe = {"row_id": "R1", "task": "Docs update", "state": "open", "notes": "README only", "section": "Process and repo"}
    risky = {"row_id": "B1", "task": "Battery setpoint tune", "state": "open", "notes": "DVCC", "section": "Production backlog"}
    assert requires_owner_approval(safe) is False
    assert requires_owner_approval(risky) is True


def test_pick_task_skips_hard_needs_owner_go(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| G4 | Grid control work | open | ready |
| R4 | Process task | open | ready |
""",
        encoding="utf-8",
    )
    state = {
        "observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"},
        "approved": [],
        "daily_counts": {},
    }
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    result = pick_task(state, cfg, path, copilot_runner=None)
    assert result["pick"]["row_id"] == "R4"
    assert result["pending_notifications"][0]["condition"] == "needs-owner-go"


def test_pick_task_budget_cap_with_injected_clock(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R4 | Process task | open | ready |
""",
        encoding="utf-8",
    )
    state = {
        "observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"},
        "approved": [],
        "daily_counts": {"2100-01-01": 3},
    }
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, max_worker_runs_per_day=3, clock=fixed_clock)
    result = pick_task(state, cfg, path, copilot_runner=None)
    assert result["pick"]["reason"] == "daily-budget-cap"


def test_notify_dedupe_and_resolve():
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {
        "pending_notifications": [{"condition": "c", "subject_id": "1", "message": "m"}],
        "notifications_sent": {},
        "failed_rows": [],
        "active_worker": None,
    }
    notify(state, cfg)
    assert "c:1" in state["notifications_sent"]
    state["pending_notifications"] = [{"condition": "c", "subject_id": "1", "message": "m"}]
    notify(state, cfg)
    assert len(state["notifications_sent"]) >= 1
    state["resolved_notification_keys"] = ["c:1"]
    notify(state, cfg)
    assert "c:1" not in state["notifications_sent"]
    state["pending_notifications"] = [{"condition": "c", "subject_id": "1", "message": "m"}]
    notify(state, cfg)
    assert "c:1" in state["notifications_sent"]


def test_pick_task_copilot_error_notifies(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R4 | Process task | open | ready |
""",
        encoding="utf-8",
    )
    models = tmp_path / "models.json"
    models.write_text('{"tiers":{"review":{"model":"m1","effort":"low"}}}', encoding="utf-8")
    state = {"observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}, "approved": [], "daily_counts": {}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, model_tiers_file=models)
    origin_backlog = path.read_text(encoding="utf-8")
    origin_models = models.read_text(encoding="utf-8")

    def bad_runner(*_args, **_kwargs):
        raise subprocess.CalledProcessError(1, "copilot")

    import victron_loop.nodes as n
    old = n._git_show_origin_file
    n._git_show_origin_file = lambda _cfg, rel: origin_backlog if rel == "BACKLOG.md" else origin_models
    try:
        result = pick_task(state, cfg, path, copilot_runner=bad_runner)
    finally:
        n._git_show_origin_file = old
    assert result["pick"]["reason"] == "pick-task-error"
    assert result["pending_notifications"][0]["condition"] == "pick-task-error"


def test_pick_task_non_json_notifies(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R4 | Process task | open | ready |
""",
        encoding="utf-8",
    )
    models = tmp_path / "models.json"
    models.write_text('{"tiers":{"review":{"model":"m1","effort":"low"}}}', encoding="utf-8")
    state = {"observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}, "approved": [], "daily_counts": {}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, model_tiers_file=models)
    origin_backlog = path.read_text(encoding="utf-8")
    origin_models = models.read_text(encoding="utf-8")

    class Out:
        stdout = "not-json"

    import victron_loop.nodes as n
    old = n._git_show_origin_file
    n._git_show_origin_file = lambda _cfg, rel: origin_backlog if rel == "BACKLOG.md" else origin_models
    try:
        result = pick_task(state, cfg, path, copilot_runner=lambda *_a, **_k: Out())
    finally:
        n._git_show_origin_file = old
    assert result["pick"]["reason"] == "pick-task-error"


def test_pick_task_branch_sanitising(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R-9 BAD | Process task | open | ready |
""",
        encoding="utf-8",
    )
    models = tmp_path / "models.json"
    models.write_text('{"tiers":{"review":{"model":"m1","effort":"low"}}}', encoding="utf-8")
    state = {"observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}, "approved": [], "daily_counts": {}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, model_tiers_file=models)
    origin_backlog = path.read_text(encoding="utf-8")
    origin_models = models.read_text(encoding="utf-8")

    class Out:
        stdout = '{"row_id":"R-9 BAD","branch":"INVALID BRANCH !!!","tier":"standard","brief":"x"}'

    import victron_loop.nodes as n
    old = n._git_show_origin_file
    n._git_show_origin_file = lambda _cfg, rel: origin_backlog if rel == "BACKLOG.md" else origin_models
    try:
        result = pick_task(state, cfg, path, copilot_runner=lambda *_a, **_k: Out())
    finally:
        n._git_show_origin_file = old
    assert result["pick"]["branch"] == "r-9-bad"


def test_failed_rows_excluded_from_pick(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | Task 1 | open | ready |
| R2 | Task 2 | open | ready |
""",
        encoding="utf-8",
    )
    state = {
        "observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"},
        "approved": [],
        "failed_rows": ["R1"],
        "daily_counts": {},
    }
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    result = pick_task(state, cfg, path, copilot_runner=None)
    assert result["pick"]["row_id"] == "R2"


def test_pick_task_uses_models_file_from_repo_clone_path(tmp_path: Path):
    path = tmp_path / "BACKLOG.md"
    path.write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | Task | open | ready |
""",
        encoding="utf-8",
    )
    repo_models = tmp_path / "repo" / "tools" / "herdr"
    repo_models.mkdir(parents=True)
    models_file = repo_models / "models.json"
    models_file.write_text('{"tiers":{"review":{"model":"from-repo-clone","effort":"low"}}}', encoding="utf-8")
    state = {"observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}, "approved": [], "daily_counts": {}}
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, model_tiers_file=models_file)
    called = {}

    class Out:
        stdout = '{"row_id":"R1","branch":"r1","tier":"standard","brief":"x"}'

    def runner(cmd, **_kwargs):
        called["cmd"] = cmd
        return Out()

    def fake_show(_cfg, rel):
        if rel == "BACKLOG.md":
            return path.read_text(encoding="utf-8")
        return models_file.read_text(encoding="utf-8")

    import victron_loop.nodes as n
    old = n._git_show_origin_file
    n._git_show_origin_file = fake_show
    try:
        pick_task(state, cfg, path, copilot_runner=runner)
    finally:
        n._git_show_origin_file = old
    assert "--model" in called["cmd"]
    assert "from-repo-clone" in called["cmd"]


def test_check_state_fetch_failure_notifies_and_pick_skips(monkeypatch):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock)
    state = {}

    class FakeGh:
        def list_open_prs(self):
            return []

        def list_runs(self, workflow, branch, limit):
            return []

        def view_run_jobs(self, run_id):
            return []

    monkeypatch.setattr("victron_loop.nodes._fetch_origin_niced", lambda _cfg: False)
    checked = check_state(state, cfg, FakeGh())
    assert checked["repo_refresh_failed"] is True
    assert checked["pending_notifications"][0]["condition"] == "repo-fetch-failed"
    checked["observed"] = {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}
    result = pick_task(checked, cfg, Path("BACKLOG.md"), copilot_runner=None)
    assert result["pick"]["reason"] == "repo-refresh-failed"


def test_pick_task_reads_backlog_and_models_from_origin_master(monkeypatch, tmp_path: Path):
    local_backlog = tmp_path / "BACKLOG.md"
    local_backlog.write_text(
        "### Process and repo\n| ID | Task | State | Notes |\n|---|---|---|---|\n| LOCAL | local | open | ready |\n",
        encoding="utf-8",
    )
    origin_backlog = (
        "### Process and repo\n| ID | Task | State | Notes |\n|---|---|---|---|\n| ORIGIN | origin | open | ready |\n"
    )
    origin_models = '{"tiers":{"review":{"model":"from-origin","effort":"low"}}}'
    state = {
        "observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"},
        "approved": [],
        "daily_counts": {},
        "repo_refresh_failed": False,
    }
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock)
    calls = []

    def fake_show(_cfg, rel):
        calls.append(rel)
        if rel == "BACKLOG.md":
            return origin_backlog
        return origin_models

    class Out:
        stdout = '{"row_id":"ORIGIN","branch":"origin","tier":"standard","brief":"x"}'

    monkeypatch.setattr("victron_loop.nodes._git_show_origin_file", fake_show)
    result = pick_task(state, cfg, local_backlog, copilot_runner=lambda *_a, **_k: Out())
    assert result["pick"]["row_id"] == "ORIGIN"
    assert calls == ["BACKLOG.md", "tools/herdr/models.json"]


def test_fetch_origin_niced_uses_nice_and_timeout(monkeypatch, tmp_path: Path):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock, repo_path=tmp_path)
    seen = {}

    class Result:
        returncode = 0

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["timeout"] = kwargs.get("timeout")
        return Result()

    monkeypatch.setattr(nodes.subprocess, "run", fake_run)
    assert nodes._fetch_origin_niced(cfg, timeout_seconds=77) is True
    assert seen["cmd"][0] == "bash"
    assert "nice -n 19" in seen["cmd"][2]
    assert seen["timeout"] == 77

