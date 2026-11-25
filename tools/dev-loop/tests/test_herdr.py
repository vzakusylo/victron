from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from victron_loop import herdr, nodes, web
from victron_loop.control import apply_control
from victron_loop.state import StateStore


def test_herdr_launch_commands_and_brief(tmp_path, monkeypatch):
    repo, worktree = tmp_path / "main checkout", tmp_path / "worker"
    worktree.mkdir()
    log = tmp_path / "logs" / "fix.log"
    prefix = ["pwsh", "-NoProfile", "-File", str(repo / "tools" / "herdr" / "herdr-task.ps1")]
    calls = []

    def launch(cmd, **kwargs):
        calls.append(cmd)
        assert kwargs["timeout"] == 150
        return json.dumps({"agent": "w-fix", "worktree": str(worktree), "model": "gpt-x"})

    def detached(cmd, **kwargs):
        calls.append(cmd)
        assert (worktree / ".copilot-brief-fix.md").read_text(encoding="utf-8") == "A brief"
        assert kwargs["stderr"] == herdr.subprocess.STDOUT
        assert kwargs.get("start_new_session") or kwargs.get("creationflags")

    monkeypatch.setattr(herdr.subprocess, "check_output", launch)
    monkeypatch.setattr(herdr.subprocess, "Popen", detached)
    assert herdr.start(repo, "fix", "standard", "A brief", log) == {
        "agent": "w-fix", "worktree": str(worktree), "model": "gpt-x",
    }
    assert calls == [
        [*prefix, "new", "fix", "-Repo", str(repo), "-Base", "origin/master", "-Tier", "standard", "-Json"],
        [*prefix, "send", "fix", "Read .copilot-brief-fix.md and do all of it."],
    ]


def test_herdr_status_and_read(tmp_path, monkeypatch):
    # Trimmed from Herdr 0.9.5 agent list.
    sample = '{"result":{"agents":[{"agent":"copilot","agent_status":"idle","name":"w-fix","pane_id":"w4:p1"}]}}'
    calls = []

    def command(cmd, **_):
        calls.append(cmd)
        return sample if cmd[0] == "herdr" else "first\nsecond\n"

    monkeypatch.setattr(herdr.subprocess, "check_output", command)
    assert herdr.status("w-fix") == "idle"
    assert herdr.status("w-missing") == "missing"
    assert calls[0] == ["herdr", "agent", "list"]
    store = StateStore.open(tmp_path)
    store.save({"active_worker": {"backend": "herdr", "branch": "fix"}})
    cfg = nodes.LoopConfig(repo="test/repo", repo_path=tmp_path)
    assert web.read_logs(store, "worker", 80, cfg) == ["second", "first"]
    assert calls[-1][-4:] == ["read", "fix", "-Lines", "80"]


def test_herdr_not_running_blocks_start_and_notifies_once(monkeypatch):
    cfg = nodes.LoopConfig(repo="test/repo", worker_backend="herdr", dry_run=False)
    calls, messages = [], []
    monkeypatch.setattr(herdr.subprocess, "run",
                        lambda cmd, **_: calls.append(cmd) or SimpleNamespace(returncode=0, stdout="  status: stopped"))
    monkeypatch.setattr(nodes, "desktop_notify", lambda _, title, message: messages.append((title, message)))
    state = {}
    for _ in range(2):
        state["pick"] = {"branch": "fix"}
        nodes.start_worker(state, cfg)
        assert state["pick"] == {"reason": "herdr-not-running"}
        nodes.notify(state, cfg, daily_summary=False)
    assert "active_worker" not in state
    assert calls == [["herdr", "status"]] * 2
    assert len(messages) == 1


