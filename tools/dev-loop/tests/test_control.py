from __future__ import annotations

import http.client
import json
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from threading import Thread

import pytest

from victron_loop import control, main, web
from victron_loop.nodes import LoopConfig, evaluate_plan
from victron_loop.state import StateStore

BACKLOG = """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| A | Write docs | open | ready |
| B | Refactor tooling | open | ready |
| C | Edit live control | open | ready |
| D | Cleanup | done | shipped |
"""


def test_controls_change_deterministic_preview(tmp_path):
    store = StateStore.open(tmp_path)
    cfg = LoopConfig(repo="test/repo")
    assert evaluate_plan(store.load(), BACKLOG)["next"]["row_id"] == "A"
    apply = lambda action, value: control.apply_control(store, cfg, action, value)
    apply("skip", "A")
    assert evaluate_plan(store.load(), BACKLOG)["next"]["row_id"] == "B"
    apply("pin", "C")
    assert evaluate_plan(store.load(), BACKLOG)["next"]["row_id"] == "B"
    apply("approve", "C")
    apply("unskip", "A")
    plan = evaluate_plan(store.load(), BACKLOG)
    assert [row["row_id"] for row in plan["eligible"]] == ["C", "A", "B"]
    assert [(row["row_id"], row["reason"]) for row in plan["skipped"]] == [("D", "done")]


