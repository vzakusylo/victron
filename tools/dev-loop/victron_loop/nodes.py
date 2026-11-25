from __future__ import annotations

import json
import re
import shlex
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .gh import GhCli

HARD_RE = re.compile(r"(heat pump|grid|bms|deploy|live control)", re.IGNORECASE)
BRANCH_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
SKIP_RE = re.compile(r"(done|blocked|in progress|owner|decision|waiting)", re.IGNORECASE)
LIVE_CONTROL_RE = re.compile(
    r"(battery|charge|dvcc|setpoint|tariff|multiplus|grid|bms|heat pump|dhw|boiler|curve|deploy|flows\.json|\bNN\s|\blib/)",
    re.IGNORECASE,
)
SAFE_SECTION_RE = re.compile(r"(process and repo|review follow-ups|test gx plan)", re.IGNORECASE)
SECTION_ALLOW_RE = re.compile(
    r"(production backlog|process and repo|review follow-ups|test gx plan|approved follow-up queue)",
    re.IGNORECASE,
)


def default_clock() -> float:
    return time.time()


@dataclass
class LoopConfig:
    repo: str
    branch: str = "master"
    loop_home: Path = Path.home() / "victron-loop"
    repo_path: Path = Path.home() / "victron-loop" / "repo"
    max_worker_runs_per_day: int = 3
    dry_run: bool = True
    notify_backend: str = "notify-send"
    token_file: Path | None = Path.home() / "victron-loop" / "token"
    model_tiers_file: Path = Path.home() / "victron-loop" / "repo" / "tools" / "herdr" / "models.json"
    clock: Callable[[], float] = default_clock
    picker_tier: str = "review"


def _today(clock: Callable[[], float]) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(clock()))


def _tier_model_effort(models_file: Path, tier: str) -> tuple[str, str]:
    data = json.loads(models_file.read_text(encoding="utf-8"))
    item = data["tiers"][tier]
    return item["model"], item["effort"]


def _enqueue_notification(state: dict[str, Any], condition: str, subject_id: str, message: str) -> None:
    state.setdefault("pending_notifications", []).append(
        {"condition": condition, "subject_id": subject_id, "message": message}
    )


def _resolve_notification(state: dict[str, Any], condition: str, subject_id: str) -> None:
    state.setdefault("resolved_notification_keys", []).append(f"{condition}:{subject_id}")


def check_state(state: dict[str, Any], cfg: LoopConfig, gh: GhCli) -> dict[str, Any]:
    open_prs = gh.list_open_prs()
    test_gx_runs = gh.list_runs("test-gx.yml", cfg.branch, 1)
    deploy_runs = gh.list_runs("deploy-gx-code.yml", cfg.branch, 1)
    deploy = deploy_runs[0] if deploy_runs else None
    deploy_health = None
    deploy_applied = False
    if deploy:
        jobs = gh.view_run_jobs(int(deploy["databaseId"]))
        for job in jobs:
            for step in job.get("steps", []):
                if step.get("name") == "Monitor post-deploy health":
                    deploy_health = step.get("conclusion")
                    deploy_applied = step.get("conclusion") is not None
    state["observed"] = {
        "open_prs": open_prs,
        "test_gx": test_gx_runs[0] if test_gx_runs else None,
        "deploy": deploy,
        "deploy_applied": deploy_applied,
        "deploy_health": deploy_health,
    }
    if deploy and deploy_health not in {None, "success"}:
        _enqueue_notification(state, "deploy-health-red", str(deploy["databaseId"]), "Deploy health is red")
    if deploy and deploy_health == "success":
        _resolve_notification(state, "deploy-health-red", str(deploy["databaseId"]))
    return state


def parse_backlog(backlog_text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    section = ""
    in_table = False
    for line in backlog_text.splitlines():
        if line.startswith("## ") or line.startswith("### "):
            section = line.lstrip("#").strip()
            in_table = False
            continue
        if not SECTION_ALLOW_RE.search(section):
            continue
        if line.startswith("| ID ") or line.startswith("| # ") or line.startswith("| PR "):
            in_table = True
            continue
        if not in_table or not line.startswith("|"):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cols) < 4:
            continue
        if cols[0] in {"---", "ID", "#", "PR"}:
            continue
        if len(cols) >= 5:
            task, state_col, notes = cols[2], cols[3], cols[4]
        else:
            task, state_col, notes = cols[1], cols[2], cols[3]
        rows.append({"row_id": cols[0], "task": task, "state": state_col, "notes": notes, "section": section})
    return rows


