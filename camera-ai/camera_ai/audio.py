"""Sound watcher: reads the camera audio (RTSP stream2, G.711 A-law 8 kHz mono) with PyAV and records
"sound" events when the level jumps well above the background.

Level: RMS in dBFS per 0.5 s block. Background: median of the last 60 s. Event when a block is
>= JUMP_DB above the background and louder than MIN_DBFS, at most once per COOLDOWN_S.
The event keeps a WAV clip (3 s before .. 3 s after) and the current video frame.
"""
import threading
import time
import wave
from collections import deque
from pathlib import Path

import av
import numpy as np

JUMP_DB = 25.0      # was 18: 27 events in half a day on 2026-11-13
MIN_DBFS = -30.0    # was -38
COOLDOWN_S = 300.0  # was 60
SUSTAIN_BLOCKS = 2  # the jump must last 2 blocks (1 s) in a row: ignores single clicks / knocks
RATE = 8000


class AudioWatcher:
    def __init__(self, url: str, on_sound):
        """on_sound(level_db, background_db, pcm_int16_clip) is called from this thread."""
        self.url, self.on_sound = url, on_sound
        self.level = None
        self.background = None
        self.error = ""
        self.paused = False
        self._ring = deque(maxlen=RATE * 3)       # 3 s before the trigger
        self._levels = deque(maxlen=120)          # 60 s of 0.5 s blocks
        self._last = 0.0
        self._run_len = 0

    def start(self) -> "AudioWatcher":
        threading.Thread(target=self._run, name="audio", daemon=True).start()
        return self

    def _run(self) -> None:
        while True:
            try:
                ct = av.open(self.url, options={"rtsp_transport": "tcp"}, timeout=10)
                stream = ct.streams.audio[0]
                self.error = ""
                block = np.zeros(0, np.int16)
                pending = None  # (deadline, level, bg, before) while collecting the 3 s after
                for frame in ct.decode(stream):
                    x = frame.to_ndarray().reshape(-1).astype(np.int16)
                    if pending is not None:
                        pending[3].append(x)
                        if sum(len(p) for p in pending[3]) >= RATE * 3:
                            clip = np.concatenate([pending[4]] + pending[3])
                            self.on_sound(pending[1], pending[2], clip)
                            pending = None
                    self._ring.extend(x)
                    block = np.concatenate([block, x])
                    while len(block) >= RATE // 2:
                        b, block = block[: RATE // 2], block[RATE // 2:]
                        rms = np.sqrt(np.mean((b.astype(np.float32) / 32768.0) ** 2)) + 1e-9
                        lvl = 20 * np.log10(rms)
                        self.level = round(float(lvl), 1)
                        bg = float(np.median(self._levels)) if len(self._levels) >= 20 else None
                        self.background = None if bg is None else round(bg, 1)
                        self._levels.append(lvl)
                        loud = bg is not None and lvl >= MIN_DBFS and lvl - bg >= JUMP_DB
                        self._run_len = self._run_len + 1 if loud else 0
                        if (loud and self._run_len >= SUSTAIN_BLOCKS and not self.paused and pending is None
                                and time.time() - self._last > COOLDOWN_S):
                            self._last = time.time()
                            pending = [time.time(), round(float(lvl), 1), round(bg, 1), [],
                                       np.array(self._ring, np.int16)]
                ct.close()
            except Exception as e:  # noqa: BLE001  reconnect on any stream error
                self.error = str(e)[:200]
            time.sleep(3)


def write_wav(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.astype("<i2").tobytes())
