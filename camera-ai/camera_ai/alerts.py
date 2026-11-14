"""E-mail alerts through the Cerbo GX: the snapshot and a JSON message are copied to the GX by scp and
sent there with /data/home/nodered/tools/send-mail.js (same mailbox as the heat pump alerts, settings in
grid-control-config/email.json on the GX; no mail password on this PC).

Config (config/camera.json, optional):
  "alerts": {"enabled": true, "labels": ["person"], "cooldown_min": 10,
             "gx": "root@192.168.0.110", "ssh_key": "~/.ssh/id_ed25519_cerbo"}
"""
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

DEFAULTS = {"enabled": True, "labels": ["person"], "cooldown_min": 10,
            "gx": "root@192.168.0.110", "ssh_key": "~/.ssh/id_ed25519_cerbo"}
MAIL_TOOL = "/data/home/nodered/tools/send-mail.js"
RU = {"sound": "громкий звук", "person": "человек", "car": "машина", "truck": "грузовик", "bus": "автобус", "bicycle": "велосипед",
      "motorcycle": "мотоцикл", "dog": "собака", "cat": "кошка", "bird": "птица", "horse": "лошадь"}


class Mailer:
    def __init__(self, cfg: dict, camera_name: str = "Kitchen"):
        self.cfg = {**DEFAULTS, **(cfg.get("alerts") or {})}
        self.camera = camera_name
        self.last_sent = 0.0
        self.last_result: dict = {}
        self._lock = threading.Lock()

    def _ssh_base(self) -> list:
        return ["-i", os.path.expanduser(self.cfg["ssh_key"]), "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10"]

    def send(self, subject: str, text: str, jpg: Path | None = None, tries: int = 3) -> dict:
        """Like _send_once, retried: the Wi-Fi link to the GX sometimes times out."""
        res = {}
        for i in range(tries):
            res = self._send_once(subject, text, jpg)
            if res.get("ok") or "scp" not in res.get("error", "") and "timeout" not in res.get("error", ""):
                break
            time.sleep(10)
        res["tries"] = i + 1
        return res

    def _send_once(self, subject: str, text: str, jpg: Path | None = None) -> dict:
        """Copies the files to the GX and runs send-mail.js there. Returns its JSON result."""
        with self._lock:
            tag = f"camera-alert-{int(time.time() * 1000)}"
            tmp = Path(tempfile.mkdtemp())
            msg = tmp / f"{tag}.json"
            msg.write_text(json.dumps({"subject": subject, "text": text}, ensure_ascii=False), "utf-8")
            files = [str(msg)]
            remote_jpg = None
            if jpg and jpg.exists():
                local_jpg = tmp / f"{tag}.jpg"
                local_jpg.write_bytes(jpg.read_bytes())
                files.append(str(local_jpg))
                remote_jpg = f"/tmp/{tag}.jpg"
            gx = self.cfg["gx"]
            try:
                r = subprocess.run(["scp", *self._ssh_base(), *files, f"{gx}:/tmp/"],
                                   capture_output=True, text=True, timeout=120)
                if r.returncode:
                    return self._done({"ok": False, "error": "scp: " + (r.stderr.strip()[-200:] or str(r.returncode))})
                cmd = f"node {MAIL_TOOL} --file /tmp/{tag}.json" + (f" --attach {remote_jpg}" if remote_jpg else "")
                cmd += f"; rm -f /tmp/{tag}.json" + (f" {remote_jpg}" if remote_jpg else "")
                r = subprocess.run(["ssh", *self._ssh_base(), gx, cmd], capture_output=True, text=True, timeout=180)
                line = (r.stdout.strip().splitlines() or [""])[-1]
                try:
                    res = json.loads(line)
                except ValueError:
                    res = {"ok": False, "error": (line or r.stderr.strip())[-200:] or f"exit {r.returncode}"}
                return self._done(res)
            except subprocess.TimeoutExpired:
                return self._done({"ok": False, "error": "timeout talking to the GX"})
            finally:
                for p in tmp.iterdir():
                    p.unlink()
                tmp.rmdir()

    def _done(self, res: dict) -> dict:
        res["time"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.last_result = res
        return res

    def on_event(self, ev: dict, event_dir: Path) -> None:
        """Watcher callback (after the description). Sends for the configured labels with a cooldown."""
        if not self.cfg["enabled"]:
            return
        hit = [l for l in ev.get("labels", []) if l in self.cfg["labels"]]
        if not hit or time.time() - self.last_sent < self.cfg["cooldown_min"] * 60:
            return
        self.last_sent = time.time()
        what = ", ".join(RU.get(l, l) for l in hit)
        when = ev.get("time", "").replace("T", " ")
        text = (f"Камера {self.camera}: {what}\nВремя: {when}\n\n"
                f"{ev.get('description') or '(без описания)'}\n\n"
                f"Объекты: " + ", ".join(f"{RU.get(o['label'], o['label'])} {o['conf']}" for o in ev.get("objects", [])) +
                f"\nСледующее письмо не раньше чем через {self.cfg['cooldown_min']} мин.\n"
                "Страница камеры на ПК: http://127.0.0.1:8090")
        res = self.send(f"Камера {self.camera}: {what} ({when[11:16]})", text, event_dir / f"{ev['id']}.jpg")
        ev["mail"] = res