def is_skippable(row: dict[str, str], failed_rows: set[str]) -> bool:
    if row["row_id"] in failed_rows:
        return True
    return SKIP_RE.search(" ".join([row["state"], row["notes"]])) is not None


def is_hard(row: dict[str, str]) -> bool:
    return HARD_RE.search(" ".join([row["row_id"], row["task"], row["notes"]])) is not None


def requires_owner_approval(row: dict[str, str]) -> bool:
    combined = " ".join([row["row_id"], row["task"], row["notes"]])
    if LIVE_CONTROL_RE.search(combined):
        return True
    if SAFE_SECTION_RE.search(row.get("section", "")):
        return False
    return True


def _safe_branch(row_id: str, candidate: str) -> str:
    if BRANCH_RE.fullmatch(candidate):
        return candidate
    slug = re.sub(r"[^a-z0-9-]", "-", row_id.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:41]
    return slug or "auto-task"


def _pick_llm(
    cfg: LoopConfig, row: dict[str, str], backlog_text: str, copilot_runner: Callable[..., Any]
) -> dict[str, str]:
    model, effort = _tier_model_effort(cfg.model_tiers_file, cfg.picker_tier)
    prompt = (
        "Return strict JSON object with keys row_id, branch, tier, brief.\n"
        f"Backlog data: {json.dumps(backlog_text)}\n"
        f"Selected row: {json.dumps(row)}\n"
        "Brief must include: goal, files, tests, delivery "
        "(PR + gh pr merge N --auto --merge after review feedback is addressed and threads are resolved), "
        "and report must end with Branch: <name>."
    )
    out = copilot_runner(
        ["copilot", "-p", prompt, "--model", model, "--reasoning-effort", effort],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    data = json.loads(out)
    if not isinstance(data, dict):
        raise ValueError("copilot response is not an object")
    for key in ("row_id", "branch", "tier", "brief"):
        if key not in data or not isinstance(data[key], str) or not data[key].strip():
            raise ValueError(f"missing or invalid {key}")
    data["branch"] = _safe_branch(row["row_id"], data["branch"])
    return data


def pick_task(state: dict[str, Any], cfg: LoopConfig, backlog_path: Path, copilot_runner=subprocess.run) -> dict[str, Any]:
    observed = state.get("observed", {})
    if observed.get("open_prs"):
        state["pick"] = {"reason": "open-pr-exists"}
        return state
    if not observed.get("deploy_applied") or observed.get("deploy_health") != "success":
        state["pick"] = {"reason": "deploy-not-healthy"}
        return state
    if state.get("active_worker"):
        state["pick"] = {"reason": "worker-active"}
        return state
    day = _today(cfg.clock)
    if int(state.get("daily_counts", {}).get(day, 0)) >= cfg.max_worker_runs_per_day:
        state["pick"] = {"reason": "daily-budget-cap"}
        return state

    backlog_text = backlog_path.read_text(encoding="utf-8")
    failed_rows = set(state.get("failed_rows", []))
    approved = set(state.get("approved", []))
    rows = [r for r in parse_backlog(backlog_text) if not is_skippable(r, failed_rows)]
    if not rows:
        state["pick"] = {"reason": "no-candidate"}
        return state

    for row in rows:
        if requires_owner_approval(row) and row["row_id"] not in approved:
            _enqueue_notification(state, "needs-owner-go", row["row_id"], f"Task {row['row_id']} needs owner go")
            continue
        if cfg.dry_run:
            state["pick"] = {
                "row_id": row["row_id"],
                "branch": _safe_branch(row["row_id"], row["row_id"].lower()),
                "tier": "standard",
                "brief": "Dry run stub brief.",
            }
            return state
        try:
            state["pick"] = _pick_llm(cfg, row, backlog_text, copilot_runner)
            return state
        except (subprocess.CalledProcessError, json.JSONDecodeError, ValueError) as exc:
            _enqueue_notification(state, "pick-task-error", row["row_id"], f"pick_task failed: {exc}")
            state["pick"] = {"reason": "pick-task-error", "row_id": row["row_id"]}
            return state

    state["pick"] = {"reason": "needs-owner-go"}
    return state


def _ensure_repo(cfg: LoopConfig) -> None:
    if cfg.repo_path.exists():
        subprocess.run(["git", "-C", str(cfg.repo_path), "fetch", "origin"], check=True)
        return
    cfg.repo_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", f"https://github.com/{cfg.repo}.git", str(cfg.repo_path)], check=True)
    subprocess.run(["git", "-C", str(cfg.repo_path), "fetch", "origin"], check=True)


def _spawn_copilot(worktree: Path, command: str) -> int:
    if Path("/run/systemd/system").exists():
        proc = subprocess.Popen(
            [
                "systemd-run",
                "--user",
                "--scope",
                "-p",
                "Nice=19",
                "-p",
                "CPUWeight=10",
                "bash",
                "-lc",
                f"cd {shlex.quote(str(worktree))} && {command}",
            ]
        )
        return proc.pid
    proc = subprocess.Popen(["bash", "-lc", f"cd {shlex.quote(str(worktree))} && nice -n 19 {command}"])
    return proc.pid


def start_worker(state: dict[str, Any], cfg: LoopConfig) -> dict[str, Any]:
    pick = state.get("pick") or {}
    branch = pick.get("branch")
    if not branch:
        return state
    if cfg.dry_run:
        state["active_worker"] = None
        return state
    _ensure_repo(cfg)
    worktree = cfg.loop_home / "worktrees" / branch
    brief_name = f".copilot-brief-{branch}.md"
    log_path = cfg.loop_home / "logs" / f"{branch}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "-C", str(cfg.repo_path), "worktree", "add", str(worktree), "-b", branch, "origin/master"], check=True
    )
    (worktree / brief_name).write_text(pick["brief"], encoding="utf-8")
    model, effort = _tier_model_effort(cfg.model_tiers_file, pick.get("tier", "standard"))
    prompt = f"Read {brief_name} and do all of it."
    command = (
        f"copilot -p {shlex.quote(prompt)} --allow-all --model {shlex.quote(model)} "
        f"--reasoning-effort {shlex.quote(effort)} > {shlex.quote(str(log_path))} 2>&1"
    )
    pid = _spawn_copilot(worktree, command)
    day = _today(cfg.clock)
    counts = state.setdefault("daily_counts", {})
    counts[day] = int(counts.get(day, 0)) + 1
    state["active_worker"] = {
        "row_id": pick.get("row_id"),
        "branch": branch,
        "tier": pick.get("tier", "standard"),
        "worktree": str(worktree),
        "pid": pid,
        "started_at": int(cfg.clock()),
        "log_path": str(log_path),
        "retry_count": 0,
        "last_log_mtime": 0,
    }
    return state


