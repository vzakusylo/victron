from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from victron_loop import herdr, main, nodes, web
from victron_loop.control import apply_control
from victron_loop.state import StateStore


def test_herdr_launch_commands_and_brief(tmp_path, monkeypatch):
    repo, worktree = tmp_path / "main checkout", tmp_path / "worker"
    worktree.mkdir()
    log = tmp_path / "logs" / "fix.log"
    prefix = ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(repo / "tools" / "herdr" / "herdr-task.ps1")]
    calls = []

    def launch(cmd, **kwargs):
        calls.append(cmd)
        assert kwargs["timeout"] == 150
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["capture_output"] is True
        assert kwargs.get("creationflags") == herdr.priority_options().get("creationflags")
        return subprocess.CompletedProcess(cmd, 0, json.dumps({
            "agent": "w-fix", "worktree": str(worktree), "model": "gpt-x",
        }), "")

    def detached(cmd, **kwargs):
        calls.append(cmd)
        assert (worktree / ".copilot-brief-fix.md").read_text(encoding="utf-8") == "A brief"
        assert kwargs["stderr"] == herdr.subprocess.STDOUT
        assert kwargs.get("start_new_session") or kwargs.get("creationflags")

    monkeypatch.setattr(herdr.subprocess, "run", launch)
    monkeypatch.setattr(herdr.subprocess, "Popen", detached)
    assert herdr.start(repo, "fix", "standard", "A brief", log) == {
        "agent": "w-fix", "worktree": str(worktree), "model": "gpt-x",
    }
    assert calls == [
        [*prefix, "new", "fix", "-Repo", str(repo), "-Base", "origin/master", "-Tier", "standard", "-Json"],
        [*prefix, "send", "fix", "Read .copilot-brief-fix.md and do all of it."],
    ]


def test_herdr_launch_failure_includes_both_output_tails(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda cmd, **_: subprocess.CompletedProcess(
        cmd, 64, "discard-me" + "x" * 2048 + "usage tail", "script not found",
    ))
    with pytest.raises(subprocess.SubprocessError, match=r"exited 64") as error:
        herdr.start(tmp_path, "fix", "standard", "brief", tmp_path / "fix.log")
    assert "usage tail" in str(error.value)
    assert "stderr: script not found" in str(error.value)
    assert "discard-me" not in str(error.value)


@pytest.mark.skipif(sys.platform != "win32" or not shutil.which("pwsh"),
                    reason="requires Windows PowerShell 7")
@pytest.mark.parametrize("script_exists", [True, False])
def test_foreground_cycle_captures_native_pwsh_stderr(
    tmp_path, monkeypatch, block_real_external_subprocesses, script_exists,
):
    repo = tmp_path / "main checkout"
    script = repo / "tools" / "herdr" / "herdr-task.ps1"
    script.parent.mkdir(parents=True)
    if script_exists:
        script.write_text("[Console]::Error.WriteLine('fake launcher diagnostic')\nexit 64\n", encoding="utf-8")
    cfg = nodes.LoopConfig(repo="test/repo", repo_path=repo)
    store = StateStore.open(tmp_path / "state")

    def tick(*_):
        herdr.start(repo, "fix", "standard", "brief", tmp_path / "fix.log")

    block_real_external_subprocesses.add((
        "pwsh", "-NoProfile", "-NonInteractive", "-File", str(script),
        "new", "fix", "-Repo", str(repo), "-Base", "origin/master", "-Tier", "standard", "-Json",
    ))
    monkeypatch.setattr(main, "run_tick", tick)
    assert main.run_cycle(store, cfg, None, echo=False) == (1, "failed")
    log = store.run_logs()[0].read_text(encoding="utf-8")
    assert "exited 64" in log
    expected = "stderr: fake launcher diagnostic" if script_exists else "is not recognized as the name of a script file"
    assert expected in log


@pytest.mark.parametrize("succeeds", [True, False])
def test_herdr_start_retries_saved_pick(tmp_path, monkeypatch, succeeds):
    cfg = nodes.LoopConfig(repo="test/repo", repo_path=tmp_path, worker_backend="herdr",
                           dry_run=False, loop_home=tmp_path)
    observed = {"deploy_applied": True, "deploy_health": "success"}
    pick = {"row_id": "FIX", "branch": "fix", "brief": "same brief", "tier": "standard"}
    store = StateStore.open(tmp_path)
    store.save({"pick": pick, "observed": observed})
    calls, messages = [], []

    def launch(repo, branch, tier, brief, log):
        calls.append((branch, tier, brief))
        if succeeds and len(calls) == 2:
            return {"agent": "w-fix", "worktree": str(repo), "model": "gpt-x"}
        raise subprocess.SubprocessError(f"stderr: launch error {len(calls)}")

    monkeypatch.setattr(herdr, "running", lambda: True)
    monkeypatch.setattr(herdr, "start", launch)
    monkeypatch.setattr(nodes, "desktop_notify", lambda _, title, message: messages.append(message))
    for cycle in range(2 if succeeds else 4):
        state = store.load()
        if cycle:
            nodes.pick_task(state, cfg, tmp_path / "missing-backlog.md")
        nodes.start_worker(state, cfg)
        nodes.notify(state, cfg, daily_summary=False)
        store.save(state)
    assert calls == [("fix", "standard", "same brief")] * (2 if succeeds else 3)
    if succeeds:
        assert state["pending_herdr_start"] is None
        assert state["active_worker"]["branch"] == "fix"
        assert len(messages) == 1
    else:
        assert state["pick"]["reason"] == "herdr-start-blocked"
        assert state["pending_herdr_start"]["attempts"] == 3
        assert len(messages) == 3
        assert "operator intervention required" in messages[-1]
        apply_control(store, cfg, "skip", "FIX")
        assert store.load()["pending_herdr_start"] is None
    assert all(f"stderr: launch error {i}" in msg for i, msg in enumerate(messages, 1))


def test_herdr_status_and_read(tmp_path, monkeypatch):
    # Trimmed from Herdr 0.9.5 agent list.
    sample = '{"result":{"agents":[{"agent":"copilot","agent_status":"idle","name":"w-fix","pane_id":"w4:p1"}]}}'
    calls = []

    def command(cmd, **_):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, sample if cmd[0] == "herdr" else "first\nsecond\n", "")

    monkeypatch.setattr(herdr.subprocess, "run", command)
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
    monkeypatch.setattr(herdr.subprocess, "run",
                        lambda cmd, **_: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
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
