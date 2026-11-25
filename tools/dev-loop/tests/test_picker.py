import json
import subprocess
from types import SimpleNamespace

import pytest

from victron_loop import main, nodes


@pytest.fixture
def picker(monkeypatch, tmp_path):
    backlog = "| R4 | Process task | open | ready |"
    monkeypatch.setattr(nodes, "_git_show_origin_file", lambda cfg, path: (
        "### Process and repo\n| ID | Task | State | Notes |\n|---|---|---|---|\n" + backlog
        if path == "BACKLOG.md" else '{"tiers":{"review":{"model":"m1","effort":"low"}}}'
    ))
    monkeypatch.setattr(nodes.shutil, "which", lambda name: name)
    cfg = nodes.LoopConfig(repo="owner/repo", dry_run=False, worker_backend="headless",
                           picker_backend="claude", claude_bin="claude")
    state = {"observed": {"open_prs": [], "deploy_applied": True, "deploy_health": "success"}}
    return cfg, state, tmp_path / "BACKLOG.md"


def reply():
    return json.dumps(dict(row_id="R4", branch="../../bad", tier="standard", brief="Do the work"))


@pytest.mark.parametrize("supports_effort", [True, False])
def test_claude_picker_stdin_and_envelope(picker, supports_effort):
    cfg, state, path = picker
    cfg.picker_effort = "low"

    def run(command, **kwargs):
        if command[1:] == ["--help"]:
            return SimpleNamespace(stdout="  --effort <level>" if supports_effort else "")
        assert command[1:12] == [
            "-p", "--model", "claude-opus-5-5", "--output-format", "json",
            "--max-turns", "1", "--permission-mode", "plan", "--disallowedTools",
            "Bash,Edit,Write,WebFetch,WebSearch",
        ]
        assert command[command.index("--tools") + 1] == ""
        assert ("--effort" in command) is supports_effort
        assert "Backlog data: " in kwargs["input"] and "Process task" in kwargs["input"]
        assert not any("Process task" in arg for arg in command)
        return SimpleNamespace(stdout=json.dumps({"result": reply()}))

    nodes.pick_task(state, cfg, path, run)
    assert state["picker_status"] == "ok"
    assert state["pick"]["branch"] == "r4"


@pytest.mark.parametrize("stdout", ["not JSON", '{"result":"not JSON"}'])
def test_claude_bad_json(picker, stdout):
    cfg, state, path = picker
    nodes.pick_task(state, cfg, path, lambda *_a, **_kw: SimpleNamespace(stdout=stdout))
    assert state["pick"]["reason"] == "pick-task-error"


def auth_error(command, **kwargs):
    raise subprocess.CalledProcessError(1, command, stderr="Please run /login (401)")


@pytest.mark.parametrize("fallback", [None, "copilot"])
def test_claude_auth_notifies_once_and_fallback_is_opt_in(picker, monkeypatch, fallback):
    cfg, state, path = picker
    cfg.picker_fallback = fallback
    notifications = []
    copilot_calls = []
    monkeypatch.setattr(nodes, "desktop_notify", lambda *args: notifications.append(args[-1]))

    def run(command, **kwargs):
        if "input" in kwargs:
            auth_error(command, **kwargs)
        copilot_calls.append(command)
        return SimpleNamespace(stdout=reply())

    for _ in range(2):
        nodes.pick_task(state, cfg, path, run)
        nodes.notify(state, cfg, daily_summary=False)

    assert state["picker_status"] == "auth required"
    assert notifications == [nodes.CLAUDE_AUTH_HINT]
    if fallback:
        assert len(copilot_calls) == 2
        assert state["pick"]["row_id"] == "R4"
    else:
        assert copilot_calls == []
        assert state["pick"]["reason"] == "claude-auth-required"


@pytest.mark.parametrize("authenticated", [True, False])
def test_check_picker_cli(tmp_path, monkeypatch, capsys, authenticated):
    config = tmp_path / "config.toml"
    config.write_text('repo = "owner/repo"\nclaude_bin = "claude"\n', encoding="utf-8")
    monkeypatch.setattr(nodes.shutil, "which", lambda name: name)

    def run(command, **kwargs):
        assert kwargs["input"] == 'Reply with JSON {"ok":true}'
        if not authenticated:
            auth_error(command, **kwargs)
        return SimpleNamespace(stdout='{"result":"{\\"ok\\":true}"}')

    monkeypatch.setattr(nodes.subprocess, "run", run)
    assert main.main(["--config", str(config), "check-picker"]) == (0 if authenticated else 1)
    assert capsys.readouterr().out.strip() == (
        "ok" if authenticated else f"claude-auth-required: {nodes.CLAUDE_AUTH_HINT}"
    )
