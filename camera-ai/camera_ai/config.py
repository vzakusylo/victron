"""Loads config/camera.json (written by setup_camera.py)."""
import json
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "camera.json"


def load() -> dict:
    if not CONFIG.exists():
        raise SystemExit(f"{CONFIG} is missing: run setup_camera.py first")
    return json.loads(CONFIG.read_text("utf-8"))


def rtsp_url(cfg: dict, stream: str = "stream2") -> str:
    """RTSP URL with the account URL-encoded (passwords may contain # ! @)."""
    auth = f"{quote(cfg['user'], safe='')}:{quote(cfg['password'], safe='')}"
    return f"rtsp://{auth}@{cfg['host']}:{cfg.get('rtsp_port', 554)}/{stream}"
