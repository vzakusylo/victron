from __future__ import annotations

from pathlib import Path

import victron_loop.nodes as nodes
from victron_loop.nodes import LoopConfig, watch_pr


def fixed_clock():
    return 4102444800.0  # 2100-01-01


class FakeGh:
    def __init__(self, *, open_prs=None, merged_prs=None, test_runs=None, deploy_runs=None, health="success"):
        self._open_prs = open_prs or []
        self._merged_prs = merged_prs or []
        self._test_runs = test_runs or []
        self._deploy_runs = deploy_runs or []
        self._health = health
        self.disabled_auto = []

    def list_prs(self, state="open", head_branch=None):
        if state == "open":
            return self._open_prs
        if state == "merged":
            return self._merged_prs
        return []

    def list_runs(self, workflow, branch, limit):
        if workflow == "test-gx.yml":
            return self._test_runs
        return self._deploy_runs

    def view_run_jobs(self, run_id):
        return [{"steps": [{"name": "Monitor post-deploy health", "conclusion": self._health}]}]

    def list_pr_files(self, number):
        return []

    def disable_pr_auto_merge(self, number):
        self.disabled_auto.append(number)


def test_watch_pr_second_failure_marks_failed():
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {
        "active_worker": {"branch": "b1", "row_id": "R1", "retry_count": 1, "worktree": "/tmp/x", "log_path": "/tmp/x.log"},
        "failed_rows": [],
    }
    gh = FakeGh(
        open_prs=[{"reviewDecision": "CHANGES_REQUESTED", "statusCheckRollup": []}],
    )
    watch_pr(state, cfg, gh)
    assert state["active_worker"] is None
    assert "R1" in state["failed_rows"]
    assert state["pending_notifications"][0]["condition"] == "worker-failed"


def test_watch_pr_failing_checks_retries_once(monkeypatch):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock)
    state = {
        "active_worker": {
            "branch": "b1",
            "row_id": "R1",
            "retry_count": 0,
            "tier": "standard",
            "worktree": "/tmp/x",
            "log_path": "/tmp/x.log",
        }
    }
    gh = FakeGh(
        open_prs=[{"reviewDecision": "APPROVED", "statusCheckRollup": [{"status": "completed", "conclusion": "failure"}]}],
    )

    called = {}

    def fake_retry(_state, _cfg, worker, text):
        called["text"] = text
        worker["retry_count"] = 1
        worker["pid"] = 987

    monkeypatch.setattr(nodes, "_retry_worker", fake_retry)
    watch_pr(state, cfg, gh)
    assert called["text"].startswith("PR checks/review failed")
    assert state["active_worker"]["retry_count"] == 1
    assert state["active_worker"]["pid"] == 987


def test_watch_pr_changes_requested_retries_once(monkeypatch):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock)
    state = {
        "active_worker": {
            "branch": "b1",
            "row_id": "R1",
            "retry_count": 0,
            "tier": "standard",
            "worktree": "/tmp/x",
            "log_path": "/tmp/x.log",
        }
    }
    gh = FakeGh(open_prs=[{"reviewDecision": "CHANGES_REQUESTED", "statusCheckRollup": []}])
    monkeypatch.setattr(nodes, "_retry_worker", lambda *_args, **_kwargs: state["active_worker"].update({"retry_count": 1}))
    watch_pr(state, cfg, gh)
    assert state["active_worker"]["retry_count"] == 1


def test_watch_pr_success_after_merge_clears_worker(monkeypatch):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {"active_worker": {"branch": "b1", "row_id": "R1", "retry_count": 0, "worktree": "/tmp/x", "log_path": "/tmp/x.log"}}
    gh = FakeGh(
        merged_prs=[{"mergeCommit": {"oid": "a"}}],
        test_runs=[{"headSha": "b", "conclusion": "success"}],
        deploy_runs=[{"databaseId": 1, "headSha": "b", "conclusion": "success"}],
        health="success",
    )
    monkeypatch.setattr(nodes, "_is_run_for_or_after_merge", lambda _cfg, _m, _r: True)
    watch_pr(state, cfg, gh)
    assert state["active_worker"] is None


def test_watch_pr_idle_for_30_minutes_notifies(tmp_path: Path):
    log = tmp_path / "worker.log"
    log.write_text("no updates", encoding="utf-8")
    old_mtime = int(log.stat().st_mtime)
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {
        "active_worker": {"branch": "b1", "row_id": "R1", "retry_count": 0, "worktree": str(tmp_path), "log_path": str(log), "last_log_mtime": old_mtime},
    }
    gh = FakeGh()
    watch_pr(state, cfg, gh)
    assert state["pending_notifications"][0]["condition"] == "worker-idle"


def test_watch_pr_unapproved_live_control_disables_auto_merge():
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {"approved": [], "active_worker": {"branch": "b1", "row_id": "R1", "retry_count": 0, "worktree": "/tmp/x", "log_path": "/tmp/x.log"}}

    class FilesGh(FakeGh):
        def list_pr_files(self, number):
            return ["flows.json"]

    gh = FilesGh(open_prs=[{"number": 10, "reviewDecision": "APPROVED", "statusCheckRollup": []}])
    watch_pr(state, cfg, gh)
    assert gh.disabled_auto == [10]
    assert state["pending_notifications"][0]["condition"] == "unapproved-live-control-pr"


def test_watch_pr_uses_merge_base_not_string_compare(monkeypatch):
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=True, clock=fixed_clock)
    state = {"active_worker": {"branch": "b1", "row_id": "R1", "retry_count": 0, "worktree": "/tmp/x", "log_path": "/tmp/x.log"}}
    gh = FakeGh(
        merged_prs=[{"mergeCommit": {"oid": "ffff"}}],
        test_runs=[{"headSha": "0001", "conclusion": "success"}],
        deploy_runs=[{"databaseId": 1, "headSha": "0001", "conclusion": "success"}],
        health="success",
    )
    monkeypatch.setattr(nodes, "_is_run_for_or_after_merge", lambda *_args, **_kwargs: True)
    watch_pr(state, cfg, gh)
    assert state["active_worker"] is None


def test_is_run_for_or_after_merge_uses_git_ancestor_check(monkeypatch, tmp_path: Path):
    cfg = LoopConfig(repo="vzakusylo/victron", repo_path=tmp_path, dry_run=True, clock=fixed_clock)

    class Result:
        returncode = 0

    calls = {}

    def fake_run(cmd, **_kwargs):
        calls["cmd"] = cmd
        return Result()

    monkeypatch.setattr(nodes.subprocess, "run", fake_run)
    assert nodes._is_run_for_or_after_merge(cfg, "ffff", "0001") is True
    assert "merge-base" in calls["cmd"]


def test_watch_pr_checks_dead_pid_before_idle(monkeypatch, tmp_path: Path):
    log = tmp_path / "worker.log"
    log.write_text("x", encoding="utf-8")
    cfg = LoopConfig(repo="vzakusylo/victron", dry_run=False, clock=fixed_clock)
    state = {
        "active_worker": {
            "branch": "b1",
            "row_id": "R1",
            "retry_count": 0,
            "tier": "standard",
            "pid": 4321,
            "worktree": str(tmp_path),
            "log_path": str(log),
            "last_log_mtime": int(log.stat().st_mtime),
        }
    }
    monkeypatch.setattr(nodes, "_pid_alive", lambda _pid: False)
    monkeypatch.setattr(nodes, "_retry_worker", lambda _s, _c, w, _t: w.update({"retry_count": 1}))
    watch_pr(state, cfg, FakeGh())
    assert state["active_worker"]["retry_count"] == 1

