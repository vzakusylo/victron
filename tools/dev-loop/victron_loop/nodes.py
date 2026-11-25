from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .gh import GhCli, GhTokenError, token_details

HARD_RE = re.compile(r"(heat pump|grid|bms|deploy|live control)", re.IGNORECASE)
BRANCH_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
SKIP_RE = re.compile(r"\b(done|blocked|in progress|owner decision|waiting)\b", re.IGNORECASE)
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


def _copilot_path(state: dict[str, Any], cfg: LoopConfig) -> str | None:
    candidate = cfg.copilot_bin or shutil.which("copilot") or "~/.local/bin/copilot"
    executable = shutil.which(os.path.normpath(os.path.expanduser(candidate)))
    if not executable:
        _enqueue_notification(state, "copilot-missing", "cli", f"Copilot executable not found: {candidate}")
        state["pick"] = {"reason": "copilot-missing"}
        return None
    _resolve_notification(state, "copilot-missing", "cli")
    return os.path.abspath(executable)


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
    allow_gh_login_fallback: bool = False
    model_tiers_file: Path = Path.home() / "victron-loop" / "repo" / "tools" / "herdr" / "models.json"
    clock: Callable[[], float] = default_clock
    picker_tier: str = "review"
    copilot_bin: str | None = None
    web_bind: str = ""
    web_hosts: tuple[str, ...] = ("omarchy",)
    web_token_file: Path | None = None


def _today(clock: Callable[[], float]) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(clock()))


def _tier_model_effort(models_file: Path, tier: str) -> tuple[str, str]:
    data = json.loads(models_file.read_text(encoding="utf-8"))
    item = data["tiers"][tier]
    return item["model"], item["effort"]


def _tier_model_effort_from_text(models_json_text: str, tier: str) -> tuple[str, str]:
    data = json.loads(models_json_text)
    item = data["tiers"][tier]
    return item["model"], item["effort"]


def _enqueue_notification(state: dict[str, Any], condition: str, subject_id: str, message: str) -> None:
    state.setdefault("pending_notifications", []).append(
        {"condition": condition, "subject_id": subject_id, "message": message}
    )


def _resolve_notification(state: dict[str, Any], condition: str, subject_id: str) -> None:
    state.setdefault("resolved_notification_keys", []).append(f"{condition}:{subject_id}")


def _fetch_origin_niced(cfg: LoopConfig, timeout_seconds: int = 60) -> bool:
    cmd = [
        "bash",
        "-lc",
        f"nice -n 19 git -C {shlex.quote(str(cfg.repo_path))} fetch origin",
    ]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout_seconds)
    return result.returncode == 0


def _git_show_origin_file(cfg: LoopConfig, rel_path: str, timeout_seconds: int = 30) -> str:
    cmd = ["git", "-C", str(cfg.repo_path), "show", f"origin/master:{rel_path}"]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout_seconds)
    if result.returncode != 0:
        raise RuntimeError(f"git show failed for {rel_path}: {result.stderr.strip()}")
    return result.stdout


