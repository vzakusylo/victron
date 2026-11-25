from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .platform import priority_options


JsonRunner = Callable[[list[str], dict[str, str] | None], str]


class GhTokenError(RuntimeError):
    def __init__(self, condition: str, message: str):
        super().__init__(message)
        self.condition = condition


def read_token(path: Path | None) -> str:
    if path is None:
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def token_details(path: Path | None, now: float, allow_fallback: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "missing", "expires_in_days": None, "token_rotated_at": None}
    try:
        token = read_token(path)
    except (OSError, UnicodeError):
        return {**result, "status": "invalid"}
    if not token or path is None:
        return {**result, "status": "gh login" if allow_fallback else "missing"}
    result["status"] = "ok"
    try:
        metadata = json.loads(path.with_name(path.name + ".meta").read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            raise ValueError("Token metadata is not an object")
        for key in ("token_rotated_at", "expires_at"):
            value = metadata.get(key)
            if value is not None:
                date = datetime.fromisoformat(value)
                if date.tzinfo is None:
                    raise ValueError("Token metadata timestamp must include a time zone")
                result[key] = date.isoformat()
                if key == "expires_at":
                    result["expires_in_days"] = math.ceil((date.timestamp() - now) / 86400)
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError, OverflowError):
        result["metadata_error"] = True
    return result


def _default_runner(cmd: list[str], env: dict[str, str] | None) -> str:
    out = subprocess.run(cmd, check=False, capture_output=True, encoding="utf-8",
                         env=env, timeout=30, **priority_options())
    if out.returncode:
        if re.search(r"\bHTTP\s+401\b|\b401\s+Unauthorized\b", out.stderr, re.IGNORECASE):
            raise GhTokenError("token-invalid", "GitHub rejected the loop token (HTTP 401)")
        raise RuntimeError(f"gh {' '.join(cmd[1:3])} exited {out.returncode}: {out.stderr.strip()}")
    return out.stdout


@dataclass
class GhCli:
    repo: str
    token_file: Path | None = None
    runner: JsonRunner = _default_runner
    allow_gh_login_fallback: bool = False

    def _run(self, args: list[str]) -> str:
        try:
            token = read_token(self.token_file)
        except (OSError, UnicodeError) as exc:
            raise GhTokenError("token-invalid", "The configured loop token file could not be read") from exc
        if self.token_file is not None and not token and not self.allow_gh_login_fallback:
            raise GhTokenError("token-missing", "The configured loop token file is missing or empty")
        env = {**os.environ, "GH_TOKEN": token} if token else None
        try:
            return self.runner(["gh", *args, "--repo", self.repo], env)
        except RuntimeError as exc:
            if token and token in str(exc):
                raise RuntimeError(str(exc).replace(token, "[redacted]")) from None
            raise

    def _run_json(self, args: list[str]) -> Any:
        return json.loads(self._run(args))

    def list_open_prs(self) -> list[dict[str, Any]]:
        return self.list_prs("open")

    def list_prs(self, state: str = "open", head_branch: str | None = None) -> list[dict[str, Any]]:
        args = [
            "pr",
            "list",
            "--state",
            state,
            "--json",
            "number,title,url,reviewDecision,statusCheckRollup,headRefName,mergedAt,mergeCommit",
        ]
        if head_branch:
            args.extend(["--head", head_branch])
        data = self._run_json(args)
        if not isinstance(data, list):
            raise ValueError("gh pr list did not return a PR list")
        return data

    def get_pr(self, number: int) -> dict[str, Any]:
        data = self._run_json(
            [
                "pr",
                "view",
                str(number),
                "--json",
                "number,title,url,reviewDecision,statusCheckRollup,headRefName,mergedAt,mergeCommit",
            ]
        )
        return data

    def list_runs(self, workflow: str, branch: str, limit: int = 1) -> list[dict[str, Any]]:
        data = self._run_json(
            [
                "run",
                "list",
                "--workflow",
                workflow,
                "--branch",
                branch,
                "--limit",
                str(limit),
                "--json",
                "databaseId,headSha,status,conclusion,url,name,workflowName,createdAt,updatedAt,event",
            ]
        )
        if not isinstance(data, list):
            raise ValueError("gh run list did not return a workflow run list")
        return data

    def view_run_jobs(self, run_id: int) -> list[dict[str, Any]]:
        data = self._run_json(
            ["run", "view", str(run_id), "--json", "jobs"]
        )
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
            raise ValueError("gh run view did not return a jobs list")
        return data["jobs"]

    def list_pr_files(self, number: int) -> list[str]:
        data = self._run_json(["pr", "view", str(number), "--json", "files"])
        return [item.get("path", "") for item in data.get("files", []) if item.get("path")]

    def disable_pr_auto_merge(self, number: int) -> None:
        self._run(["pr", "merge", str(number), "--disable-auto"])

