from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .platform import background_options, priority_options


def task(repo: Path, action: str, branch: str, *args: str) -> list[str]:
    return ["pwsh", "-NoProfile", "-File", str(repo / "tools" / "herdr" / "herdr-task.ps1"),
            action, branch, *args]


def running() -> bool:
    try:
        result = subprocess.run(["herdr", "status"], capture_output=True, text=True, timeout=5, **priority_options())
        return result.returncode == 0 and bool(re.search(r"^\s*status:\s*running\s*$", result.stdout, re.M))
    except (OSError, subprocess.TimeoutExpired):
        return False


def send(repo: Path, branch: str, text: str, log: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as output:
        subprocess.Popen(task(repo, "send", branch, text), stdin=subprocess.DEVNULL,
                         stdout=output, stderr=subprocess.STDOUT, **background_options())


def start(repo: Path, branch: str, tier: str, brief: str, log: Path) -> dict:
    result = json.loads(subprocess.check_output(
        task(repo, "new", branch, "-Repo", str(repo), "-Base", "origin/master", "-Tier", tier, "-Json"),
        text=True, timeout=150, **priority_options(),
    ))
    name = f".copilot-brief-{branch}.md"
    (Path(result["worktree"]) / name).write_text(brief, encoding="utf-8")
    send(repo, branch, f"Read {name} and do all of it.", log)
    return {key: result[key] for key in ("agent", "worktree", "model")}


def status(agent: str) -> str:
    data = json.loads(subprocess.check_output(["herdr", "agent", "list"], text=True, timeout=10, **priority_options()))
    return next((row["agent_status"] for row in data["result"]["agents"] if row["name"] == agent), "missing")


def read(repo: Path, branch: str) -> str:
    return subprocess.check_output(task(repo, "read", branch, "-Lines", "80"), encoding="utf-8", timeout=15, **priority_options())


def close(repo: Path, worker: dict) -> None:
    brief = Path(worker["worktree"]) / f".copilot-brief-{worker['branch']}.md"
    brief.unlink(missing_ok=True)
    subprocess.run(task(repo, "close", worker["branch"], "-IfPresent"),
                   check=True, timeout=30, capture_output=True, **priority_options())


def interrupt(agent: str) -> bool:
    try:
        return subprocess.run(["herdr", "agent", "send-keys", agent, "esc"],
                              timeout=10, capture_output=True).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