def test_pause_only_checks_and_resume_picks(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    config = tmp_path / "config.toml"
    config.write_text('repo = "test/repo"\n', encoding="utf-8")
    cfg = LoopConfig(repo="test/repo", repo_path=tmp_path)
    monkeypatch.setattr(main, "load_config", lambda _: cfg)
    monkeypatch.setattr(main, "GhCli", lambda **_: HealthyGh())
    from victron_loop.nodes import check_state

    calls = []

    def observe(*args):
        calls.append("check_state")
        return check_state(*args)

    monkeypatch.setattr(main, "check_state", observe)
    (tmp_path / "BACKLOG.md").write_text(BACKLOG, encoding="utf-8")
    assert main.main(["pause"]) == 0
    assert main.main(["run-once"]) == 0
    assert calls == ["check_state"]
    assert json.loads(capsys.readouterr().out)["reason"] == "paused"
    assert StateStore.open().load()["last_run"]["result"] == "paused"
    assert main.main(["resume"]) == 0
    assert main.main(["run-once"]) == 0
    assert json.loads(capsys.readouterr().out)["row_id"] == "A"


class HealthyGh:
    def list_open_prs(self):
        return []

    def list_runs(self, *_):
        return [{"databaseId": 1}]

    def view_run_jobs(self, _):
        return [{"steps": [{"name": "Deploy from master", "conclusion": "success"},
                           {"name": "Monitor post-deploy health", "conclusion": "success"}]}]


def test_stop_requires_confirmation_and_marks_stopped(tmp_path, monkeypatch):
    store = StateStore.open(tmp_path)
    store.save({"active_worker": {"row_id": "A", "pid": 42, "process_group": True, "process_start": "123"}})
    cfg = LoopConfig(repo="test/repo")
    calls = []
    monkeypatch.setattr(control, "_process_start", lambda pid: "123")
    monkeypatch.setattr(control.os, "killpg", lambda pid, sig: calls.append((pid, sig)), raising=False)
    with pytest.raises(ValueError, match="confirmation"):
        control.apply_control(store, cfg, "stop-worker")
    assert not calls
    control.apply_control(store, cfg, "stop-worker", "yes")
    state = store.load()
    assert calls == [(42, signal.SIGTERM)]
    assert state["paused"] and state["active_worker"] is None
    assert state["last_worker"]["status"] == "stopped"
    assert state["stopped_rows"] == ["A"]
    assert not state.get("failed_rows")


def test_stop_preserves_unverified_live_group(tmp_path, monkeypatch):
    store = StateStore.open(tmp_path)
    worker = {"row_id": "A", "pid": 42, "process_group": True, "process_start": None}
    store.save({"active_worker": worker})
    calls = []
    monkeypatch.setattr(control.os, "killpg", lambda pid, sig: calls.append((pid, sig)), raising=False)
    with pytest.raises(ValueError, match="Cannot verify worker process group"):
        control.apply_control(store, LoopConfig(repo="test/repo"), "stop-worker", "yes")
    assert calls == [(42, 0)]
    assert store.load()["active_worker"] == worker


@pytest.mark.parametrize("with_token", [False, True])
def test_http_page_status_and_write_guards(tmp_path, monkeypatch, with_token):
    monkeypatch.setattr(control, "WINDOWS", False)
    monkeypatch.setattr(web, "WINDOWS", False)
    cfg = LoopConfig(repo="test/repo", web_bind="127.0.0.1:0", token_file=None,
                     web_hosts=("omarchy", "omarchy.example-tailnet.ts.net"))
    if with_token:
        cfg.web_token_file = tmp_path / "web-token"
        cfg.web_token_file.write_text("test-only-token-1234", encoding="utf-8")
    store = StateStore.open(tmp_path)
    monkeypatch.setattr(web, "timer_times", lambda _: {
        "timer_last": "09:00", "timer_next": "09:10", "timer_error": "Failed to connect to bus",
    })
    cfg.token_file = tmp_path / "loop-token"
    cfg.token_file.write_text("demo-loop-scoped-token-only", encoding="utf-8")
    store.append_dry_run({"result": "gh-observation-error", "observed": {
        "test_gx": {"databaseId": 2}, "deploy_health": "pending", "errors": {"deploy": "HTTP 403"}
    }})
    store.record_run({"id": "1234567890123456789", "at": 1, "result": "idle"}, "old\n")
    store.record_run({"id": "1234567890123456790", "at": 2, "result": "idle", "dry_run": True},
                     "first\n\x1b[31mERROR\x1b[0m ghp_fake_secret_token\nlast\n")
    unit_status = "inactive"
    commands = []

    def git(cmd, **_):
        if cmd[:3] == ["systemctl", "--user", "show"]:
            return unit_status
        if cmd[0] == "journalctl":
            commands.append(cmd)
            return "first\nnewest\n"
        if cmd[-2:] == ["rev-parse", "origin/master"]:
            return "commit123\n"
        assert cmd[-2:] == ["show", "commit123:BACKLOG.md"]
        return BACKLOG

    monkeypatch.setattr(control.subprocess, "check_output", git)
    monkeypatch.setattr(control.subprocess, "run", lambda cmd, **_: commands.append(cmd))
    with web.make_server(cfg, store) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()

        auth = {}

        def request(method, path, headers=None, body=None):
            with_connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                with_connection.request(method, path, body=body, headers={**auth, **(headers or {})})
                response = with_connection.getresponse()
                return response.status, response.read(), response.getheader("X-CSRF-Token") or response.getheader("Set-Cookie")
            finally:
                with_connection.close()

        try:
            status, body, _ = request("GET", "/api/peer-status")
            assert status == 200 and json.loads(body) == {
                "instance_name": cfg.instance_name, "paused": False, "live": False,
            }
            if with_token:
                import re

                assert request("GET", "/api/status")[0] == 401
                status, page, _ = request("GET", "/login")
                assert status == 200 and b"test-only-token-1234" not in page
                csrf = re.search(rb'name="csrf" value="([^"]+)"', page)[1].decode()
                status, _, cookie = request(
                    "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded"},
                    f"csrf={csrf}&value=test-only-token-1234",
                )
                assert status == 303 and "HttpOnly; SameSite=Strict" in cookie
                auth["Cookie"] = cookie.split(";", 1)[0]
            assert request("POST", "/api/pause")[0] == 403
            assert request("GET", "/api/status", {"Host": "invalid"})[0] == 403
            for name in cfg.web_hosts:
                assert request("GET", "/", {"Host": f"{name}:{server.server_port}"})[0] == 200
            assert request("GET", "/", {"Host": f"unknown:{server.server_port}"})[0] == 403
            assert request("GET", "/", {"Host": "omarchy:1"})[0] == 403
            status, body, csrf = request("GET", "/api/status")
            data = json.loads(body)
            assert status == 200 and csrf
            assert data["plan"]["next"]["row_id"] == "A"
            assert data["plan"]["commit"] == "commit123"
            assert data["test_gx"]["databaseId"] == 2 and data["health"] == "pending"
            assert data["errors"] == {"deploy": "HTTP 403"}
            assert data["timer_last"] == "09:00" and data["timer_next"] == "09:10"
            assert data["token_status"]["status"] == "ok" and b"demo-loop-scoped-token-only" not in body
            assert data["budget"] == {"used": 0, "cap": 3}
            assert data["worker"] is None and data["phase"] == "idle"
            status, body, _ = request("GET", "/")
            assert status == 200 and b"Next task" in body and b"Save note" in body
            assert b"null" not in body and b"{" not in body
            assert b"GitHub loop token: ok" in body and b"demo-loop-scoped-token-only" not in body
            assert b"Failed to connect to bus" in body
            assert b"No active worker" in body and b"No open PR" in body and b"None sent" in body
            assert b'aria-current="step"' in body and b"HTTP 403" in body
            assert request("GET", "/dashboard.js")[0] == 200
            assert request("GET", "/api/logs?source=unknown")[0] == 400
            assert request("GET", "/api/logs?source=..%2Ftoken")[0] == 400
            assert request("GET", "/api/logs?source=loop&lines=501")[0] == 400
            code, logs, _ = request("GET", "/api/logs?source=last-run&lines=1&q=error")
            assert code == 200 and json.loads(logs)["lines"] == ["ERROR [redacted]"]
            code, logs, _ = request("GET", "/api/logs?source=runners")
            assert code == 200 and json.loads(logs)["lines"] == ["newest", "first"]
            assert commands[-1] == ["journalctl", "--user", "-u", "actions-runner-victron.service",
                                    "-n", "500", "-o", "short-iso", "--no-pager"]
            assert request("POST", "/api/pause", {"X-CSRF-Token": csrf, "Host": "invalid"})[0] == 403
            headers = {"X-CSRF-Token": csrf, "Content-Type": "application/json"}
            code, body, _ = request("POST", "/api/pause", headers)
            assert code == 200 and json.loads(body) == {"ok": True, "message": "Paused", "paused": True}
            code, body, _ = request("POST", "/api/resume", headers)
            assert code == 200 and json.loads(body) == {"ok": True, "message": "Resumed", "paused": False}
            code, body, _ = request("POST", "/api/resume", headers)
            assert code == 200 and json.loads(body)["message"] == "Already running"
            code, body, _ = request("POST", "/api/run-now", headers)
            assert code == 200 and json.loads(body)["message"] == "Run started"
            assert commands[-1] == ["systemctl", "--user", "start", "--no-block", "victron-loop.service"]
            unit_status = "activating"
            code, body, _ = request("POST", "/api/run-now", headers)
            assert code == 409 and "already active" in json.loads(body)["message"]
            assert not store.load()["paused"]
        finally:
            server.shutdown()
            thread.join()


