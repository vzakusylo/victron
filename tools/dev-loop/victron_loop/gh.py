from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


JsonRunner = Callable[[list[str], dict[str, str] | None], str]


def _default_runner(cmd: list[str], env: dict[str, str] | None) -> str:
    out = subprocess.run(cmd, check=False, capture_output=True, text=True, env=env)
    if out.returncode:
        raise RuntimeError(f"gh {' '.join(cmd[1:3])} exited {out.returncode}: {out.stderr.strip()}")
    return out.stdout


@dataclass
class GhCli:
    repo: str
    token_file: Path | None = None
    runner: JsonRunner = _default_runner

    def _run_json(self, args: list[str]) -> Any:
        cmd = ["gh", *args, "--repo", self.repo]
        env = None
        if self.token_file and self.token_file.exists():
            token = self.token_file.read_text(encoding="utf-8").strip()
            env = os.environ.copy()
            env["GH_TOKEN"] = token
        return json.loads(self.runner(cmd, env))

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
        cmd = ["gh", "pr", "merge", str(number), "--disable-auto", "--repo", self.repo]
        env = None
        if self.token_file and self.token_file.exists():
            token = self.token_file.read_text(encoding="utf-8").strip()
            env = os.environ.copy()
            env["GH_TOKEN"] = token
        self.runner(cmd, env)

