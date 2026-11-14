"""Starts app.py without a console (pythonw), restarts it when it exits, writes output to logs/app.log.

Started at logon by a shortcut in the user's Startup folder (Task Scheduler is blocked by policy on
this PC). Exits at once when the page already runs (port in use). The log is cut when it passes 5 MB.
"""
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOGS = ROOT / "logs"
PORT = 8090
PY = ROOT / ".venv" / "Scripts" / "python.exe"
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def port_busy() -> bool:
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def main() -> None:
    os.chdir(ROOT)
    LOGS.mkdir(exist_ok=True)
    if port_busy():
        return
    time.sleep(20)  # after logon: let Wi-Fi and Ollama come up
    while True:
        log_file = LOGS / "app.log"
        if log_file.exists() and log_file.stat().st_size > 5 * 1024 * 1024:
            log_file.replace(LOGS / "app.old.log")
        with open(log_file, "a", encoding="utf-8") as log:
            log.write(f"{datetime.now().isoformat(timespec='seconds')} launcher: starting app.py\n")
            log.flush()
            code = subprocess.call([str(PY), "-u", str(ROOT / "app.py")], cwd=ROOT, stdout=log,
                                   stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
            log.write(f"{datetime.now().isoformat(timespec='seconds')} launcher: app.py exited {code}, restart in 30 s\n")
        time.sleep(30)
        if port_busy():  # someone started it by hand meanwhile
            return


if __name__ == "__main__":
    sys.exit(main())