@pytest.mark.parametrize("host", ["0.0.0.0", "192.0.2.1", "8.8.8.8"])
def test_web_rejects_non_tailnet_bind(tmp_path, host):
    cfg = LoopConfig(repo="test/repo", web_bind=f"{host}:0", token_file=None)
    with pytest.raises(ValueError, match="Tailscale IPv4 or loopback"):
        web.make_server(cfg, StateStore.open(tmp_path))


def test_timer_times_reads_last_and_next(monkeypatch):
    def show(command, **options):
        assert command == ["systemctl", "--user", "--no-pager", "show", "victron-loop.timer",
                           "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec", "-p", "ActiveState"]
        assert options["env"]["TZ"] == "UTC"
        return "ActiveState=active\nNextElapseUSecRealtime=Wed 2026-11-25 19:10:00 UTC\nLastTriggerUSec=Wed 2026-11-25 19:00:00 UTC\n"

    monkeypatch.setattr(web.subprocess, "check_output", show)
    now = datetime(2026, 11, 25, 19, 4, tzinfo=timezone.utc).timestamp()
    data = web.timer_times(now)
    assert data["timer_state"] == "active"
    assert data["timer_next"] == web.local_time(int(now + 360), now)
    assert data["timer_last"] == web.local_time(int(now - 240), now)


def test_monotonic_timer_uses_recorded_list_timers_json(monkeypatch):
    fixtures = Path(__file__).with_name("fixtures")

    def systemctl(command, **_):
        if command[3] == "show":
            return (fixtures / "systemctl-timer-show.txt").read_text(encoding="utf-8")
        assert command[3:] == ["list-timers", "--all", "--output=json", "victron-loop.timer"]
        return (fixtures / "systemctl-timer-list.json").read_text(encoding="utf-8")

    monkeypatch.setattr(web.subprocess, "check_output", systemctl)
    assert web.timer_times() == {
        "timer_state": "active",
        "timer_next": web.local_time(1795685057),
        "timer_last": web.local_time(1795598657),
    }


def test_inactive_timer_properties_are_unset(monkeypatch):
    def show(command, **_):
        assert command[3] == "show"
        return "ActiveState=inactive\nNextElapseUSecRealtime=\nLastTriggerUSec=\n"

    monkeypatch.setattr(web.subprocess, "check_output", show)
    assert web.timer_times() == {"timer_state": "inactive", "timer_next": "Not scheduled", "timer_last": "Not recorded"}


def test_timer_bus_failure_reports_stderr(monkeypatch):
    def fail(command, **_):
        raise subprocess.CalledProcessError(1, command, stderr="Failed to connect to bus: No medium found\n")

    monkeypatch.setattr(web.subprocess, "check_output", fail)
    assert web.timer_times() == {
        "timer_next": "Unknown", "timer_last": "Unknown", "timer_error": "Failed to connect to bus: No medium found",
    }
