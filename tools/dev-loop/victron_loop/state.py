from __future__ import annotations

import json
import os
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

try:
    import fcntl
except ModuleNotFoundError:  # pragma: no cover
    fcntl = None  # type: ignore


class LockBusyError(RuntimeError):
    pass


def _state_root() -> Path:
    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        return Path(xdg) / "victron-loop"
    return Path.home() / ".local" / "state" / "victron-loop"


@dataclass
class StateStore:
    root: Path
    state_file: Path
    log_file: Path
    dry_run_file: Path
    lock_file: Path

    @classmethod
    def open(cls, root: Path | None = None) -> "StateStore":
        base = root or _state_root()
        base.mkdir(parents=True, exist_ok=True)
        return cls(
            root=base,
            state_file=base / "state.json",
            log_file=base / "decisions.jsonl",
            dry_run_file=base / "dry-run.jsonl",
            lock_file=base / "run.lock",
        )

    def load(self) -> dict[str, Any]:
        if not self.state_file.exists():
            return {
                "approved": [],
                "active_worker": None,
                "notifications_sent": {},
                "daily_counts": {},
                "last_summary_date": None,
            }
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def save(self, state: dict[str, Any]) -> None:
        _atomic_write_json(self.state_file, state)

    def append_decision(self, decision: dict[str, Any]) -> None:
        self._append_jsonl(self.log_file, decision)

    def append_dry_run(self, payload: dict[str, Any]) -> None:
        self._append_jsonl(self.dry_run_file, payload)

    def last_run(self) -> dict[str, Any] | None:
        try:
            return json.loads((self.root / "last-run.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def run_logs(self) -> list[Path]:
        return sorted(
            (path for path in (self.root / "runs").glob("*.log")
             if re.fullmatch(r"\d{19}\.log", path.name)),
            reverse=True,
        )

    def record_run(self, run: dict[str, Any], output: str) -> None:
        directory = self.root / "runs"
        directory.mkdir(mode=0o700, exist_ok=True)
        with NamedTemporaryFile("w", delete=False, dir=directory, encoding="utf-8") as temp:
            temp.write(output)
        os.replace(temp.name, directory / f"{run['id']}.log")
        _atomic_write_json(self.root / "last-run.json", run)
        for path in self.run_logs()[50:]:
            path.unlink()

    def _append_jsonl(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        item = dict(payload)
        item.setdefault("ts", int(time.time()))
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=True, sort_keys=True) + "\n")

    @contextmanager
    def lock(self) -> Any:
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_file.open("a+", encoding="utf-8") as f:
            if fcntl is None:  # pragma: no cover
                yield
                return
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise LockBusyError("lock is busy") from exc
            f.seek(0)
            f.truncate()
            f.write(str(os.getpid()))
            f.flush()
            try:
                yield
            finally:
                f.seek(0)
                f.truncate()
                if fcntl is not None:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as temp:
        json.dump(data, temp, indent=2, sort_keys=True)
        temp.flush()
        os.fsync(temp.fileno())
        temp_name = temp.name
    os.replace(temp_name, path)

