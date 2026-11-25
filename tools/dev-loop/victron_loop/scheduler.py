from __future__ import annotations

import json
import signal
import threading
from contextlib import contextmanager
from datetime import datetime
from urllib.parse import urlsplit
from urllib.request import urlopen


def peer_blocker(cfg) -> str | None:
    if cfg.dry_run or not cfg.peer_status_url:
        return None
    try:
        url = urlsplit(cfg.peer_status_url)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError("Invalid peer URL")
        with urlopen(cfg.peer_status_url, timeout=5) as response:
            peer = json.loads(response.read(4096))
        if (not isinstance(peer, dict) or not isinstance(peer.get("instance_name"), str)
                or peer["instance_name"] == cfg.instance_name or not isinstance(peer.get("live"), bool)
                or not isinstance(peer.get("paused"), bool)):
            raise ValueError("Invalid peer status or duplicate instance name")
    except (OSError, ValueError):
        return "peer-status-unavailable"
    return "peer-loop-active" if peer["live"] and not peer["paused"] else None


class Scheduler:
    def __init__(self, clock, interval_seconds: float):
        self.clock = clock
        self.interval_seconds = interval_seconds
        self.next_at: float | None = None
        self.last_at: float | None = None
        self.stopping = False
        self.running_cycle = False
        self.wake = threading.Event()

    def request_run(self) -> None:
        self.wake.set()

    def stop(self, *_args) -> None:
        self.stopping = True

    def run(self, cycle, *, once: bool = False) -> int:
        self.next_at = self.clock()
        while not self.stopping:
            delay = max(0, self.next_at - self.clock())
            if not self.wake.wait(min(delay, 0.25)) and delay > 0.25:
                continue
            self.wake.clear()
            if self.stopping:
                break
            self.last_at = self.clock()
            self.next_at = None
            self.running_cycle = True
            try:
                status, result = cycle()
            finally:
                self.running_cycle = False
            if not once and not self.stopping:
                self.next_at = self.clock() + self.interval_seconds
            stamp = datetime.fromtimestamp(self.last_at).isoformat(sep=" ", timespec="seconds")
            next_run = datetime.fromtimestamp(self.next_at).isoformat(sep=" ", timespec="seconds") if self.next_at else "-"
            print(f"{stamp} | {result} | next: {next_run}", flush=True)
            if once:
                return status
        self.next_at = None
        return 0


@contextmanager
def stop_on_signal(scheduler: Scheduler):
    previous = {sig: signal.signal(sig, scheduler.stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
