from __future__ import annotations

import hmac
import ipaddress
import json
import re
import secrets
import subprocess
from html import escape
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .control import ROW_ACTIONS, apply_control, read_plan
from .nodes import LoopConfig, _pid_alive, _today
from .state import LockBusyError, StateStore

PHASES = ("idle", "picked", "worker running", "PR open", "checks", "merged", "Test GX", "deploy", "health", "done")
ACTIONS = {*ROW_ACTIONS, "pause", "resume", "stop-worker", "note", "refresh"}
TOKEN_RE = re.compile(r"(?i)(?:gh[pousr]_[\w]+|github_pat_[\w]+|(?:bearer\s+|(?:gh_token|github_token|api_key|token|password)\s*[:=]\s*)[^\s,;]+)")


def tail(path: Path, limit: int) -> list[str]:
    try:
        with path.open("rb") as stream:
            end = stream.seek(0, 2)
            stream.seek(max(0, end - 1024 * 1024))
            return stream.read().decode("utf-8", errors="replace").splitlines()[-limit:]
    except FileNotFoundError:
        return []


def next_timer() -> str:
    try:
        output = subprocess.check_output(
            ["systemctl", "--user", "list-timers", "--no-legend", "--no-pager", "victron-loop.timer"],
            text=True, timeout=5, stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    for line in output.splitlines():
        fields = line.split()
        if "victron-loop.timer" in fields and len(fields) >= 4 and fields[0] != "-":
            return " ".join(fields[:4])
    return "unknown"


def snapshot(cfg: LoopConfig, store: StateStore, node: str = "") -> dict:
    state = store.load()
    try:
        plan = read_plan(cfg, state)
    except (OSError, subprocess.SubprocessError):
        plan = {"error": "Could not read origin/master BACKLOG", "commit": None, "next": None, "eligible": [], "skipped": []}
    worker = state.get("active_worker")
    output = []
    if worker:
        path = Path(worker["log_path"])
        output = tail(path, 100)
        try:
            age = max(0, int(cfg.clock() - path.stat().st_mtime))
        except FileNotFoundError:
            age = None
        worker = {
            **{key: worker.get(key) for key in ("row_id", "branch", "tier", "model", "pid", "started_at")},
            "pid_alive": _pid_alive(int(worker.get("pid") or 0)),
            "last_output_age_seconds": age,
        }
    decisions = []
    for line in reversed(tail(store.log_file, 200)):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not node or node == entry.get("node", entry.get("command")):
            decisions.append({key: entry[key] for key in ("node", "command", "action", "result", "ts") if key in entry})
    observed = state.get("observed", {})
    last_run = state.get("last_run")
    dry_runs = tail(store.dry_run_file, 1)
    if dry_runs:
        try:
            latest = json.loads(dry_runs[0])
        except json.JSONDecodeError:
            latest = {}
        if latest.get("ts", 0) > (last_run or {}).get("at", 0):
            last_run = {"at": latest["ts"], "result": latest.get("result"), "dry_run": True}
    return {
        "paused": state.get("paused", False), "last_run": last_run, "next_timer": next_timer(),
        "worker": worker, "last_worker_status": (state.get("last_worker") or {}).get("status"),
        "pr": state.get("worker_pr") or next(iter(observed.get("open_prs", [])), None),
        "test_gx": observed.get("test_gx"), "deploy": observed.get("deploy"), "health": observed.get("deploy_health"),
        "phase": state.get("phase", "idle"), "phases": PHASES,
        "budget": {"used": state.get("daily_counts", {}).get(_today(cfg.clock), 0), "cap": cfg.max_worker_runs_per_day},
        "plan": plan, "owner_note": state.get("owner_note", ""), "pinned_row": state.get("pinned_row"),
        "decisions": decisions, "worker_log": output, "notifications": state.get("notifications_sent", {}),
    }


def render(data: dict, csrf: str, node: str) -> str:
    def show(value) -> str:
        return escape(json.dumps(value, indent=2, ensure_ascii=False))

    def form(action: str, label: str, value: str = "", *, extra: str = "") -> str:
        return (
            f'<form method="post" action="/api/{action}" {extra}>'
            f'<input type="hidden" name="csrf" value="{csrf}">'
            f'<input type="hidden" name="value" value="{escape(value)}"><button>{label}</button></form>'
        )

    plan = data["plan"]
    rows = []
    for row in plan["eligible"] + plan["skipped"]:
        key, reason = row["row_id"], row.get("reason", "eligible")
        controls = form("unskip" if reason == "skipped" else "skip", "Unskip" if reason == "skipped" else "Skip", key)
        if reason == "needs-owner-go":
            controls += form("approve", "Approve", key)
        if reason == "eligible":
            controls += form("pin", "Pin as next", key)
        rows.append(f"<tr><td>{escape(key)}</td><td>{escape(row['task'])}</td><td>{escape(reason)}</td><td>{controls}</td></tr>")
    phase = " → ".join(f"<strong>{step}</strong>" if step == data["phase"] else step for step in PHASES)
    pr = data["pr"] or {}
    url = pr.get("url", "")
    link = f'<a href="{escape(url)}">PR #{escape(str(pr.get("number")))}</a>' if url.startswith("https://github.com/") else ""
    stop = form("stop-worker", "Stop now", "yes", extra='onsubmit="return confirm(\'Terminate the active worker and pause?\')"')
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>Victron dev loop</title><style>
body{{font:16px system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem}}
form{{display:inline-block;margin:.2rem}} pre{{white-space:pre-wrap;overflow-wrap:anywhere}}
td{{padding:.35rem}} textarea{{display:block;width:min(36rem,90vw)}} strong{{color:#17643a}}
</style><h1>Victron dev loop: {"Paused" if data["paused"] else "Running"}</h1>
{form("resume", "Start")}{form("pause", "Pause")}{stop}
<p>{phase} ({escape(data["phase"])})</p><p>Budget: {data["budget"]["used"]}/{data["budget"]["cap"]}</p>
<p>Last run: {show(data["last_run"])} · Next timer: {escape(data["next_timer"])}</p>
<h2>Worker and PR</h2><pre>{show(data["worker"])}</pre>{link}
<pre>{show(pr.get("reviewDecision"))}\n{show(pr.get("statusCheckRollup"))}</pre>
<h2>Master Test GX, deploy and health</h2><pre>{show([data["test_gx"], data["deploy"], data["health"]])}</pre>
<h2>Next task</h2><p>Plan commit: {show(plan["commit"])} {form("refresh", "Refresh plan")}</p>
<p>{escape(plan.get("error", ""))} Next: {show((plan["next"] or {}).get("row_id"))}
 · Pinned: {show(data["pinned_row"])}</p>
<table><thead><tr><th>Row</th><th>Task</th><th>State</th><th>Controls</th></tr></thead><tbody>{"".join(rows)}</tbody></table>
<form method="post" action="/api/note"><input type="hidden" name="csrf" value="{csrf}">
<label>Owner note<textarea name="value" maxlength="4000">{escape(data["owner_note"])}</textarea></label>
<button>Save note</button></form>
<h2>Decisions</h2><form method="get"><label>Node <input name="node" value="{escape(node)}"></label><button>Filter</button></form>
<pre>{show(data["decisions"])}</pre><h2>Worker log</h2><pre>{escape(chr(10).join(data["worker_log"]))}</pre>
<h2>Notifications sent</h2><pre>{show(data["notifications"])}</pre></html>"""


def make_server(cfg: LoopConfig, store: StateStore) -> ThreadingHTTPServer:
    host, _, port = cfg.web_bind.rpartition(":")
    ip = ipaddress.IPv4Address(host)
    # RFC 6598 shared address space is neither private nor globally reachable.
    if not (ip.is_loopback or (not ip.is_private and not ip.is_global)):
        raise ValueError("web_bind must use a Tailscale IPv4 or loopback address")
    token = cfg.web_token_file.read_text(encoding="utf-8").strip() if cfg.web_token_file else ""
    if cfg.web_token_file and not re.fullmatch(r"[a-zA-Z0-9._~-]{16,}", token):
        raise ValueError("web_token_file must contain a URL-safe token of at least 16 characters")
    private = [token] if token else []
    if cfg.token_file and cfg.token_file.is_file():
        private.append(cfg.token_file.read_text(encoding="utf-8").strip())
    csrf = secrets.token_urlsafe(32)

    def redact(value):
        if isinstance(value, dict):
            return {redact(key): redact(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [redact(item) for item in value]
        if isinstance(value, str):
            for secret in private:
                if secret:
                    value = value.replace(secret, "[redacted]")
            return TOKEN_RE.sub("[redacted]", value)
        return value

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def reply(self, status, content=b"", content_type="application/json", headers=()):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(content)

        def error(self, code, message):
            self.reply(code, json.dumps({"error": message}).encode())

        def authorized(self):
            expected = f"{host}:{self.server.server_port}"
            if self.headers.get_all("Host") != [expected]:
                self.error(403, "Invalid Host")
                return False
            if not token:
                return True
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except CookieError:
                pass
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            cookie_token = cookie["victron_loop"].value if "victron_loop" in cookie else ""
            if any(hmac.compare_digest(candidate.encode(), token.encode()) for candidate in (supplied, cookie_token)):
                return True
            self.error(401, "Authentication required")
            return False

        def do_GET(self):
            if not self.authorized():
                return
            request = urlsplit(self.path)
            if request.path not in {"/", "/api/status"}:
                self.error(404, "Not found")
                return
            node = parse_qs(request.query).get("node", [""])[0]
            data = redact(snapshot(cfg, store, node))
            if request.path == "/api/status":
                self.reply(200, json.dumps(data).encode(), headers=(("X-CSRF-Token", csrf),))
            else:
                self.reply(200, render(data, csrf, redact(node)).encode(), "text/html; charset=utf-8")

        def do_POST(self):
            if not self.authorized():
                return
            action = urlsplit(self.path).path.removeprefix("/api/")
            if self.path != f"/api/{action}" or action not in ACTIONS:
                self.error(404, "Not found")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 <= length <= 65536:
                    raise ValueError
                body = self.rfile.read(length).decode()
                is_json = self.headers.get_content_type() == "application/json"
                if is_json:
                    fields = json.loads(body or "{}")
                else:
                    fields = {key: values[0] for key, values in parse_qs(body, keep_blank_values=True).items()}
                if not isinstance(fields, dict):
                    raise ValueError
                submitted = self.headers.get("X-CSRF-Token", fields.get("csrf", ""))
                value = fields.get("value", "")
                if not isinstance(submitted, str) or not isinstance(value, str):
                    raise ValueError
            except ValueError:
                self.error(400, "Invalid request")
                return
            if not hmac.compare_digest(submitted.encode(), csrf.encode()):
                self.error(403, "Invalid CSRF token")
                return
            try:
                apply_control(store, cfg, action, value)
            except LockBusyError:
                self.error(409, "Loop is busy; try again after the tick")
                return
            except ValueError as exc:
                self.error(400, str(exc))
                return
            except (OSError, RuntimeError, subprocess.SubprocessError):
                self.error(503, "Control action failed")
                return
            self.reply(200, b'{"ok":true}') if is_json else self.reply(303, headers=(("Location", "/"),))

    return ThreadingHTTPServer((host, int(port)), Handler)


def serve(cfg: LoopConfig, store: StateStore) -> None:
    with make_server(cfg, store) as server:
        server.serve_forever()