def check_state(state: dict[str, Any], cfg: LoopConfig, gh: GhCli) -> dict[str, Any]:
    if not cfg.dry_run:
        if not _fetch_origin_niced(cfg):
            state["repo_refresh_failed"] = True
            _enqueue_notification(state, "repo-fetch-failed", "origin", "Could not fetch origin in repo clone")
        else:
            state["repo_refresh_failed"] = False
            _resolve_notification(state, "repo-fetch-failed", "origin")
    errors = {}
    token_error = None

    def observe(key, operation, *args):
        nonlocal token_error
        if token_error:
            return []
        try:
            result = operation(*args)
        except GhTokenError as exc:
            token_error = exc.condition
            errors[key] = str(exc)
            _enqueue_notification(state, token_error, "github", str(exc))
            return []
        except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
            errors[key] = str(exc)
            _enqueue_notification(state, "gh-observation-error", key, f"{key}: {exc}")
            return []
        _resolve_notification(state, "gh-observation-error", key)
        return result

    open_prs = observe("open-prs", gh.list_open_prs)
    test_gx_runs = observe("test-gx", gh.list_runs, "test-gx.yml", cfg.branch, 1)
    deploy_runs = observe("deploy", gh.list_runs, "deploy-gx-code.yml", cfg.branch, 10)
    deploy = None
    deploy_health = None
    deploy_applied = False
    for deploy in deploy_runs:
        if deploy.get("status", "completed") != "completed":
            deploy_health = "pending"
            break
        jobs = observe("deploy-jobs", gh.view_run_jobs, int(deploy["databaseId"]))
        steps = {step["name"]: step.get("conclusion") for job in jobs for step in job.get("steps", [])}
        deploy_health = steps.get("Monitor post-deploy health")
        if deploy.get("conclusion") == "success" and (
            deploy_health == "skipped"
            or any(job.get("name") == "deploy" and job.get("conclusion") == "skipped" for job in jobs)
        ):
            deploy_health = None
            continue
        deploy_applied = steps.get("Deploy from master") == "success" and deploy_health not in {None, "skipped"}
        break
    else:
        deploy = None
    token = token_details(cfg.token_file, cfg.clock(), cfg.allow_gh_login_fallback)
    days = token["expires_in_days"]
    if not token_error and days is not None and days <= 14:
        threshold = 3 if days <= 3 else 14
        status = "has expired" if days < 0 else "expires today" if days == 0 else f"expires in {days} days"
        _enqueue_notification(state, f"token-expiry-{threshold}", token["expires_at"],
                              f"GitHub loop token {status}; rotate it on Omarchy")
    deploy_lookup = None
    if not deploy and "deploy" not in errors:
        deploy_lookup = "deploy-all-skipped" if deploy_runs else "deploy-no-runs"
    state["observed"] = {
        "open_prs": open_prs,
        "test_gx": test_gx_runs[0] if test_gx_runs else None,
        "deploy": deploy,
        "deploy_applied": deploy_applied,
        "deploy_health": deploy_health,
        "deploy_lookup": deploy_lookup,
        "errors": errors,
        "token_error": token_error,
    }
    if deploy and not errors and deploy_health not in {None, "pending", "skipped", "success"}:
        _enqueue_notification(state, "deploy-health-red", str(deploy["databaseId"]), "Deploy health is red")
    if deploy and deploy_health == "success":
        _resolve_notification(state, "deploy-health-red", str(deploy["databaseId"]))
    return state


