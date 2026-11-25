import json
import subprocess
from datetime import datetime, timedelta, timezone

import pytest

from victron_loop.gh import GhCli
from victron_loop.nodes import LoopConfig, check_state, notify, pick_task


@pytest.mark.parametrize("empty", [False, True])
def test_missing_token_blocks_without_gh_login(tmp_path, empty):
    token_file = tmp_path / "token"
    if empty:
        token_file.write_text(" \n", encoding="utf-8")
    calls = []

    def run(command, env):
        calls.append((command, env))
        return "[]"

    gh = GhCli("test/repo", token_file=token_file, runner=run)
    cfg = LoopConfig(repo=gh.repo, token_file=token_file)
    state = {}
    for _ in range(2):
        check_state(state, cfg, gh)
        assert pick_task(state, cfg, tmp_path / "BACKLOG.md")["pick"]["reason"] == "token-missing"
        notify(state, cfg)
    assert calls == []
    assert list(state["notifications_sent"]) == ["token-missing:github"]

    gh.allow_gh_login_fallback = True
    assert gh.list_open_prs() == []
    assert calls[0][1] is None


def test_401_is_token_invalid_without_retry(tmp_path, monkeypatch):
    token_file = tmp_path / "token"
    token_file.write_text("synthetic-value", encoding="utf-8")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        assert kwargs["env"]["GH_TOKEN"] == "synthetic-value"
        return subprocess.CompletedProcess(command, 1, "", "gh: Bad credentials (HTTP 401)")

    monkeypatch.setattr(subprocess, "run", run)
    gh = GhCli("test/repo", token_file=token_file)
    cfg = LoopConfig(repo=gh.repo, token_file=token_file)
    state = check_state({}, cfg, gh)
    assert pick_task(state, cfg, tmp_path / "BACKLOG.md")["pick"]["reason"] == "token-invalid"
    assert state["pending_notifications"][0]["condition"] == "token-invalid"
    assert len(calls) == 1
    assert "synthetic-value" not in repr(state)


def test_warn_at_fourteen_and_three_days_once_each(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("synthetic-value", encoding="utf-8")
    expires = datetime(2026, 12, 31, 12, tzinfo=timezone.utc)
    (tmp_path / "token.meta").write_text(json.dumps({
        "expires_at": expires.isoformat(), "token_rotated_at": "2026-10-02T12:00:00Z",
    }), encoding="utf-8")
    gh = GhCli("test/repo", token_file=token_file, runner=lambda *_: "[]")
    cfg = LoopConfig(repo=gh.repo, token_file=token_file)
    state = {}
    for days in (15, 14, 14, 4, 3, 3):
        cfg.clock = lambda: (expires - timedelta(days=days)).timestamp()
        notify(check_state(state, cfg, gh), cfg)
        expected = 0 if days > 14 else 1 if days > 3 else 2
        assert len(state["notifications_sent"]) == expected
    assert set(state["notifications_sent"]) == {
        f"token-expiry-14:{expires.isoformat()}", f"token-expiry-3:{expires.isoformat()}",
    }
