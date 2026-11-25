from __future__ import annotations

import os
import re
import signal
import subprocess

from .nodes import LoopConfig, _fetch_origin_niced, _process_start, evaluate_plan
from .state import LockBusyError, StateStore

ROW_ACTIONS = {"approve": "approved", "skip": "skipped_rows", "unskip": "skipped_rows", "pin": "pinned_row"}
LOOP_UNIT = "victron-loop.service"


def read_plan(cfg: LoopConfig, state: dict) -> dict:
    git = ["git", "-C", str(cfg.repo_path)]
    commit = subprocess.check_output(git + ["rev-parse", "origin/master"], text=True, timeout=10).strip()
    text = subprocess.check_output(git + ["show", f"{commit}:BACKLOG.md"], text=True, timeout=10)
    return {"commit": commit, **evaluate_plan(state, text)}


def apply_control(store: StateStore, cfg: LoopConfig, action: str, value: str = "") -> dict:
    with store.lock():
        state = store.load()
        message = "Saved"
        if action in ROW_ACTIONS:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value):
                raise ValueError("Invalid row ID")
            field = ROW_ACTIONS[action]
            if action == "pin":
                state[field] = value
            else:
                rows = set(state.get(field, []))
                (rows.discard if action == "unskip" else rows.add)(value)
                state[field] = sorted(rows)
        elif action in {"pause", "resume"}:
            paused = action == "pause"
            if paused == state.get("paused", False):
                message = "Already paused" if paused else "Already running"
            else:
                message = "Paused" if paused else "Resumed"
            state["paused"] = paused
        elif action == "run-now":
            prefix = ["systemctl", "--user"]
            status = subprocess.check_output(
                [*prefix, "show", "--property=ActiveState", "--value", LOOP_UNIT],
                text=True, timeout=5,
            ).strip()
            if status not in {"inactive", "failed"}:
                raise LockBusyError("Loop run is already active")
            subprocess.run([*prefix, "start", "--no-block", LOOP_UNIT], check=True, timeout=5)
            store.append_decision({"node": "control", "action": action, "result": "started"})
            return {"ok": True, "message": "Run started", "paused": state.get("paused", False)}
        elif action == "stop-worker":
            if value != "yes":
                raise ValueError("Stop requires confirmation")
            worker = state.get("active_worker")
            if worker:
                if not worker.get("process_group"):
                    raise ValueError("Legacy worker has no tracked process group")
                pid = int(worker["pid"])
                started = worker.get("process_start")
                try:
                    if started and _process_start(pid) == started:
                        os.killpg(pid, signal.SIGTERM)
                    else:
                        os.killpg(pid, 0)
                        raise ValueError("Cannot verify worker process group; stop it manually")
                except ProcessLookupError:
                    pass
                state["stopped_rows"] = sorted(set(state.get("stopped_rows", [])) | {worker["row_id"]})
                state["last_worker"] = {**worker, "status": "stopped"}
                state["active_worker"] = None
                state["phase"] = "stopped"
            state["paused"] = True
        elif action == "note":
            if len(value) > 4000:
                raise ValueError("Owner note is limited to 4000 characters")
            state["owner_note"] = value
        elif action == "refresh":
            if not _fetch_origin_niced(cfg):
                raise RuntimeError("Could not fetch origin")
        else:
            raise ValueError("Unknown action")
        store.save(state)
        store.append_decision({"node": "control", "action": action})
        return {"ok": True, "message": message, "paused": state.get("paused", False)}
