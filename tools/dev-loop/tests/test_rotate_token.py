import errno
import json
import os
import select
import stat
import subprocess
import time
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "posix", reason="requires Bash and a pseudo-terminal")
def test_rotate_reject_and_rollback_with_fake_gh(tmp_path):
    import pty

    script = Path(__file__).resolve().parents[1] / "rotate-token.sh"
    fake = tmp_path / "gh"
    fake.write_text(
        """#!/usr/bin/env bash
[[ "$GH_TOKEN" != github_pat_fixture_rejected ]] || exit 1
case "$*" in
  *--include*) printf 'HTTP/2 200\\r\\nGitHub-Authentication-Token-Expiration: 2030-01-01 01:23:45 UTC\\r\\n' ;;
  *user/repos*) echo 1 ;;
esac
""",
        encoding="utf-8",
    )
    fake.chmod(0o700)
    home = tmp_path / "victron-loop"
    home.mkdir()
    token = home / "token"
    old, valid, invalid = "github_pat_fixture_old", "github_pat_fixture_new", "github_pat_fixture_rejected"
    token.write_text(old + "\n", encoding="utf-8")
    env = {**os.environ, "HOME": str(tmp_path), "PATH": f"{tmp_path}:{os.environ['PATH']}"}

    def rotate(value):
        pid, terminal = pty.fork()
        if pid == 0:
            os.execvpe("bash", ["bash", str(script)], env)
        output = b""
        submitted = False
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                if not select.select([terminal], [], [], 0.1)[0]:
                    continue
                try:
                    chunk = os.read(terminal, 4096)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output += chunk
                if not submitted and b"Paste the new token" in output:
                    os.write(terminal, (value + "\n").encode())
                    submitted = True
            else:
                raise TimeoutError("rotation script did not finish")
        finally:
            os.close(terminal)
            _, status = os.waitpid(pid, 0)
        assert submitted and value.encode() not in output
        return os.waitstatus_to_exitcode(status)

    ensured = subprocess.run(["bash", str(script), "--ensure"], env=env, capture_output=True, timeout=10)
    assert ensured.returncode == 0
    assert token.read_text().strip() == old
    assert json.loads((home / "token.meta").read_text()) == {
        "token_rotated_at": None, "expires_at": "2030-01-01T01:23:45Z",
    }
    assert not (home / "token.prev").exists()
    assert rotate(valid) == 0
    previous = home / "token.prev"
    assert token.read_text().strip() == valid and previous.read_text().strip() == old
    assert stat.S_IMODE(token.stat().st_mode) == stat.S_IMODE(previous.stat().st_mode) == 0o600
    assert json.loads((home / "token.meta").read_text())["expires_at"] == "2030-01-01T01:23:45Z"
    assert rotate(invalid) == 1
    assert token.read_text().strip() == valid and previous.read_text().strip() == old
    rollback = subprocess.run(["bash", str(script), "--rollback"], env=env, capture_output=True, timeout=10)
    assert rollback.returncode == 0 and old.encode() not in rollback.stdout
    assert token.read_text().strip() == old
