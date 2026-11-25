from __future__ import annotations

import json
from pathlib import Path

import victron_loop.main as main_mod
from victron_loop.main import main


def test_dry_run_state_file_unchanged(tmp_path: Path, monkeypatch):
    state_dir = tmp_path / "state" / "victron-loop"
    state_dir.mkdir(parents=True)
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
        """repo = "vzakusylo/victron"
repo_path = "missing-repo"
dry_run = true
notify_backend = "notify-send"
token_file = "~/victron-loop/token"
model_tiers_file = "missing-models.json"
""",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    code = main(["--config", str(config), "run-once", "--dry-run"])
    assert code == 0
    assert state_file.read_bytes() == before
    assert (state_dir / "dry-run.jsonl").exists()


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
            return [{"steps": [{"name": "Monitor post-deploy health", "conclusion": "success"}]}]

    monkeypatch.setattr(main_mod, "GhCli", FakeGh)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    code = main(["--config", str(config), "run-once", "--dry-run"])
    out = capsys.readouterr().out
    assert code == 0
    assert "RGOOD" in out
    assert "RBAD" not in out

