import json
import subprocess
from types import SimpleNamespace

import pytest

from victron_loop import main, nodes
from victron_loop.state import StateStore


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
    return json.dumps(dict(row_id="R4", branch="../../bad", tier="standard", brief='Do the {work} with "quotes"'))


@pytest.mark.parametrize("wrapper", ["{}", "```json\n{}\n```", "Here you go:\n{}\nThanks!"])
def test_claude_picker_stdin_and_envelope(picker, wrapper):
    cfg, state, path = picker

    def run(command, **kwargs):
        assert command[1:14] == [
            "-p", "--model", "claude-opus-5-5", "--effort", "low", "--output-format", "json",
            "--max-turns", "1", "--permission-mode", "plan", "--disallowedTools",
            "Bash,Edit,Write,WebFetch,WebSearch",
        ]
        assert command[command.index("--tools") + 1] == ""
        assert "Backlog data: " in kwargs["input"] and "Process task" in kwargs["input"]
        assert "no code fence, no other text" in kwargs["input"]
        assert not any("Process task" in arg for arg in command)
        return SimpleNamespace(stdout=json.dumps({"result": wrapper.format(reply())}))

    nodes.pick_task(state, cfg, path, run)
    assert state["picker_status"] == "ok"
    assert state["pick"]["branch"] == "r4"


@pytest.mark.parametrize("wrapper", ["{}", "```json\n{}\n```", "Here you go:\n{}\nThanks!"])
def test_copilot_picker_reply(picker, wrapper):
    cfg, state, path = picker
    cfg.picker_backend = "copilot"
    nodes.pick_task(state, cfg, path, lambda *_a, **_kw: SimpleNamespace(stdout=wrapper.format(reply())))
    assert state["pick"]["branch"] == "r4"


@pytest.mark.parametrize(("stdout", "message"), [
    ("not JSON", "Invalid Claude CLI JSON envelope"),
    ('{"result":"not JSON"}', "Invalid picker JSON"),
    ('{"is_error":true}', "Claude CLI reported an error"),
    ('{"type":"result"}', "Claude CLI envelope missing a string result"),
])
def test_claude_bad_json(picker, stdout, message):
    cfg, state, path = picker
    cfg.picker_fallback = "copilot"
    calls = []

    def run(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout=stdout)

    nodes.pick_task(state, cfg, path, run)
    assert state["pick"]["reason"] == "pick-task-error"
    assert state["pick"]["error"].startswith(message)
    assert "raw reply:" in state["pick"]["error"]
    assert len(calls) == 1


def test_picker_diagnostic_reaches_cycle_output_and_decisions(picker, tmp_path, monkeypatch, capsys):
    from victron_loop import graph

    cfg, state, path = picker
    raw = "garbage ghp_fakecredential " + "\u00f8" * 4096 + " beyond limit"
    monkeypatch.setattr(graph, "build_graph", lambda *_: SimpleNamespace(invoke=lambda _: nodes.pick_task(
        state, cfg, path, lambda *_a, **_kw: SimpleNamespace(stdout=json.dumps({"result": raw}))
    )))
    store = StateStore.open(tmp_path)

    assert main.run_tick(store, cfg, gh=None) == "pick-task-error"
    error = json.loads(capsys.readouterr().out)["error"]
    assert "garbage [redacted]" in error
    assert "fakecredential" not in error
    assert "beyond limit" not in error
    assert len(error.split("raw reply: ", 1)[1].encode("utf-8")) <= 4096
    assert json.loads(store.log_file.read_text(encoding="utf-8"))["errors"] == {"picker": error}


def auth_error(command, **kwargs):
    raise subprocess.CalledProcessError(1, command, stderr="Please run /login (401)")


@pytest.mark.parametrize("fallback", [None, "copilot"])
@pytest.mark.parametrize("error_envelope", [False, True])
def test_claude_auth_notifies_once_and_fallback_is_opt_in(picker, monkeypatch, fallback, error_envelope):
    cfg, state, path = picker
    cfg.picker_fallback = fallback
    notifications = []
    copilot_calls = []
    monkeypatch.setattr(nodes, "desktop_notify", lambda *args: notifications.append(args[-1]))

    def run(command, **kwargs):
        if "input" in kwargs:
            if error_envelope:
                return SimpleNamespace(stdout='{"is_error":true,"result":"Please run /login"}')
            auth_error(command, **kwargs)
        copilot_calls.append(command)
        return SimpleNamespace(stdout=reply())

    for _ in range(2):
        nodes.pick_task(state, cfg, path, run)
        nodes.notify(state, cfg, daily_summary=False)

    assert state["picker_status"] == "auth required"
    assert notifications == ["Run claude auth login"]
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
        "ok" if authenticated else "claude-auth-required: Run claude auth login"
    )