def test_herdr_retry_and_close_after_merge(tmp_path, monkeypatch):
    cfg = nodes.LoopConfig(repo="test/repo", repo_path=tmp_path, worker_backend="herdr", dry_run=False)
    worker = {"branch": "fix", "agent": "w-fix", "worktree": str(tmp_path), "backend": "herdr",
              "log_path": str(tmp_path / "fix.log")}
    brief = tmp_path / ".copilot-brief-fix.md"
    brief.touch()
    state = {"active_worker": worker}
    calls = []
    monkeypatch.setattr(herdr, "status", lambda _: "done")
    monkeypatch.setattr(herdr, "send", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(herdr.subprocess, "run", lambda cmd, **_: calls.append(cmd))
    monkeypatch.setattr(nodes, "_fetch_origin_niced", lambda _: True)
    failing = SimpleNamespace(list_prs=lambda *_args, **_kw: [{"reviewDecision": "CHANGES_REQUESTED"}])
    nodes.watch_pr(state, cfg, failing)
    assert calls == [
        ((tmp_path, "fix", "PR checks/review failed. Fix and continue.", Path(worker["log_path"])),
         {"failure_file": tmp_path / "fix.retry-failed"}),
    ]
    assert worker["retry_count"] == 1
    merged = SimpleNamespace(list_prs=lambda pr_state, **_: [{"number": 2}] if pr_state == "merged" else [])
    nodes.watch_pr(state, cfg, merged)
    nodes.watch_pr(state, cfg, merged)
    assert calls[1][-3:] == ["close", "fix", "-IfPresent"]
    assert len(calls) == 2 and worker["herdr_closed"]
    assert not brief.exists()


def test_herdr_reports_detached_retry_failure(tmp_path, monkeypatch):
    log = tmp_path / "fix.log"
    failure_file = tmp_path / "fix.retry-failed"
    captured = []
    monkeypatch.setattr(herdr.subprocess, "Popen", lambda cmd, **_: captured.append(cmd))
    herdr.send(tmp_path, "fix", "fix the checks", log, failure_file=failure_file)
    assert captured[0][-2:] == ["-PromptFailureFile", str(failure_file)]
    failure_file.write_text("failed", encoding="utf-8")
    cfg = nodes.LoopConfig(repo="test/repo", dry_run=False)
    worker = {"branch": "fix", "agent": "w-fix", "backend": "herdr", "retry_failure_file": str(failure_file)}
    state = {"active_worker": worker}
    monkeypatch.setattr(herdr, "status", lambda _: "working")
    nodes.watch_pr(state, cfg, SimpleNamespace(list_prs=lambda *_args, **_kwargs: []))
    assert state["pending_notifications"][0]["condition"] == "herdr-retry-failed"


def test_merged_worker_already_closed_by_owner_reaches_done(tmp_path, monkeypatch):
    cfg = nodes.LoopConfig(repo="test/repo", dry_run=False)
    worker = {"branch": "fix", "agent": "w-fix", "worktree": str(tmp_path / "removed"), "backend": "herdr"}
    state = {"active_worker": worker}
    monkeypatch.setattr(herdr, "status", lambda _: "missing")
    monkeypatch.setattr(nodes, "_fetch_origin_niced", lambda _: True)
    monkeypatch.setattr(nodes, "_is_run_for_or_after_merge", lambda *_: True)
    gh = SimpleNamespace(
        list_prs=lambda pr_state, **_: [{"number": 2, "mergeCommit": {"oid": "merged"}}] if pr_state == "merged" else [],
        list_runs=lambda *_: [{"conclusion": "success", "headSha": "merged", "databaseId": 1}],
        view_run_jobs=lambda _: [{"steps": [{"name": "Monitor post-deploy health", "conclusion": "success"}]}],
    )
    nodes.watch_pr(state, cfg, gh)
    assert state["active_worker"] is None
    assert state["phase"] == "done"


def test_herdr_blocked_after_thirty_minutes_and_stop_preserves_pane(tmp_path, monkeypatch):
    now = [1000]
    cfg = nodes.LoopConfig(repo="test/repo", dry_run=False, clock=lambda: now[0])
    store = StateStore.open(tmp_path)
    worker = {"branch": "fix", "agent": "w-fix", "row_id": "FIX", "backend": "herdr"}
    state = {"active_worker": worker}
    monkeypatch.setattr(herdr, "status", lambda _: "blocked")
    gh = SimpleNamespace(list_prs=lambda *_args, **_kwargs: [])
    nodes.watch_pr(state, cfg, gh)
    assert not state.get("pending_notifications")
    now[0] += 1801
    nodes.watch_pr(state, cfg, gh)
    assert state["pending_notifications"][0]["condition"] == "worker-idle"
    store.save(state)
    attempts = []
    monkeypatch.setattr(herdr, "interrupt", lambda agent: attempts.append(agent) or False)
    assert "check its Herdr pane" in apply_control(store, cfg, "stop-worker", "yes")["message"]
    assert attempts == ["w-fix"]
    assert store.load()["last_worker"]["status"] == "stopped"
    assert store.load()["paused"]
