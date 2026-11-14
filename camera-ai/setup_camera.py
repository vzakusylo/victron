"""Asks for the camera account and writes config/camera.json. The password is never printed."""
import getpass
import json
from pathlib import Path

CONFIG = Path(__file__).parent / "config" / "camera.json"


def main() -> None:
    old = json.loads(CONFIG.read_text("utf-8")) if CONFIG.exists() else {}
    host = input(f"Camera IP [{old.get('host', '192.168.0.146')}]: ").strip() or old.get("host", "192.168.0.146")
    user = input("Camera account username: ").strip()
    password = getpass.getpass("Camera account password: ")
    cfg = {
        "host": host,
        "rtsp_port": old.get("rtsp_port", 554),
        "onvif_port": old.get("onvif_port", 2020),
        "user": user,
        "password": password,
        "web_host": old.get("web_host", "127.0.0.1"),
        "web_port": old.get("web_port", 8090),
    }
    CONFIG.parent.mkdir(exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=2), "utf-8")
    print(f"Saved {CONFIG} (user {len(user)} chars, password {len(password)} chars).")
    input("Press Enter to close")


if __name__ == "__main__":
    main()
