from __future__ import annotations

import argparse
import io
import json
import sys
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from .gh import GhCli
from .control import ROW_ACTIONS, apply_control
from .nodes import LoopConfig, check_state, notify
from .state import LockBusyError, StateStore

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib  # type: ignore


def run_tick(store: StateStore, cfg: LoopConfig, gh: GhCli) -> str:
    state = store.load()
    if state.get("paused"):
        check_state(state, cfg, gh)
        errors = state["observed"]["errors"]
        if not cfg.dry_run and errors:
            notify(state, cfg)
        state["last_run"] = {"at": int(cfg.clock()), "result": "paused"}
        store.save(state)
        store.append_decision({"node": "check_state", "result": "paused", "errors": errors})
        print('{"reason": "paused"}')
        return "paused"

    from .graph import build_graph

    new_state = build_graph(cfg, gh, cfg.repo_path / "BACKLOG.md").invoke(state)
    for key in ("paused", "last_worker"):
        if key in state:
            new_state[key] = state[key]
    observed = new_state.get("observed", {})
    if observed.get("errors"):
        store.append_decision({"node": "check_state", "result": "gh-observation-error",
                               "errors": observed["errors"]})
    pick = new_state.get("pick") or {}
    result = pick.get("reason") or pick.get("row_id") or "idle"
    if cfg.dry_run:
        store.append_dry_run({"command": "run-once", "dry_run": True, "observed": observed, "result": result})
    else:
        new_state["last_run"] = {"at": int(cfg.clock()), "result": result}
        store.save(new_state)
        store.append_decision({"node": "run-once", "result": result})
    print(json.dumps({key: value for key, value in pick.items() if key != "brief"}, sort_keys=True))
    return result


def load_config(config_path: Path) -> LoopConfig:
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    web_hosts = data.get("web_hosts", ["omarchy"])
    if not isinstance(web_hosts, list) or not all(isinstance(host, str) for host in web_hosts):
        raise ValueError("web_hosts must be a list of host names")
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
        web_bind=data.get("web_bind", "127.0.0.1:8790"),
        web_hosts=tuple(web_hosts),
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
        state = store.load()
        if last_run := store.last_run():
            state["last_run"] = last_run
        print(json.dumps(state, indent=2, sort_keys=True))
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
    try:
        with store.lock():
            output, errors = io.StringIO(), io.StringIO()
            run = {"id": str(time.time_ns()), "result": "failed", "dry_run": cfg.dry_run}
            try:
                with redirect_stdout(output), redirect_stderr(errors):
                    run["result"] = run_tick(store, cfg, gh)
            except Exception:
                traceback.print_exc(file=errors)
                return 1
            finally:
                run["at"] = int(cfg.clock())
                store.record_run(run, output.getvalue() + errors.getvalue())
                sys.stdout.write(output.getvalue())
                sys.stderr.write(errors.getvalue())
    except LockBusyError:
        print("another run is in progress", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

