import os
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "posix", reason="requires Bash and /dev/tty")
def test_setup_requires_a_terminal_for_initial_token(tmp_path):
    script = Path(__file__).resolve().parents[1] / "setup-omarchy.sh"
    runner = tmp_path / "systemctl"
    runner.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    runner.chmod(0o700)
    result = subprocess.run(
        ["bash", str(script)],
        input="must-not-read-from-stdin\n", capture_output=True, text=True, start_new_session=True,
        env={**os.environ, "HOME": str(tmp_path), "PATH": f"{tmp_path}:{os.environ['PATH']}", "USER": "test"},
        timeout=10,
    )
    assert result.returncode == 1
    assert "An interactive terminal is required" in result.stderr
    assert not (tmp_path / "victron-loop" / "token").exists()
