"""Local web page for the Tapo C500: live view, pan / tilt arrows, presets, snapshots.

Run: .\\.venv\\Scripts\\python.exe app.py  ->  http://127.0.0.1:8090
"""
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, request, send_from_directory

from camera_ai import config, vision
from camera_ai.agent import Agent
from camera_ai.alerts import Mailer
from camera_ai.audio import AudioWatcher
from camera_ai.detector import draw
from camera_ai.events import EVENT_DIR, EventWatcher
from camera_ai.onvif import Onvif, OnvifError
from camera_ai.video import FrameGrabber

ROOT = Path(__file__).resolve().parent
SNAP_DIR = ROOT / "snapshots"
SNAP_DIR.mkdir(exist_ok=True)

cfg = config.load()
cam = Onvif(cfg["host"], cfg.get("onvif_port", 2020), cfg["user"], cfg["password"])
ptz_lock = threading.Lock()
grab_low = FrameGrabber(config.rtsp_url(cfg, "stream2"), "stream2").start()
mailer = Mailer(cfg)
watcher = EventWatcher(grab_low, on_event=lambda ev: mailer.on_event(ev, EVENT_DIR)).start()
audio = AudioWatcher(config.rtsp_url(cfg, "stream2"), watcher.add_sound).start()

app = Flask(__name__, static_folder=str(ROOT / "static"))

DIRS = {"left": (-1, 0), "right": (1, 0), "up": (0, 1), "down": (0, -1),
        "upleft": (-1, 1), "upright": (1, 1), "downleft": (-1, -1), "downright": (1, -1)}


def ptz(fn, *args):
    with ptz_lock:
        if cam.ptz_url is None:
            cam.connect()
        return fn(*args)


agent = Agent(lambda name, *a: ptz(getattr(cam, name), *a), grab_low, watcher)


def err(e: Exception, code: int = 502):
    return jsonify(ok=False, error=str(e)), code


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    out = {"ok": True, "stream": {"fps": round(grab_low.fps, 1), "error": grab_low.error,
                                  "live": grab_low.latest() is not None}}
    try:
        out["ptz"] = ptz(cam.status)
    except Exception as e:  # noqa: BLE001
        out["ptz_error"] = str(e)
    return jsonify(out)


@app.post("/api/move")
def move():
    d = request.json or {}
    if d.get("dir") not in DIRS:
        return err(ValueError("dir must be one of " + ", ".join(DIRS)), 400)
    speed = max(0.1, min(1.0, float(d.get("speed", 0.5))))
    secs = max(0.1, min(3.0, float(d.get("seconds", 0.4))))
    px, ty = DIRS[d["dir"]]
    try:
        ptz(cam.move_for, px * speed, ty * speed, secs)
        watcher.clear_known()
        return jsonify(ok=True)
    except (OnvifError, OSError) as e:
        return err(e)


@app.post("/api/stop")
def stop():
    try:
        ptz(cam.stop)
        return jsonify(ok=True)
    except (OnvifError, OSError) as e:
        return err(e)


@app.get("/api/presets")
def presets():
    try:
        return jsonify(ok=True, presets=ptz(cam.presets))
    except (OnvifError, OSError) as e:
        return err(e)


@app.post("/api/presets/goto")
def preset_goto():
    try:
        ptz(cam.goto_preset, str((request.json or {}).get("token", "")))
        watcher.clear_known()
        return jsonify(ok=True)
    except (OnvifError, OSError) as e:
        return err(e)


@app.post("/api/presets/save")
def preset_save():
    name = str((request.json or {}).get("name", "")).strip()[:30]
    if not name:
        return err(ValueError("name is empty"), 400)
    try:
        return jsonify(ok=True, token=ptz(cam.set_preset, name))
    except (OnvifError, OSError) as e:
        return err(e)


@app.post("/api/presets/remove")
def preset_remove():
    try:
        ptz(cam.remove_preset, str((request.json or {}).get("token", "")))
        return jsonify(ok=True)
    except (OnvifError, OSError) as e:
        return err(e)


@app.get("/snapshot.jpg")
def snapshot():
    jpg = grab_low.jpeg()
    if jpg is None:
        return Response("no frame yet", status=503)
    return Response(jpg, mimetype="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/api/snapshot/hd")
def snapshot_hd():
    """Saves the current frame (stream2 is 1280x720 on the C500) in snapshots/.

    stream1 (full resolution) does not open in the OpenCV FFmpeg build (fails right after the SDP);
    see PLAN.md.
    """
    jpg = grab_low.jpeg(quality=92, max_age=2)
    if not jpg:
        return err(RuntimeError(grab_low.error or "no frame"))
    name = datetime.now().strftime("snap-%Y%m%d-%H%M%S.jpg")
    (SNAP_DIR / name).write_bytes(jpg)
    return jsonify(ok=True, file=name)


@app.get("/snapshots/<path:name>")
def snapshot_file(name):
    return send_from_directory(SNAP_DIR, name)