def _retry_worker(state: dict[str, Any], cfg: LoopConfig, worker: dict[str, Any], text: str) -> None:
    model, effort = _tier_model_effort(cfg.model_tiers_file, worker.get("tier", "standard"))
    cmd = (
        f"copilot -p {shlex.quote(text)} --allow-all --model {shlex.quote(model)} "
        f"--reasoning-effort {shlex.quote(effort)} >> {shlex.quote(worker['log_path'])} 2>&1"
    )
    worker["pid"] = _spawn_copilot(Path(worker["worktree"]), cmd)
    worker["retry_count"] = int(worker.get("retry_count", 0)) + 1


def _check_worker_idle(state: dict[str, Any], cfg: LoopConfig, worker: dict[str, Any]) -> bool:
    log_path = Path(worker["log_path"])
    if not log_path.exists():
        return False
    mtime = int(log_path.stat().st_mtime)
    last = int(worker.get("last_log_mtime", mtime))
    worker["last_log_mtime"] = mtime
    if mtime > last:
        return False
    idle_for = int(cfg.clock()) - mtime
    if idle_for > 1800:
        _enqueue_notification(state, "worker-idle", worker["branch"], f"Worker {worker['branch']} idle >30m")
        return True
    _resolve_notification(state, "worker-idle", worker["branch"])
    return False


def _check_rollup_failing(rollup: list[dict[str, Any]]) -> bool:
    for item in rollup or []:
        conclusion = str(item.get("conclusion", "")).lower()
        status = str(item.get("status", "")).lower()
        if conclusion in {"failure", "cancelled", "timed_out", "action_required", "startup_failure"}:
            return True
        if status == "completed" and conclusion not in {"", "success", "neutral", "skipped"}:
            return True
    return False


def _is_run_for_or_after_merge(cfg: LoopConfig, merge_sha: str, run_sha: str) -> bool:
    if run_sha == merge_sha:
        return True
    if not run_sha:
        return False
    cmd = ["git", "-C", str(cfg.repo_path), "merge-base", "--is-ancestor", merge_sha, run_sha]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    return result.returncode == 0


def _touches_protected_paths(paths: list[str]) -> bool:
    for path in paths:
        if path == "flows.json":
            return True
        if path.startswith("lib/"):
            return True
        if re.match(r"^\d{2}\s.+\.(js|html)$", path):
            return True
    return False


