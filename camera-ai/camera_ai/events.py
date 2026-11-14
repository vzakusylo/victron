"""Event watcher: runs the detector on the live frame, records new objects as events with a snapshot.

An event fires when a watched class appears or its count grows compared with the last `baseline_s`
seconds (a parked car does not fire again and again), at most once per class per `cooldown_s`.
Each event: events/<id>.jpg (boxes drawn) + a line in events/events.jsonl; the vision LLM adds a
description in the background when Ollama has the model.
"""
import json
import queue
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2

from . import vision
from .detector import Detector, draw

WATCH = {"person", "bicycle", "car", "motorcycle", "bus", "truck", "bird", "cat", "dog", "horse", "sheep", "cow"}
ROOT = Path(__file__).resolve().parent.parent
EVENT_DIR = ROOT / "events"


def _iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class EventWatcher:
    def __init__(self, grabber, interval_s: float = 1.5, baseline_s: float = 60, cooldown_s: float = 90,
                 describe: bool = True, on_event=None):
        self.grabber, self.interval_s = grabber, interval_s
        self.baseline_s, self.cooldown_s, self.describe = baseline_s, cooldown_s, describe
        self.on_event = on_event  # callback(event dict) after the description is ready (part 3: alerts)
        self.detector = Detector()
        self.history: deque = deque()  # (ts, [detections known at that time])
        self.pending: list = []  # fresh detections of the previous cycle
        self.started = 0.0
        self.last_fire: dict = {}
        self.current: list = []
        self.paused = False
        self.events: list = []
        self._lock = threading.Lock()
        self._q: queue.Queue = queue.Queue()
        EVENT_DIR.mkdir(exist_ok=True)
        self._log = EVENT_DIR / "events.jsonl"
        if self._log.exists():
            for line in self._log.read_text("utf-8").splitlines()[-20000:]:
                try:
                    self.events.append(json.loads(line))
                except ValueError:
                    pass

    def start(self) -> "EventWatcher":
        threading.Thread(target=self._loop, name="detect", daemon=True).start()
        threading.Thread(target=self._describer, name="describe", daemon=True).start()
        return self

    def recent(self, n: int = 30) -> list:
        with self._lock:
            return list(reversed(self.events[-n:]))

    def _loop(self) -> None:
        while True:
            t0 = time.time()
            frame = None if self.paused else self.grabber.latest(max_age=3)
            if frame is not None:
                try:
                    dets = [d for d in self.detector.detect(frame) if d["label"] in WATCH]
                    self.current = dets
                    self._check(frame, dets)
                except Exception as e:  # noqa: BLE001  keep the watcher alive
                    print("detect error:", e)
            time.sleep(max(0.1, self.interval_s - (time.time() - t0)))

    def _check(self, frame, dets) -> None:
        """A detection is new when no box of the same class was near that place in the last baseline_s
        (a parked car stays known) and it is seen in two cycles in a row (cuts one-frame false hits)."""
        now = time.time()
        if not self.started:
            self.started = now
        while self.history and now - self.history[0][0] > self.baseline_s:
            self.history.popleft()
        known = [d for _, ds in self.history for d in ds]
        fresh = [d for d in dets if not any(k["label"] == d["label"] and _iou(k["box"], d["box"]) > 0.3 for k in known)]
        confirmed = [d for d in fresh if any(p["label"] == d["label"] and _iou(p["box"], d["box"]) > 0.3 for p in self.pending)]
        self.pending = fresh
        if now - self.started < 15:
            self.history.append((now, dets))  # first seconds after start: learn what is always there
            return
        self.history.append((now, [d for d in dets if d not in fresh] + confirmed))
        new = sorted({d["label"] for d in confirmed if now - self.last_fire.get(d["label"], 0) > self.cooldown_s})
        if not new:
            return
        for k in new:
            self.last_fire[k] = now
        eid = datetime.now().strftime("%Y%m%d-%H%M%S")
        cv2.imwrite(str(EVENT_DIR / f"{eid}.jpg"), draw(frame, dets), [cv2.IMWRITE_JPEG_QUALITY, 85])
        ev = {"id": eid, "time": datetime.now().isoformat(timespec="seconds"), "labels": sorted(new),
              "objects": [{"label": d["label"], "conf": d["conf"]} for d in dets], "description": None}
        ok, raw = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        with self._lock:
            self.events.append(ev)
        self._append(ev)
        if self.describe and ok:
            self._q.put((ev, raw.tobytes()))
        elif self.on_event:
            self.on_event(ev)

    def _describer(self) -> None:
        while True:
            ev, jpg = self._q.get()
            try:
                if vision.available():
                    hint = (f"микрофон услышал громкий звук ({ev['sound']['level_db']} dBFS, фон "
                            f"{ev['sound']['background_db']}); что на кадре могло его вызвать?") if "sound" in ev else \
                        f"детектор заметил {', '.join(ev['labels'])}."
                    ev["description"] = vision.ask(jpg, "Опиши кратко, что происходит на кадре: " + hint)
                else:
                    ev["description"] = f"(модель {vision.MODEL} ещё не загружена в Ollama)"
            except Exception as e:  # noqa: BLE001
                ev["description"] = f"(описание не получено: {e})"
            self._rewrite()
            if self.on_event:
                try:
                    self.on_event(ev)
                    self._rewrite()  # keep what the callback added (e.g. the mail result)
                except Exception as e:  # noqa: BLE001
                    print("on_event error:", e)

    def add_sound(self, level: float, background: float, clip) -> None:
        """Sound event from AudioWatcher: WAV clip + current frame, then description and callback."""
        from .audio import write_wav
        eid = datetime.now().strftime("%Y%m%d-%H%M%S")
        write_wav(EVENT_DIR / f"{eid}.wav", clip)
        frame = self.grabber.latest(max_age=5)
        if frame is not None:
            cv2.imwrite(str(EVENT_DIR / f"{eid}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        ev = {"id": eid, "time": datetime.now().isoformat(timespec="seconds"), "labels": ["sound"],
              "objects": [{"label": d["label"], "conf": d["conf"]} for d in self.current],
              "sound": {"level_db": level, "background_db": background, "wav": f"{eid}.wav"},
              "description": None}
        with self._lock:
            self.events.append(ev)
        self._append(ev)
        if self.describe and frame is not None:
            ok, raw = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                self._q.put((ev, raw.tobytes()))
                return
        ev["description"] = f"Громкий звук {level} dBFS (фон {background})."
        self._rewrite()
        if self.on_event:
            self.on_event(ev)

    def day(self, date: str) -> list:
        """All events of a day (YYYY-MM-DD) from the log, oldest first."""
        out = []
        if self._log.exists():
            for line in self._log.read_text("utf-8").splitlines():
                if f'"time": "{date}' in line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
        return out

    def clear_known(self) -> None:
        """After the camera moves the scene changes: relearn what is there for a few seconds."""
        self.history.clear()
        self.pending = []
        self.started = 0.0

    def _append(self, ev) -> None:
        with self._log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")

    def _rewrite(self) -> None:
        with self._lock:
            lines = [json.dumps(e, ensure_ascii=False) for e in self.events[-20000:]]
        self._log.write_text("\n".join(lines) + "\n", encoding="utf-8")
