from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def _head_token(cmd) -> str:
    if isinstance(cmd, (list, tuple)) and cmd:
        return Path(str(cmd[0]).strip()).stem.lower()
    if isinstance(cmd, str):
        return cmd.strip().split(" ", 1)[0].lower()
    return ""


@pytest.fixture(autouse=True)
def block_real_gh_copilot_git_subprocess(monkeypatch):
    original_run = subprocess.run
    original_popen = subprocess.Popen

    def guarded_run(cmd, *args, **kwargs):
        head = _head_token(cmd)
        if head in {"gh", "copilot", "git"}:
            raise AssertionError(f"real subprocess call is blocked in tests: {head}")
        return original_run(cmd, *args, **kwargs)

    def guarded_popen(cmd, *args, **kwargs):
        head = _head_token(cmd)
        if head in {"gh", "copilot", "git"}:
            raise AssertionError(f"real subprocess call is blocked in tests: {head}")
        return original_popen(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", guarded_run)
    monkeypatch.setattr(subprocess, "Popen", guarded_popen)


@pytest.fixture
def mock_copilot_path(monkeypatch, tmp_path):
    import victron_loop.nodes as nodes

    executable = str(tmp_path / "CLI tools" / "copilot")
    monkeypatch.setattr(nodes.shutil, "which", lambda path: executable if path in {"copilot", executable} else None)
    return executable

