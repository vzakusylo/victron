from __future__ import annotations

import json
import subprocess
from pathlib import Path

from victron_loop.gh import GhCli
from victron_loop.nodes import LoopConfig, check_state, evaluate_plan, notify, parse_backlog, pick_task, requires_owner_approval
import victron_loop.nodes as nodes

FIXTURES = Path(__file__).with_name("fixtures")


def test_real_backlog_tables_and_approval():
    text = (FIXTURES / "BACKLOG.sample.md").read_text(encoding="utf-8")
    plan = evaluate_plan({}, text)
    eligible = [row["row_id"] for row in plan["eligible"]]
    assert len(eligible) == 2 and len(set(eligible)) == 2
    assert all(row_id.startswith(("worst-case-", "an-interrupted-")) for row_id in eligible)
    skipped = {row["row_id"]: row["reason"] for row in plan["skipped"]}
    assert skipped["AUTO1"] == skipped["P-R1"] == skipped["2"] == "done"
    assert skipped["NR8"] == skipped["B6"] == skipped["G3-TRACKING"] == skipped["H9"] == "needs-owner-go"
    assert skipped["G3-DAILY"] == "in progress"
    assert "#195" not in skipped and "EXCLUDED" not in skipped
    approved = evaluate_plan({"approved": ["NR8", "G3-TRACKING", "AI1", "B6"]}, text)
    assert [row["row_id"] for row in approved["eligible"][:4]] == ["G3-TRACKING", "NR8", "AI1", "B6"]


def test_check_state_recorded_runs_show_pending_then_applied(tmp_path):
    fixtures = json.loads((FIXTURES / "gh-runs.json").read_text(encoding="utf-8"))

    def run(cmd, _env):
        if cmd[1:3] == ["pr", "list"]:
            return "[]"
        if cmd[1:3] == ["run", "list"]:
            assert cmd[cmd.index("--branch") + 1] == "master"
            return json.dumps(fixtures[cmd[cmd.index("--workflow") + 1]])
        assert cmd[1:3] == ["run", "view"]
        return json.dumps(fixtures[cmd[3]])

    cfg = LoopConfig(repo="test/repo")
    gh = GhCli(cfg.repo, runner=run)
    state = check_state({}, cfg, gh)
    assert state["observed"]["test_gx"]["conclusion"] == "success"
    assert state["observed"]["deploy_health"] == "pending"
    assert not state["observed"]["deploy_applied"]
    assert not state.get("pending_notifications")
    assert pick_task(state, cfg, tmp_path / "BACKLOG.md")["pick"]["reason"] == "deploy-pending"
    fixtures["deploy-gx-code.yml"].pop(0)
    observed = check_state({}, cfg, gh)["observed"]
    assert observed["deploy"]["databaseId"] == 45635100399
    assert observed["deploy_applied"] and observed["deploy_health"] == "success"
    fixtures["45635100399"]["jobs"][0]["steps"][0]["conclusion"] = "skipped"
    assert not check_state({}, cfg, gh)["observed"]["deploy_applied"]
    fixtures["deploy-gx-code.yml"].pop()
    skipped = check_state({}, cfg, gh)
    assert pick_task(skipped, cfg, tmp_path / "BACKLOG.md")["pick"]["reason"] == "deploy-all-skipped"


def test_gh_failure_blocks_picking_and_notifies_once(tmp_path, monkeypatch):
    monkeypatch.setattr(nodes, "_fetch_origin_niced", lambda _: True)
    sent = []
    monkeypatch.setattr(nodes.subprocess, "run", lambda command, **_: sent.append(command))

    def run(cmd, _env):
        if "test-gx.yml" in cmd:
            raise RuntimeError("HTTP 403: Actions read permission required")
        return "[]"

    cfg = LoopConfig(repo="test/repo", dry_run=False)
    gh = GhCli(cfg.repo, runner=run)
    state = {}
    for _ in range(2):
        check_state(state, cfg, gh)
        assert "HTTP 403" in state["observed"]["errors"]["test-gx"]
        assert pick_task(state, cfg, tmp_path / "BACKLOG.md")["pick"]["reason"] == "gh-observation-error"
        notify(state, cfg)
    assert sum("HTTP 403" in command[-1] for command in sent) == 1


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

