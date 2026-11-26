from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from .platform import background_options, priority_options


def task(repo: Path, action: str, branch: str, *args: str) -> list[str]:
    return ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(repo / "tools" / "herdr" / "herdr-task.ps1"),
            action, branch, *args]


def _diagnostics(stdout: str | bytes | None, stderr: str | bytes | None) -> str:
    parts = []
    for label, output in (("stdout", stdout), ("stderr", stderr)):
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        if output and output.strip():
            parts.append(f"{label}: {output.strip()[-1024:]}")
    return "\n".join(parts)


def _run(command: list[str], timeout: int) -> str:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                encoding="utf-8", errors="replace", timeout=timeout, **priority_options())
    except subprocess.TimeoutExpired as exc:
        raise subprocess.SubprocessError(f"{exc}\n{_diagnostics(exc.stdout, exc.stderr)}".rstrip()) from exc
    if result.returncode:
        detail = _diagnostics(result.stdout, result.stderr)
        raise subprocess.SubprocessError(f"{command[0]} {command[1]} exited {result.returncode}\n{detail}".rstrip())
    return result.stdout


def running() -> bool:
    try:
        return bool(re.search(r"^\s*status:\s*running\s*$", _run(["herdr", "status"], 5), re.M))
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Herdr status failed: {exc}", file=sys.stderr)
        return False


def send(repo: Path, branch: str, text: str, log: Path, *, failure_file: Path | None = None) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    command = task(repo, "send", branch, text)
    if failure_file is not None:
        failure_file.unlink(missing_ok=True)
        command.extend(["-PromptFailureFile", str(failure_file)])
    with log.open("ab") as output:
        subprocess.Popen(command, stdin=subprocess.DEVNULL,
                         stdout=output, stderr=subprocess.STDOUT, **background_options())


def start(repo: Path, branch: str, tier: str, brief: str, log: Path) -> dict:
    output = _run(
        task(repo, "new", branch, "-Repo", str(repo), "-Base", "origin/master", "-Tier", tier, "-Json"),
        150,
    )
    try:
        result = json.loads(output)
        worker = {key: result[key] for key in ("agent", "worktree", "model")}
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"Invalid Herdr launch reply: {exc}\n{_diagnostics(output, None)}".rstrip()) from exc
    name = f".copilot-brief-{branch}.md"
    (Path(result["worktree"]) / name).write_text(brief, encoding="utf-8")
    send(repo, branch, f"Read {name} and do all of it.", log)
    return worker


def status(agent: str) -> str:
    data = json.loads(_run(["herdr", "agent", "list"], 10))
    return next((row["agent_status"] for row in data["result"]["agents"] if row["name"] == agent), "missing")


def read(repo: Path, branch: str) -> str:
    return _run(task(repo, "read", branch, "-Lines", "80"), 15)


def close(repo: Path, worker: dict) -> None:
    brief = Path(worker["worktree"]) / f".copilot-brief-{worker['branch']}.md"
    brief.unlink(missing_ok=True)
    _run(task(repo, "close", worker["branch"], "-IfPresent"), 30)


def interrupt(agent: str) -> bool:
    try:
        _run(["herdr", "agent", "send-keys", agent, "esc"], 10)
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Herdr interrupt failed: {exc}", file=sys.stderr)
        return False
