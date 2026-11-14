"""Background RTSP frame grabber: keeps the latest frame of a stream (OpenCV / FFmpeg over TCP)."""
import os
import threading
import time

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000")
import cv2  # noqa: E402  (the env var must be set before the import)


class FrameGrabber:
    def __init__(self, url: str, name: str = "stream"):
        self.url, self.name = url, name
        self._frame = None
        self._ts = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.error = ""
        self.fps = 0.0
        self._thread = threading.Thread(target=self._run, name=f"grab-{name}", daemon=True)

    def start(self) -> "FrameGrabber":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.error = "cannot open the RTSP stream"
                time.sleep(3)
                continue
            self.error = ""
            n, t0 = 0, time.time()
            while not self._stop.is_set():
                try:
                    ok, frame = cap.read()
                except Exception as e:  # noqa: BLE001  (e.g. out of memory) keep the thread alive
                    self.error, ok = f"read error: {e}", False
                if not ok:
                    self.error = "stream read failed, reconnecting"
                    break
                with self._lock:
                    self._frame, self._ts = frame, time.time()
                n += 1
                if n % 30 == 0:
                    self.fps = 30 / max(1e-3, time.time() - t0)
                    t0 = time.time()
            cap.release()
            time.sleep(1)

    def latest(self, max_age: float = 5.0):
        """Latest frame (numpy BGR) or None when older than max_age seconds."""
        with self._lock:
            if self._frame is None or time.time() - self._ts > max_age:
                return None
            return self._frame.copy()

    def jpeg(self, quality: int = 80, max_age: float = 5.0) -> bytes | None:
        f = self.latest(max_age)
        if f is None:
            return None
        ok, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None