def parse_backlog(backlog_text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    sections = {}
    work_section = None
    header = []
    seen = set()
    priority_ids = []
    reading_order = False
    lines = backlog_text.splitlines()
    for index, line in enumerate(lines):
        heading = re.match(r"^(#{2,6}) (.*)", line)
        if heading:
            level, title = len(heading[1]), heading[2]
            if level == 2:
                work_section = bool(re.match(r"^[345]\.", title))
            sections = {depth: name for depth, name in sections.items() if depth < level}
            sections[level] = title
            header = []
            reading_order = False
            continue
        section = " / ".join(sections.values())
        if not (work_section if work_section is not None else SECTION_ALLOW_RE.search(section)):
            continue
        if not line.startswith("|"):
            if "priority plan" in section.lower():
                if "Order:" in line:
                    line = line.split("Order:", 1)[1]
                    reading_order = True
                if reading_order:
                    order, stop, _ = line.partition(".")
                    priority_ids.extend(re.findall(r"\b[A-Z][A-Z0-9-]*\d+[a-z]?(?:-[A-Z]+)?\b", order))
                    reading_order = bool(order.strip()) and not stop
            continue
        cols = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        if index + 1 < len(lines) and re.fullmatch(r"\|[\s:|-]+\|", lines[index + 1]):
            candidate = [col.lower() for col in cols]
            if "task" in candidate or "item" in candidate:
                header = candidate
            continue
        if len(cols) != len(header) or re.fullmatch(r"\|[\s:|-]+\|", line):
            continue
        data = dict(zip(header, cols))
        task = data.get("task") or data.get("item")
        if not task:
            continue
        row_id = cols[0] if header[0] in {"id", "#", "pr"} else ""
        if not row_id or row_id == "—":
            slug = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")[:30].rstrip("-")
            digest = hashlib.sha256(f"{cols[0]}:{task}".encode()).hexdigest()[:8]
            row_id = f"{slug or 'task'}-{digest}"
        if row_id in seen:
            continue
        seen.add(row_id)
        rows.append({"row_id": row_id, "task": task, "state": data.get("state", data.get("state / notes", "")),
                     "notes": data.get("notes", ""), "section": section})
    rank = {key: index for index, key in enumerate(dict.fromkeys(priority_ids))}

    def priority(row):
        if row["row_id"] in rank:
            return (0, rank[row["row_id"]])
        if "approved follow-up queue" in row["section"].lower():
            return (1, 0)
        return (2, 0)

    return sorted(rows, key=priority)


def is_skippable(row: dict[str, str], failed_rows: set[str]) -> bool:
    if row["row_id"] in failed_rows:
        return True
    return SKIP_RE.search(" ".join([row["state"], row["notes"]])) is not None


def evaluate_plan(state: dict[str, Any], text: str) -> dict[str, Any]:
    eligible, skipped = [], []
    for row in parse_backlog(text):
        key = row["row_id"]
        match = SKIP_RE.search(f"{row['state']} {row['notes']}")
        reason = (
            "failed" if key in state.get("failed_rows", []) else
            "stopped" if key in state.get("stopped_rows", []) else
            "skipped" if key in state.get("skipped_rows", []) else
            match.group().lower() if match else
            "needs-owner-go" if requires_owner_approval(row) and key not in state.get("approved", []) else
            None
        )
        if reason:
            skipped.append({**row, "reason": reason})
        else:
            eligible.append(row)
    eligible.sort(key=lambda row: row["row_id"] != state.get("pinned_row"))
    return {"eligible": eligible, "skipped": skipped, "next": eligible[0] if eligible else None}


def is_hard(row: dict[str, str]) -> bool:
    return HARD_RE.search(" ".join([row["row_id"], row["task"], row["notes"]])) is not None


def requires_owner_approval(row: dict[str, str]) -> bool:
    combined = " ".join([row["row_id"], row["task"], row["notes"]])
    if is_hard(row) or LIVE_CONTROL_RE.search(combined):
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
    cfg: LoopConfig, row: dict[str, str], backlog_text: str, models_json_text: str,
    copilot_runner: Callable[..., Any], executable: str,
) -> dict[str, str]:
    model, effort = _tier_model_effort_from_text(models_json_text, cfg.picker_tier)
    prompt = (
        "Return strict JSON object with keys row_id, branch, tier, brief.\n"
        f"Backlog data: {json.dumps(backlog_text)}\n"
        f"Selected row: {json.dumps(row)}\n"
        "Brief must include: goal, files, tests, delivery "
        "(PR + gh pr merge N --auto --merge after review feedback is addressed and threads are resolved), "
        "and report must end with Branch: <name>."
    )
    out = copilot_runner(
        [executable, "-p", prompt, "--model", model, "--reasoning-effort", effort],
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
    if observed.get("token_error"):
        state["pick"] = {"reason": observed["token_error"]}
        return state
    if observed.get("errors"):
        state["pick"] = {"reason": "gh-observation-error"}
        return state
    if observed.get("open_prs"):
        state["pick"] = {"reason": "open-pr-exists"}
        return state
    if state.get("repo_refresh_failed"):
        state["pick"] = {"reason": "repo-refresh-failed"}
        return state
    if observed.get("deploy_health") == "pending":
        state["pick"] = {"reason": "deploy-pending"}
        return state
    if observed.get("deploy_lookup"):
        state["pick"] = {"reason": observed["deploy_lookup"]}
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

    if cfg.dry_run:
        backlog_text = backlog_path.read_text(encoding="utf-8")
        models_json_text = ""
    else:
        try:
            backlog_text = _git_show_origin_file(cfg, "BACKLOG.md")
            models_json_text = _git_show_origin_file(cfg, "tools/herdr/models.json")
        except Exception as exc:
            _enqueue_notification(state, "repo-read-failed", "origin-master", f"Could not read origin/master files: {exc}")
            state["pick"] = {"reason": "repo-read-failed"}
            return state
    plan = evaluate_plan(state, backlog_text)
    for item in plan["skipped"]:
        if item["reason"] == "needs-owner-go":
            key = item["row_id"]
            _enqueue_notification(state, "needs-owner-go", key, f"Task {key} needs owner go")
    row = plan["next"]
    if not row:
        state["pick"] = {
            "reason": "needs-owner-go" if any(r["reason"] == "needs-owner-go" for r in plan["skipped"]) else "no-candidate"
        }
        return state

    if cfg.dry_run:
        state["pick"] = {
            "row_id": row["row_id"],
            "branch": _safe_branch(row["row_id"], row["row_id"].lower()),
            "tier": "standard",
            "brief": "Dry run stub brief.",
        }
        return state
    executable = _copilot_path(state, cfg)
    if not executable:
        return state
    try:
        pick = _pick_llm(cfg, row, backlog_text, models_json_text, copilot_runner, executable)
        if pick["row_id"] != row["row_id"]:
            raise ValueError("picker returned a different row")
        if state.get("owner_note"):
            pick["brief"] += f"\n\n## Owner note\n\n{state['owner_note']}\n"
        state["pick"] = pick
        state["phase"] = "picked"
    except (subprocess.CalledProcessError, ValueError) as exc:
        _enqueue_notification(state, "pick-task-error", row["row_id"], f"pick_task failed: {type(exc).__name__}")
        state["pick"] = {"reason": "pick-task-error", "row_id": row["row_id"]}
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
            ],
            start_new_session=True,
        )
        return proc.pid


    proc = subprocess.Popen(
        ["bash", "-lc", f"cd {shlex.quote(str(worktree))} && nice -n 19 {command}"],
        start_new_session=True,
    )
    return proc.pid