@app.get("/live.mjpg")
def live():
    boxes = request.args.get("boxes") == "1"

    def gen():
        while True:
            f = grab_low.latest()
            if f is not None:
                if boxes and watcher.current:
                    f = draw(f, watcher.current)
                ok, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            time.sleep(0.1)
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.get("/api/events")
def events():
    return jsonify(ok=True, current=watcher.current, paused=watcher.paused, events=watcher.recent(30),
                   vision=vision.available(),
                   audio={"level": audio.level, "background": audio.background, "error": audio.error})


@app.get("/api/day")
def day():
    date = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    evs = watcher.day(date)
    counts, hours = {}, [0] * 24
    for e in evs:
        for l in e.get("labels", []):
            counts[l] = counts.get(l, 0) + 1
        hours[int(e["time"][11:13])] += 1
    return jsonify(ok=True, date=date, total=len(evs), counts=counts, hours=hours, events=evs)


@app.post("/api/day/summary")
def day_summary():
    """Text summary of a day by the local LLM, from the event times, labels and descriptions."""
    date = (request.json or {}).get("date") or datetime.now().strftime("%Y-%m-%d")
    evs = watcher.day(date)
    if not evs:
        return jsonify(ok=True, summary="За этот день событий нет.")
    lines = [f"{e['time'][11:16]} {', '.join(e['labels'])}: {(e.get('description') or '')[:200]}" for e in evs[-150:]]
    try:
        text = vision.text("Вот события камеры у дома за " + date + ". Сделай короткую сводку дня по-русски: "
                           "сколько и каких событий, когда было активнее всего, что важного (люди, машины, "
                           "громкие звуки). Без выдумок.\n\n" + "\n".join(lines))
        return jsonify(ok=True, summary=text)
    except Exception as e:  # noqa: BLE001
        return err(e)


@app.post("/api/events/pause")
def events_pause():
    watcher.paused = bool((request.json or {}).get("paused", True))
    return jsonify(ok=True, paused=watcher.paused)


@app.get("/events/<path:name>")
def event_file(name):
    return send_from_directory(EVENT_DIR, name)


@app.get("/api/alerts")
def alerts_get():
    return jsonify(ok=True, config={k: mailer.cfg[k] for k in ("enabled", "labels", "cooldown_min")},
                   last=mailer.last_result)


@app.post("/api/alerts")
def alerts_set():
    d = request.json or {}
    if "enabled" in d:
        mailer.cfg["enabled"] = bool(d["enabled"])
    if isinstance(d.get("labels"), list):
        mailer.cfg["labels"] = [str(x) for x in d["labels"]][:12]
    if "cooldown_min" in d:
        mailer.cfg["cooldown_min"] = max(1, min(240, int(d["cooldown_min"])))
    cfg["alerts"] = {**cfg.get("alerts", {}), **{k: mailer.cfg[k] for k in ("enabled", "labels", "cooldown_min")}}
    config.CONFIG.write_text(__import__("json").dumps(cfg, indent=2), "utf-8")
    return alerts_get()


@app.post("/api/alerts/test")
def alerts_test():
    """Sends a test mail with the current frame through the GX."""
    jpg = grab_low.jpeg(quality=85)
    path = None
    if jpg:
        path = SNAP_DIR / datetime.now().strftime("test-mail-%Y%m%d-%H%M%S.jpg")
        path.write_bytes(jpg)
    res = mailer.send(f"Камера {mailer.camera}: тестовое письмо",
                      "Тестовое письмо от camera-ai (ПК -> Cerbo GX -> почта). Во вложении текущий кадр.", path)
    return jsonify(ok=bool(res.get("ok")), result=res, error=res.get("error"))


@app.post("/api/chat")
def chat():
    d = request.json or {}
    if d.get("reset"):
        agent.reset()
        return jsonify(ok=True)
    text = str(d.get("text", "")).strip()[:500]
    if not text:
        return err(ValueError("empty message"), 400)
    if not vision.available():
        return err(RuntimeError(f"Ollama model {vision.MODEL} is not available yet"), 503)
    t0 = time.time()
    try:
        out = agent.chat(text)
        return jsonify(ok=True, seconds=round(time.time() - t0, 1), **out)
    except Exception as e:  # noqa: BLE001
        return err(e)


@app.post("/api/describe")
def describe():
    """Asks the local vision LLM about the current frame."""
    q = str((request.json or {}).get("question") or "Что видно на кадре?")[:300]
    jpg = grab_low.jpeg(quality=85)
    if jpg is None:
        return err(RuntimeError("no frame"))
    if not vision.available():
        return err(RuntimeError(f"Ollama model {vision.MODEL} is not available yet"), 503)
    t0 = time.time()
    try:
        return jsonify(ok=True, answer=vision.ask(jpg, q), seconds=round(time.time() - t0, 1))
    except Exception as e:  # noqa: BLE001
        return err(e)


if __name__ == "__main__":
    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)  # no line per request (the page polls every 3 s)
    print(datetime.now().isoformat(timespec="seconds"), "camera-ai starting")
    try:
        ptz(lambda: None)
        print("ONVIF ok:", cam.device_info().get("Model", "?"), "| profile", cam.profile)
    except Exception as e:  # noqa: BLE001
        print("ONVIF not ready:", e)
    app.run(host=cfg.get("web_host", "127.0.0.1"), port=int(cfg.get("web_port", 8090)), threaded=True)
