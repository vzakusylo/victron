from __future__ import annotations

import argparse
import io
import json
import math
import sys
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import TextIO

from .gh import GhCli
from .control import ROW_ACTIONS, apply_control
from .nodes import LoopConfig, check_picker, check_state, notify
from .platform import WINDOWS, exclusive_lock
from .scheduler import Scheduler, peer_blocker, stop_on_signal
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
        if not cfg.dry_run:
            notify(state, cfg, daily_summary=False)
        state["last_run"] = {"at": int(cfg.clock()), "result": "paused"}
        store.save(state)
        store.append_decision({"node": "check_state", "result": state["observed"].get("token_error") or "paused",
                               "errors": errors})
        paused_result = {"reason": "paused"}
        if errors:
            paused_result["github_status"] = state["observed"].get("token_error") or "gh-observation-error"
        print(json.dumps(paused_result))
        return "paused"

    from .graph import build_graph

    new_state = build_graph(cfg, gh, cfg.repo_path / "BACKLOG.md").invoke(state)
    for key in ("paused", "last_worker"):
        if key in state:
            new_state[key] = state[key]
    observed = new_state.get("observed", {})
    if observed.get("errors"):
        store.append_decision({"node": "check_state", "result": observed.get("token_error") or "gh-observation-error",
                               "errors": observed["errors"]})
    pick = new_state.get("pick") or {}
    result = pick.get("reason") or pick.get("row_id") or "idle"
    if cfg.dry_run:
        store.append_dry_run({"command": "run-once", "dry_run": True, "observed": observed, "result": result})
    else:
        new_state["last_run"] = {"at": int(cfg.clock()), "result": result}
        store.save(new_state)
        decision = {"node": "run-once", "result": result}
        if "error" in pick:
            decision["errors"] = {"picker": pick["error"]}
        store.append_decision(decision)
    print(json.dumps({key: value for key, value in pick.items() if key != "brief"}, sort_keys=True))
    return result


def load_config(config_path: Path) -> LoopConfig:
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    web_hosts = data.get("web_hosts", ["omarchy"])
    if not isinstance(web_hosts, list) or not all(isinstance(host, str) for host in web_hosts):
        raise ValueError("web_hosts must be a list of host names")
    backend = data.get("worker_backend", "herdr" if WINDOWS else "headless")
    if backend not in ("herdr", "headless"):
        raise ValueError("worker_backend must be herdr or headless")
    picker_backend = data.get("picker_backend", "copilot")
    picker_fallback = data.get("picker_fallback")
    if picker_backend not in ("claude", "copilot"):
        raise ValueError("picker_backend must be claude or copilot")
    if picker_fallback not in (None, "copilot"):
        raise ValueError("picker_fallback must be copilot when set")
    interval = float(data.get("interval_minutes", 10))
    if not math.isfinite(interval) or interval <= 0:
        raise ValueError("interval_minutes must be finite and positive")
    repo_path = Path(data.get("repo_path", "~/victron-loop/repo")).expanduser()
    return LoopConfig(
        repo=data["repo"],
        branch=data.get("branch", "master"),
        loop_home=Path(data.get("loop_home", str(Path.home() / "victron-loop"))).expanduser(),
        max_worker_runs_per_day=int(data.get("max_worker_runs_per_day", 3)),
        dry_run=bool(data.get("dry_run", True)),
        notify_backend=data.get("notify_backend", "windows" if WINDOWS else "notify-send"),
        token_file=Path(data.get("token_file", "~/victron-loop/token")).expanduser(),
        allow_gh_login_fallback=data.get("allow_gh_login_fallback") is True,
        repo_path=repo_path,
        model_tiers_file=Path(data.get("model_tiers_file", repo_path / "tools" / "herdr" / "models.json")).expanduser(),
        web_bind=data.get("web_bind", "127.0.0.1:8790"),
        web_hosts=tuple(web_hosts),
        copilot_bin=data.get("copilot_bin"),
        picker_backend=picker_backend,
        picker_fallback=picker_fallback,
        claude_bin=data.get("claude_bin"),
        picker_model=data.get("picker_model", "claude-opus-5-5"),
        picker_effort=data.get("picker_effort", "low"),
        web_token_file=Path(data["web_token_file"]).expanduser() if data.get("web_token_file") else None,
        worker_backend=backend,
        instance_name=data.get("instance_name", "windows" if WINDOWS else "omarchy"),
        peer_status_url=data.get("peer_status_url"),
        interval_minutes=interval,
    )


