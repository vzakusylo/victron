"""Event novelty logic without camera or model: python tests/test_events.py"""
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from camera_ai import events  # noqa: E402

events.EVENT_DIR = Path(tempfile.mkdtemp())


class FakeDetector:
    def detect(self, frame):
        return []


events.Detector = FakeDetector
w = events.EventWatcher(grabber=None, describe=False)
fired = []
w.on_event = fired.append
frame = np.zeros((720, 1280, 3), np.uint8)
car = {"label": "car", "conf": 0.8, "box": [343, 397, 755, 591]}
person = {"label": "person", "conf": 0.7, "box": [900, 300, 980, 560]}
t = [1000.0]
time.time = lambda: t[0]


def step(dets, dt=1.5):
    t[0] += dt
    w._check(frame, dets)


for _ in range(12):            # 18 s warm-up with the parked car
    step([car])
assert fired == [], fired
step([car]); step([]); step([car])  # car flickers: never new
assert fired == [], fired
step([car, person])            # person seen once: pending only
assert fired == [], fired
step([car, person])            # second time: event
assert [e["labels"] for e in fired] == [["person"]], fired
for _ in range(5):
    step([car, person])        # stays: no new events
assert len(fired) == 1, fired
moved = dict(person, box=[100, 300, 180, 560])
step([car, moved]); step([car, moved])  # same class at a new place, but within cooldown
assert len(fired) == 1, fired
t[0] += 100
step([car, dict(person, box=[500, 100, 560, 300])]); step([car, dict(person, box=[500, 100, 560, 300])])
assert len(fired) == 2, fired
w.clear_known()
for _ in range(12):
    step([dict(car, box=[0, 0, 300, 200])])  # after a camera move: relearn, no event
assert len(fired) == 2, fired
print("ok", len(fired), "events")