def _process_start(pid: int) -> str | None:
    if not isinstance(pid, int) or pid <= 0 or os.name != "posix":
        return None
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def start_worker(state: dict[str, Any], cfg: LoopConfig) -> dict[str, Any]:
    pick = state.get("pick") or {}
    branch = pick.get("branch")
    if not branch:
        return state
    if cfg.dry_run:
        state["active_worker"] = None
        return state
    executable = _copilot_path(state, cfg)
    if not executable:
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
        f"{shlex.quote(executable)} -p {shlex.quote(prompt)} --allow-all --model {shlex.quote(model)} "
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
        "model": model,
        "process_group": True,
        "process_start": _process_start(pid),
        "worktree": str(worktree),
        "pid": pid,
        "started_at": int(cfg.clock()),
        "log_path": str(log_path),
        "retry_count": 0,
        "last_log_mtime": 0,
    }
    if state.get("pinned_row") == pick.get("row_id"):
        state["pinned_row"] = None
    state["owner_note"] = ""
    state["phase"] = "worker running"
    state["worker_pr"] = None
    return state


def _retry_worker(state: dict[str, Any], cfg: LoopConfig, worker: dict[str, Any], text: str) -> None:
    executable = _copilot_path(state, cfg)
    if not executable:
        return
    model, effort = _tier_model_effort(cfg.model_tiers_file, worker.get("tier", "standard"))
    cmd = (
        f"{shlex.quote(executable)} -p {shlex.quote(text)} --allow-all --model {shlex.quote(model)} "
        f"--reasoning-effort {shlex.quote(effort)} >> {shlex.quote(worker['log_path'])} 2>&1"
    )
    worker["pid"] = _spawn_copilot(Path(worker["worktree"]), cmd)
    worker["process_group"] = True
    worker["process_start"] = _process_start(worker["pid"])
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
    try:
        return _watch_pr(state, cfg, gh)
    except GhTokenError as exc:
        observed = state.setdefault("observed", {})
        observed["token_error"] = exc.condition
        observed.setdefault("errors", {})["watch-pr"] = str(exc)
        state["pick"] = {"reason": exc.condition}
        _enqueue_notification(state, exc.condition, "github", str(exc))
        return state


def _watch_pr(state: dict[str, Any], cfg: LoopConfig, gh: GhCli) -> dict[str, Any]:
    worker = state.get("active_worker")
    if not worker or state.get("observed", {}).get("errors"):
        return state

    open_prs = gh.list_prs("open", head_branch=worker["branch"])
    if open_prs:
        pr = open_prs[0]
        state["worker_pr"] = pr
        state["phase"] = "checks" if pr.get("statusCheckRollup") else "PR open"
        row_id = str(worker.get("row_id") or "")
        approved = set(state.get("approved", []))
        if pr.get("number") and row_id and row_id not in approved:
            files = gh.list_pr_files(int(pr["number"]))
            if _touches_protected_paths(files):
                if not cfg.dry_run:
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
        if not cfg.dry_run and not _fetch_origin_niced(cfg):
            _enqueue_notification(state, "repo-fetch-failed", "origin", "Could not fetch origin for ancestry check")
            return state
        pr = merged[0]
        state["worker_pr"] = pr
        state["phase"] = "merged"
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
        state["phase"] = "deploy" if test_ok else "Test GX"
        if deploy_ok_run:
            state["phase"] = "health"
            jobs = gh.view_run_jobs(int(deploy_ok_run["databaseId"]))
            for job in jobs:
                for step in job.get("steps", []):
                    if step.get("name") == "Monitor post-deploy health" and step.get("conclusion") == "success":
                        health_ok = True
        if test_ok and deploy_ok_run and health_ok:
            state["active_worker"] = None
            state["phase"] = "done"
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


def notify(state: dict[str, Any], cfg: LoopConfig, *, daily_summary: bool = True) -> dict[str, Any]:
    sent = state.setdefault("notifications_sent", {})
    observed = state.get("observed")
    if observed is not None and not observed.get("errors"):
        for condition in ("token-missing", "token-invalid"):
            sent.pop(f"{condition}:github", None)
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
    if daily_summary and state.get("last_summary_date") != today:
        waiting = sorted(state.get("failed_rows", []))
        done = "yes" if not state.get("active_worker") else "no"
        message = f"done={done}; waiting={','.join(waiting) if waiting else 'none'}"
        if not cfg.dry_run and cfg.notify_backend == "notify-send":
            subprocess.run(["notify-send", "Victron loop daily summary", message], check=False)
        state["last_summary_date"] = today
    return state

