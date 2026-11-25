from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .gh import GhCli
from .graph import build_graph
from .nodes import LoopConfig
from .state import LockBusyError, StateStore

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib  # type: ignore


def load_config(config_path: Path) -> LoopConfig:
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    return LoopConfig(
        repo=data["repo"],
        branch=data.get("branch", "master"),
        loop_home=Path(data.get("loop_home", str(Path.home() / "victron-loop"))).expanduser(),
        max_worker_runs_per_day=int(data.get("max_worker_runs_per_day", 3)),
        dry_run=bool(data.get("dry_run", True)),
        notify_backend=data.get("notify_backend", "notify-send"),
        token_file=Path(data.get("token_file", "~/victron-loop/token")).expanduser(),
        repo_path=Path(data.get("repo_path", "~/victron-loop/repo")).expanduser(),
        model_tiers_file=Path(data.get("model_tiers_file", "~/victron-loop/repo/tools/herdr/models.json")).expanduser(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="victron-loop")
    parser.add_argument("--config", default="config.toml")
    sub = parser.add_subparsers(dest="command", required=True)
    run_once = sub.add_parser("run-once")
    run_once.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    approve = sub.add_parser("approve")
    approve.add_argument("row_id")
    args = parser.parse_args(argv)

    store = StateStore.open()
    if args.command == "status":
        print(json.dumps(store.load(), indent=2, sort_keys=True))
        return 0
    if args.command == "approve":
        state = store.load()
        approved = set(state.get("approved", []))
        approved.add(args.row_id)
        state["approved"] = sorted(approved)
        store.save(state)
        print(f"approved {args.row_id}")
        return 0

    cfg = load_config(Path(args.config))
    if args.dry_run:
        cfg.dry_run = True
    gh = GhCli(repo=cfg.repo, token_file=cfg.token_file)
    backlog_path = cfg.repo_path / "BACKLOG.md"
    if not backlog_path.exists():
        backlog_path = Path("BACKLOG.md")
    try:
        with store.lock():
            state = store.load()
            app = build_graph(cfg, gh, backlog_path)
            new_state = app.invoke(state)
            if cfg.dry_run:
                store.append_dry_run({"command": "run-once", "dry_run": True, "pick": new_state.get("pick")})
            else:
                store.save(new_state)
                store.append_decision({"command": "run-once", "dry_run": False, "pick": new_state.get("pick")})
            print(json.dumps(new_state.get("pick", {}), sort_keys=True))
    except LockBusyError:
        print("another run is in progress", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