class CycleStderr(io.StringIO):
    def __init__(self, terminal: TextIO | None):
        super().__init__()
        self.terminal = terminal

    def write(self, text: str) -> int:
        if self.terminal is not None:
            self.terminal.write(text)
            self.terminal.flush()
        return super().write(text)


def run_cycle(store: StateStore, cfg: LoopConfig, gh: GhCli, *, echo: bool) -> tuple[int, str]:
    try:
        with store.lock():
            output = io.StringIO()
            errors = CycleStderr(sys.stderr if WINDOWS and not echo else None)
            run = {"id": str(time.time_ns()), "result": "failed", "dry_run": cfg.dry_run}
            status = 0
            try:
                blocker = None if store.load().get("paused") else peer_blocker(cfg)
                if blocker:
                    run["result"] = blocker
                    print(json.dumps({"reason": blocker}), file=output)
                    store.append_decision({"node": "peer-guard", "result": blocker})
                else:
                    with redirect_stdout(output), redirect_stderr(errors):
                        run["result"] = run_tick(store, cfg, gh)
            except Exception:
                traceback.print_exc(file=errors)
                status = 1
            finally:
                run["at"] = int(cfg.clock())
                store.record_run(run, output.getvalue() + errors.getvalue())
                if echo:
                    sys.stdout.write(output.getvalue())
                    sys.stderr.write(errors.getvalue())
            return status, run["result"]
    except LockBusyError:
        if echo:
            print("another run is in progress", file=sys.stderr)
        return 2, "another run is in progress"


def foreground(store: StateStore, cfg: LoopConfig, gh: GhCli, *, once: bool) -> int:
    from .web import make_server

    cfg.scheduler = Scheduler(cfg.clock, cfg.interval_minutes * 60)
    cycle = lambda: run_cycle(store, cfg, gh, echo=once)
    try:
        with exclusive_lock(store.root / "serve.lock"), stop_on_signal(cfg.scheduler):
            if once:
                return cfg.scheduler.run(cycle, once=True)
            with make_server(cfg, store) as server:
                thread = threading.Thread(target=server.serve_forever, name="dashboard", daemon=True)
                thread.start()
                try:
                    return cfg.scheduler.run(cycle)
                finally:
                    server.shutdown()
                    thread.join()
    except (LockBusyError, OSError, ValueError) as exc:
        print(f"Could not serve: {exc}", file=sys.stderr)
        return 2
    finally:
        cfg.scheduler = None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="victron-loop")
    parser.add_argument("--config", default=str(Path.home() / "victron-loop" / "config.toml") if WINDOWS else "config.toml")
    sub = parser.add_subparsers(dest="command", required=not WINDOWS)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--once", action="store_true")
    serve_parser.add_argument("--live", action="store_true")
    serve_parser.add_argument("--dry-run", action="store_true")
    run_once = sub.add_parser("run-once")
    run_once.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    sub.add_parser("check-picker")
    for action in ROW_ACTIONS:
        sub.add_parser(action).add_argument("value")
    sub.add_parser("note").add_argument("value")
    for action in ("pause", "resume", "web"):
        sub.add_parser(action)
    args = parser.parse_args(argv)
    if args.command is None:
        args.command, args.once, args.live, args.dry_run = "serve", False, False, False

    if args.command == "check-picker":
        return check_picker(load_config(Path(args.config)))
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
    if args.command not in {"run-once", "serve"}:
        try:
            apply_control(store, cfg, args.command, getattr(args, "value", ""))
        except (LockBusyError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
        return 0

    if args.dry_run:
        cfg.dry_run = True
    elif getattr(args, "live", False):
        cfg.dry_run = False
    gh = GhCli(repo=cfg.repo, token_file=cfg.token_file)
    gh.allow_gh_login_fallback = cfg.allow_gh_login_fallback
    if args.command == "serve":
        return foreground(store, cfg, gh, once=args.once)
    return run_cycle(store, cfg, gh, echo=True)[0]


if __name__ == "__main__":
    raise SystemExit(main())

