from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .gh import GhCli
from .control import ROW_ACTIONS, apply_control
from .nodes import LoopConfig, check_state
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
        web_bind=data.get("web_bind", ""),
        web_token_file=Path(data["web_token_file"]).expanduser() if data.get("web_token_file") else None,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="victron-loop")
    parser.add_argument("--config", default="config.toml")
    sub = parser.add_subparsers(dest="command", required=True)
    run_once = sub.add_parser("run-once")
    run_once.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    for action in ROW_ACTIONS:
        sub.add_parser(action).add_argument("value")
    sub.add_parser("note").add_argument("value")
    for action in ("pause", "resume", "web"):
        sub.add_parser(action)
    args = parser.parse_args(argv)

    store = StateStore.open()
    if args.command == "status":
        print(json.dumps(store.load(), indent=2, sort_keys=True))
        return 0
    cfg = load_config(Path(args.config))
    if args.command == "web":
        from .web import serve

        serve(cfg, store)
        return 0
    if args.command != "run-once":
        try:
            apply_control(store, cfg, args.command, getattr(args, "value", ""))
        except (LockBusyError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
        return 0

    if args.dry_run:
        cfg.dry_run = True
    gh = GhCli(repo=cfg.repo, token_file=cfg.token_file)
    backlog_path = cfg.repo_path / "BACKLOG.md"
    try:
        with store.lock():
            state = store.load()
            if state.get("paused"):
                check_state(state, cfg, gh)
                state["last_run"] = {"at": int(cfg.clock()), "result": "paused"}
                store.save(state)
                store.append_decision({"node": "check_state", "result": "paused"})
                print('{"reason": "paused"}')
                return 0
            from .graph import build_graph

            app = build_graph(cfg, gh, backlog_path)
            new_state = app.invoke(state)
            for key in ("paused", "last_worker"):
                if key in state:
                    new_state[key] = state[key]
            if cfg.dry_run:
                store.append_dry_run({
                    "command": "run-once", "dry_run": True,
                    "result": (new_state.get("pick") or {}).get("reason") or (new_state.get("pick") or {}).get("row_id"),
                })
            else:
                pick = new_state.get("pick") or {}
                result = pick.get("reason") or pick.get("row_id") or "idle"
                new_state["last_run"] = {"at": int(cfg.clock()), "result": result}
                store.save(new_state)
                store.append_decision({"node": "run-once", "result": result})
            print(json.dumps({k: v for k, v in (new_state.get("pick") or {}).items() if k != "brief"}, sort_keys=True))
    except LockBusyError:
        print("another run is in progress", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

