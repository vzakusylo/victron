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

from .platform import WINDOWS, LockBusyError, exclusive_lock, state_root


@dataclass
class StateStore:
    root: Path
    state_file: Path
    log_file: Path
    dry_run_file: Path
    lock_file: Path

    @classmethod
    def open(cls, root: Path | None = None) -> "StateStore":
        base = root or state_root()
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
        _replace_file(temp.name, directory / f"{run['id']}.log")
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
        with exclusive_lock(self.lock_file):
            yield


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as temp:
        json.dump(data, temp, indent=2, sort_keys=True)
        temp.flush()
        os.fsync(temp.fileno())
        temp_name = temp.name
    _replace_file(temp_name, path)


def _replace_file(source: str, destination: Path) -> None:
    try:
        deadline = time.monotonic() + 1
        while True:
            try:
                os.replace(source, destination)
                return
            except PermissionError as exc:
                # Windows readers and scanners can briefly hold files without delete sharing.
                if not WINDOWS or getattr(exc, "winerror", None) not in {5, 32, 33} or time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
    finally:
        Path(source).unlink(missing_ok=True)

