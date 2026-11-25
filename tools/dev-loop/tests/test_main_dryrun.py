from __future__ import annotations

import json
import sys
from pathlib import Path

import victron_loop.main as main_mod
from victron_loop.main import main
from victron_loop.state import StateStore


def test_dry_run_state_file_unchanged(tmp_path: Path, monkeypatch):
    state_dir = main_mod.StateStore.open().root
    state_file = state_dir / "state.json"
    state_file.write_text(
        json.dumps(
            {
                "approved": [],
                "active_worker": None,
                "notifications_sent": {},
                "daily_counts": {},
                "last_summary_date": None,
            },
            sort_keys=True,
            indent=2,
        ),
        encoding="utf-8",
    )
    before = state_file.read_bytes()
    (tmp_path / "BACKLOG.md").write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| R1 | Task | open | ready |
""",
        encoding="utf-8",
    )
    config = tmp_path / "config.toml"
    config.write_text(
        f"""repo = "vzakusylo/victron"
repo_path = "{tmp_path.as_posix()}"
dry_run = true
notify_backend = "notify-send"
token_file = "~/victron-loop/token"
model_tiers_file = "missing-models.json"
""",
        encoding="utf-8",
    )
    class FakeGh:
        def __init__(self, repo, token_file):
            pass

        def list_open_prs(self):
            return []

        def list_runs(self, workflow, branch, limit):
            if workflow == "deploy-gx-code.yml":
                return [{"databaseId": 1, "headSha": "a", "conclusion": "success"}]
            if workflow == "test-gx.yml":
                return [{"databaseId": 2, "headSha": "a", "conclusion": "success"}]
            return []

        def view_run_jobs(self, run_id):
            return [{"steps": [{"name": "Deploy from master", "conclusion": "success"},
                               {"name": "Monitor post-deploy health", "conclusion": "success"}]}]

    monkeypatch.setattr(main_mod, "GhCli", FakeGh)
    monkeypatch.chdir(tmp_path)
    code = main(["--config", str(config), "run-once", "--dry-run"])
    assert code == 0
    assert state_file.read_bytes() == before
    assert (state_dir / "dry-run.jsonl").exists()
    observed = json.loads((state_dir / "dry-run.jsonl").read_text())["observed"]
    assert observed["test_gx"]["databaseId"] == 2
    assert observed["deploy_applied"] and observed["deploy_health"] == "success"


def test_main_reads_backlog_from_repo_path(tmp_path: Path, monkeypatch, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "BACKLOG.md").write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| RGOOD | Task | open | ready |
""",
        encoding="utf-8",
    )
    (tmp_path / "BACKLOG.md").write_text(
        """### Process and repo
| ID | Task | State | Notes |
|---|---|---|---|
| RBAD | Task | open | ready |
""",
        encoding="utf-8",
    )
    config = tmp_path / "config.toml"
    config.write_text(
        f"""repo = "vzakusylo/victron"
repo_path = "{repo.as_posix()}"
dry_run = true
notify_backend = "notify-send"
token_file = "~/victron-loop/token"
model_tiers_file = "missing-models.json"
""",
        encoding="utf-8",
    )
    class FakeGh:
        def __init__(self, repo, token_file):
            pass

        def list_open_prs(self):
            return []

        def list_runs(self, workflow, branch, limit):
            if workflow == "deploy-gx-code.yml":
                return [{"databaseId": 1, "headSha": "a", "conclusion": "success"}]
            if workflow == "test-gx.yml":
                return [{"databaseId": 2, "headSha": "a", "conclusion": "success"}]
            return []

        def view_run_jobs(self, run_id):
            return [{"steps": [{"name": "Deploy from master", "conclusion": "success"},
                               {"name": "Monitor post-deploy health", "conclusion": "success"}]}]

    monkeypatch.setattr(main_mod, "GhCli", FakeGh)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    code = main(["--config", str(config), "run-once", "--dry-run"])
    out = capsys.readouterr().out
    assert code == 0
    assert "RGOOD" in out
    assert "RBAD" not in out


def test_timer_command_records_dry_run_completion_and_output(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    monkeypatch.setattr(main_mod, "load_config", lambda _: main_mod.LoopConfig(repo="test/repo"))

    def tick(*_):
        print("timer output")
        print("timer diagnostic", file=sys.stderr)
        return "deploy-pending"

    monkeypatch.setattr(main_mod, "run_tick", tick)
    assert main(["--config", "config.toml", "run-once"]) == 0
    store = StateStore.open()
    run = store.last_run()
    assert run["result"] == "deploy-pending" and run["dry_run"] is True
    assert store.run_logs()[0].stem == run["id"]
    assert store.run_logs()[0].read_text(encoding="utf-8") == "timer output\ntimer diagnostic\n"
    captured = capsys.readouterr()
    assert captured.out == "timer output\n" and captured.err == "timer diagnostic\n"
    assert main(["status"]) == 0
    assert json.loads(capsys.readouterr().out)["last_run"] == run


def test_run_logs_keep_last_fifty(tmp_path):
    store = StateStore.open(tmp_path)
    for index in range(52):
        store.record_run({"id": f"{index:019d}", "result": "idle"}, "output")
    assert [int(path.stem) for path in store.run_logs()] == list(range(51, 1, -1))