def watch_pr(state: dict[str, Any], cfg: LoopConfig, gh: GhCli) -> dict[str, Any]:
    worker = state.get("active_worker")
    if not worker:
        return state

    open_prs = gh.list_prs("open", head_branch=worker["branch"])
    if open_prs:
        pr = open_prs[0]
        row_id = str(worker.get("row_id") or "")
        approved = set(state.get("approved", []))
        if pr.get("number") and row_id and row_id not in approved:
            files = gh.list_pr_files(int(pr["number"]))
            if _touches_protected_paths(files):
                gh.disable_pr_auto_merge(int(pr["number"]))
                _enqueue_notification(
                    state,
                    "unapproved-live-control-pr",
                    str(pr["number"]),
                    f"PR #{pr['number']} touches live-control files without approval",
                )
        if pr.get("reviewDecision") == "CHANGES_REQUESTED" or _check_rollup_failing(pr.get("statusCheckRollup", [])):
            if int(worker.get("retry_count", 0)) == 0 and not cfg.dry_run:
                _retry_worker(state, cfg, worker, "PR checks/review failed. Fix and continue.")
            else:
                failed = set(state.get("failed_rows", []))
                if worker.get("row_id"):
                    failed.add(worker["row_id"])
                state["failed_rows"] = sorted(failed)
                _enqueue_notification(state, "worker-failed", worker["branch"], f"Worker failed twice for {worker['branch']}")
                state["active_worker"] = None
        return state

    merged = gh.list_prs("merged", head_branch=worker["branch"])
    if merged:
        pr = merged[0]
        merge_sha = ((pr.get("mergeCommit") or {}).get("oid") or "").strip()
        if not merge_sha:
            return state
        test_runs = gh.list_runs("test-gx.yml", cfg.branch, 5)
        deploy_runs = gh.list_runs("deploy-gx-code.yml", cfg.branch, 5)
        test_ok = any(
            r.get("conclusion") == "success" and _is_run_for_or_after_merge(cfg, merge_sha, str(r.get("headSha") or ""))
            for r in test_runs
        )
        deploy_ok_run = next(
            (
                r
                for r in deploy_runs
                if r.get("conclusion") == "success"
                and _is_run_for_or_after_merge(cfg, merge_sha, str(r.get("headSha") or ""))
            ),
            None,
        )
        health_ok = False
        if deploy_ok_run:
            jobs = gh.view_run_jobs(int(deploy_ok_run["databaseId"]))
            for job in jobs:
                for step in job.get("steps", []):
                    if step.get("name") == "Monitor post-deploy health" and step.get("conclusion") == "success":
                        health_ok = True
        if test_ok and deploy_ok_run and health_ok:
            state["active_worker"] = None
        return state

    if worker.get("pid") and not _pid_alive(int(worker["pid"])):
        if int(worker.get("retry_count", 0)) == 0 and not cfg.dry_run:
            _retry_worker(state, cfg, worker, "Worker exited before opening PR. Continue.")
        else:
            failed = set(state.get("failed_rows", []))
            if worker.get("row_id"):
                failed.add(worker["row_id"])
            state["failed_rows"] = sorted(failed)
            _enqueue_notification(state, "worker-failed", worker["branch"], f"Worker failed twice for {worker['branch']}")
            state["active_worker"] = None
        return state
    if _check_worker_idle(state, cfg, worker):
        return state
    return state


def _pid_alive(pid: int) -> bool:
    try:
        if pid <= 0:
            return False
        import os

        os.kill(pid, 0)
        return True
    except OSError:
        return False


def notify(state: dict[str, Any], cfg: LoopConfig) -> dict[str, Any]:
    sent = state.setdefault("notifications_sent", {})
    for key in state.pop("resolved_notification_keys", []):
        sent.pop(key, None)
    queue = state.pop("pending_notifications", [])
    for item in queue:
        key = f"{item['condition']}:{item['subject_id']}"
        if key in sent:
            continue
        if not cfg.dry_run and cfg.notify_backend == "notify-send":
            subprocess.run(["notify-send", "Victron loop blocker", item["message"]], check=False)
        sent[key] = int(cfg.clock())

    today = _today(cfg.clock)
    if state.get("last_summary_date") != today:
        waiting = sorted(state.get("failed_rows", []))
        done = "yes" if not state.get("active_worker") else "no"
        message = f"done={done}; waiting={','.join(waiting) if waiting else 'none'}"
        if not cfg.dry_run and cfg.notify_backend == "notify-send":
            subprocess.run(["notify-send", "Victron loop daily summary", message], check=False)
        state["last_summary_date"] = today
    return state

