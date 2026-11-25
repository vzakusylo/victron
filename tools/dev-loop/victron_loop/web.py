from __future__ import annotations

import hmac
import ipaddress
import json
import re
import secrets
import subprocess
from datetime import datetime, timezone
from html import escape
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .control import ROW_ACTIONS, apply_control, read_plan
from .gh import read_token, token_details
from .nodes import LoopConfig, _pid_alive, _today
from .state import LockBusyError, StateStore

PHASES = ("idle", "picked", "worker running", "PR open", "checks", "merged", "Test GX", "deploy", "health", "done")
ACTIONS = {*ROW_ACTIONS, "pause", "resume", "run-now", "stop-worker", "note", "refresh"}
TOKEN_RE = re.compile(r"""(?i)(?:gh[pousr]_\w+|github_pat_\w+|(?:bearer\s+|(?:gh_token|github_token|api_key|token|password)["']?\s*[:=]\s*["']?)[^\s,;"']+)""")
ANSI_RE = re.compile(r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])")
JOURNALS = {
    "loop": "victron-loop.service", "page": "victron-loop-web.service", "runners": "actions-runner-victron.service",
}
LOG_SOURCES = {
    "loop": "Loop runs", "page": "Page server", "runners": "Runners", "decisions": "Decisions",
    "dry-run": "Dry run", "worker": "Worker", "notifications": "Notifications", "last-run": "Last run output",
}


def tail(path: Path, limit: int) -> list[str]:
    try:
        with path.open("rb") as stream:
            end = stream.seek(0, 2)
            stream.seek(max(0, end - 1024 * 1024))
            return stream.read().decode("utf-8", errors="replace").splitlines()[-limit:]
    except FileNotFoundError:
        return []


def timer_times(now: float | None = None) -> dict[str, str]:
    unit = "victron-loop.timer"
    command = ["systemctl", "--user", "--no-pager"]
    options = {"text": True, "timeout": 5, "stderr": subprocess.PIPE}
    unknown = {"timer_next": "Unknown", "timer_last": "Unknown"}

    def error_text(exc: Exception) -> str:
        message = getattr(exc, "stderr", None)
        return message.strip() if isinstance(message, str) and message.strip() else str(exc)

    def from_property(value: str | None) -> str | None:
        if not value:
            return None
        match = re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", value)
        return local_time(int(datetime.fromisoformat(match[0]).timestamp()), now) if match else value

    try:
        output = subprocess.check_output(
            [*command, "show", unit, "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec",
             "-p", "ActiveState"], **options,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {**unknown, "timer_error": error_text(exc)}
    fields = {}
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        if separator and value.strip() not in {"", "n/a", "-"}:
            fields[key] = value.strip()
    next_time = from_property(fields.get("NextElapseUSecRealtime"))
    last_time = from_property(fields.get("LastTriggerUSec"))
    state = {"timer_state": fields.get("ActiveState", "unknown")}
    if next_time or state["timer_state"] != "active":
        return {**state, "timer_next": next_time or "Not scheduled", "timer_last": last_time or "Not recorded"}

    # OnBootSec/OnUnitActiveSec are monotonic: only list-timers gives their next wall-clock time.
    try:
        data = json.loads(subprocess.check_output(
            [*command, "list-timers", "--all", "--output=json", unit], **options,
        ))
        if not isinstance(data, list):
            raise ValueError("systemctl did not return a timer list")
        timer = next((entry for entry in data if isinstance(entry, dict) and entry.get("unit") == unit), {})
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return {**state, **unknown, "timer_last": last_time or "Unknown", "timer_error": error_text(exc)}

    def from_microseconds(key: str, missing: str) -> str:
        value = timer.get(key)
        return local_time(value // 1_000_000, now) if isinstance(value, int) and 0 < value < 2**64 - 1 else missing

    return {
        **state,
        "timer_next": from_microseconds("next", "Not scheduled"),
        "timer_last": last_time or from_microseconds("last", "Not recorded"),
    }


def event_details(entry: dict) -> str:
    errors = entry.get("errors") or (entry.get("observed") or {}).get("errors") or {}
    return "; ".join(f"{key}: {value}" for key, value in errors.items())


def read_logs(store: StateStore, source: str, limit: int) -> list[str]:
    if source in JOURNALS:
        output = subprocess.check_output(
            ["journalctl", "--user", "-u", JOURNALS[source], "-n", str(limit), "-o", "short-iso", "--no-pager"],
            text=True, timeout=5, stderr=subprocess.PIPE,
        )
        return list(reversed(output.splitlines()[-limit:]))
    state = store.load()
    if source == "worker":
        path = (state.get("active_worker") or {}).get("log_path")
        return list(reversed(tail(Path(path), limit))) if path else []
    if source == "last-run":
        logs = store.run_logs()
        return list(reversed(tail(logs[0], limit))) if logs else []
    if source == "notifications":
        sent = sorted(state.get("notifications_sent", {}).items(), key=lambda item: item[1], reverse=True)
        return [f"{local_time(ts)} — {key}" for key, ts in sent[:limit]]
    lines = tail(store.log_file if source == "decisions" else store.dry_run_file, limit)
    entries = []
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        parts = (local_time(entry.get("ts")), entry.get("node") or entry.get("command"),
                 entry.get("action"), entry.get("result"), event_details(entry))
        entries.append(" — ".join(str(part) for part in parts if part))
    return entries


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
            decisions.append({key: entry[key] for key in ("node", "command", "action", "result", "errors", "ts") if key in entry})
    observed = state.get("observed", {})
    recorded = store.last_run()
    last_run = recorded or state.get("last_run")
    dry_runs = tail(store.dry_run_file, 1)
    if dry_runs:
        try:
            latest = json.loads(dry_runs[0])
        except json.JSONDecodeError:
            latest = {}
        if recorded and recorded.get("dry_run") and recorded.get("result") not in {"paused", "failed"}:
            observed = latest.get("observed", observed)
        elif not recorded and latest.get("ts", 0) > (last_run or {}).get("at", 0):
            last_run = {"at": latest["ts"], "result": latest.get("result"), "dry_run": True}
            observed = latest.get("observed", observed)
    now = int(cfg.clock())
    token = token_details(cfg.token_file, now, cfg.allow_gh_login_fallback)
    if observed.get("token_error") == "token-invalid" and token["status"] == "ok":
        token["status"] = "invalid"
    return {
        "paused": state.get("paused", False), "last_run": last_run, **timer_times(now),
        "now": now,
        "token_status": token,
        "worker": worker, "last_worker_status": (state.get("last_worker") or {}).get("status"),
        "pr": state.get("worker_pr") or next(iter(observed.get("open_prs", [])), None),
        "test_gx": observed.get("test_gx"), "deploy": observed.get("deploy"), "health": observed.get("deploy_health"),
        "deploy_lookup": observed.get("deploy_lookup"),
        "errors": observed.get("errors", {}),
        "phase": state.get("phase", "idle"), "phases": PHASES,
        "budget": {"used": state.get("daily_counts", {}).get(_today(cfg.clock), 0), "cap": cfg.max_worker_runs_per_day},
        "plan": plan, "owner_note": state.get("owner_note", ""), "pinned_row": state.get("pinned_row"),
        "decisions": decisions, "worker_log": output, "notifications": state.get("notifications_sent", {}),
    }


DASHBOARD_STYLE = """
body{font:16px system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem}
form{display:inline-block;margin:.2rem} pre{white-space:pre-wrap;overflow-wrap:anywhere}
td,th{padding:.35rem;text-align:left} textarea{display:block;width:min(36rem,90vw)} strong{color:#17643a}
.pill{background:#eee;color:#222;border-radius:1rem;padding:.1rem .5rem}
.success{background:#d1f6dc} .failure,.error{background:#ffd9d9} .pending{background:#fff0ba}
#toast{display:inline-block;padding:.25rem} button[aria-pressed=true]{font-weight:bold}
"""

DASHBOARD_SCRIPT = """
const toast = document.querySelector('#toast');
const toggle = document.querySelector('#toggle');
const run = document.querySelector('#run-now');
const csrf = document.querySelector('input[name=csrf]').value;
const log = document.querySelector('#log-lines');
const filter = document.querySelector('#log-filter');
let source = '';
let logRequest = 0;
let awaitingRun = '';
let statusLoading = false;
let commandPending = false;

async function refreshStatus() {
  if (statusLoading) return;
  statusLoading = true;
  try {
    const response = await fetch('/');
    if (!response.ok) throw new Error('Status refresh failed');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const overview = page.querySelector('#overview');
    if (!overview) throw new Error('Status unavailable');
    document.querySelector('#overview').replaceWith(overview);
    const paused = overview.dataset.paused === 'true';
    toggle.textContent = paused ? 'Paused — Start' : 'Running — Pause';
    toggle.dataset.action = paused ? 'resume' : 'pause';
    if (awaitingRun && overview.dataset.runId !== awaitingRun) {
      toast.textContent = 'Run finished: ' + overview.dataset.result;
      awaitingRun = '';
      run.disabled = commandPending;
      if (source === 'last-run') refreshLogs();
    }
  } finally {
    statusLoading = false;
  }
}

for (const button of [toggle, run]) {
  button.addEventListener('click', async () => {
    const previous = document.querySelector('#overview').dataset.runId;
    commandPending = true;
    toggle.disabled = run.disabled = true;
    try {
      const response = await fetch('/api/' + button.dataset.action, {
        method: 'POST', headers: {'X-CSRF-Token': csrf, 'Content-Type': 'application/json'}, body: '{}'
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Request failed');
      toast.textContent = result.message;
      toggle.textContent = result.paused ? 'Paused — Start' : 'Running — Pause';
      toggle.dataset.action = result.paused ? 'resume' : 'pause';
      if (button === run) awaitingRun = previous || 'none';
      await refreshStatus();
    } catch (error) {
      toast.textContent = error.message;
    } finally {
      commandPending = false;
      toggle.disabled = false;
      run.disabled = Boolean(awaitingRun);
    }
  });
}

async function refreshLogs() {
  if (!source) return;
  const request = ++logRequest;
  const query = new URLSearchParams({source, lines: '500', q: filter.value});
  try {
    const response = await fetch('/api/logs?' + query);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Could not load logs');
    if (request === logRequest) log.textContent = result.lines.join('\\n') || 'No matching lines.';
  } catch (error) {
    if (request === logRequest) log.textContent = error.message;
  }
}

for (const tab of document.querySelectorAll('[data-log-source]')) {
  tab.addEventListener('click', () => {
    document.querySelector('[data-log-source][aria-pressed=true]')?.setAttribute('aria-pressed', 'false');
    tab.setAttribute('aria-pressed', 'true');
    source = tab.dataset.logSource;
    refreshLogs();
  });
}
filter.addEventListener('input', refreshLogs);
document.querySelector('form[action="/api/stop-worker"]').addEventListener('submit', event => {
  if (!confirm('Terminate the active worker and pause?')) event.preventDefault();
});
setInterval(refreshLogs, 15000);
let nextStatus = 0;
setInterval(() => {
  if (commandPending || (!awaitingRun && Date.now() < nextStatus)) return;
  nextStatus = Date.now() + 15000;
  refreshStatus().catch(() => {});
}, 2500);
"""


def local_time(ts: int | None, now: float | None = None) -> str:
    if ts is None:
        return "Not recorded"
    try:
        text = datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    except (OSError, OverflowError, ValueError):
        return "Invalid timestamp"
    if now is not None:
        minutes = int(abs(now - ts) // 60)
        text += f" (in {minutes} min)" if ts > now else f" ({minutes} min ago)"
    return text


def render(data: dict, csrf: str) -> str:
    def show(value, default="Not available") -> str:
        return escape(str(value if value is not None and value != "" else default))

    def table(headers, rows) -> str:
        heading = "".join(f"<th scope='col'>{column}</th>" for column in headers)
        body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
        return f"<table><thead><tr>{heading}</tr></thead><tbody>{body}</tbody></table>"

    def status(value, run=None) -> str:
        pill = f'<span class="pill {show(value, "unknown")}">{show(value, "Not available")}</span>'
        url = (run or {}).get("url", "")
        return f'<a href="{escape(url)}">{pill}</a>' if url.startswith("https://github.com/") else pill

    def form(action: str, label: str, value: str = "") -> str:
        return (
            f'<form method="post" action="/api/{action}">'
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
        rows.append((escape(key), escape(row["task"]), escape(reason), controls))
    phases = (*PHASES, data["phase"]) if data["phase"] not in PHASES else PHASES
    phase = " → ".join(f'<strong aria-current="step">{escape(step)}</strong>' if step == data["phase"]
                       else escape(step) for step in phases)
    pr = data["pr"] or {}
    url = pr.get("url", "")
    pr_name = f"#{pr['number']} {show(pr.get('title'), '')}" if pr.get("number") else "Open PR"
    link = f'<a href="{escape(url)}">{pr_name}</a>' if url.startswith("https://github.com/") else pr_name
    checks = [
        f"{show(check.get('name') or check.get('context'), 'Check')}: "
        f"{status(check.get('conclusion') or check.get('status') or check.get('state'))}"
        for check in pr.get("statusCheckRollup") or []
    ]
    pr_view = table(("PR", "Checks", "Review"), [(link, "<br>".join(checks) or "No checks", show(
        pr.get("reviewDecision"), "No review decision"))]) if pr else "No open PR"
    worker = data["worker"]
    worker_view = table(("Row", "Branch", "Model", "PID", "Started", "Last output"), [(
        show(worker.get("row_id")), show(worker.get("branch")), show(worker.get("model")),
        show(worker.get("pid")), show(local_time(worker.get("started_at"), data["now"])),
        show(f"{worker['last_output_age_seconds'] // 60} min ago" if worker.get("last_output_age_seconds") is not None else None),
    )]) if worker else "No active worker"
    errors = data["errors"]
    workflow_rows = []
    for label, key, run, value in (
        ("Test GX", "test-gx", data["test_gx"], (data["test_gx"] or {}).get("conclusion") or (data["test_gx"] or {}).get("status")),
        ("Deploy GX code", "deploy", data["deploy"], (data["deploy"] or {}).get("conclusion") or (data["deploy"] or {}).get("status")),
        ("Post-deploy health", "deploy-jobs", data["deploy"], data["health"]),
    ):
        error = errors.get(key)
        detail = error
        if key == "deploy" and not error:
            detail = {
                "deploy-all-skipped": "Every recent deployment was skipped.",
                "deploy-no-runs": "No deployment runs were found.",
            }.get(data["deploy_lookup"])
        workflow_rows.append((label, status("error" if error else value, run), show(detail, "—")))
    last = data["last_run"] or {}
    last_text = f"{show(local_time(last.get('at'), data['now']))} — {show(last.get('result'))}" if last else "No run recorded"
    if last.get("dry_run"):
        last_text += " (dry run)"
    token = data["token_status"]
    token_state = token["status"]
    if token_state == "ok" and (days := token.get("expires_in_days")) is not None:
        token_state = f"expires in {days} days" if days > 0 else "expires today" if days == 0 else "expired"
    rotated = token.get("token_rotated_at")
    next_row = plan["next"]
    reasons = sorted({row["reason"] for row in plan["skipped"]})
    next_text = (f"{show(next_row['row_id'])}: {show(next_row['task'])}" if next_row else
                 f"None eligible ({len(plan['skipped'])} skipped)" + (f" — {show(', '.join(reasons))}" if reasons else ""))
    decisions = table(("Time", "Node", "Action / result", "Details"), [
        (show(local_time(entry.get("ts"), data["now"])), show(entry.get("node") or entry.get("command")),
         show(" / ".join(str(entry[key]) for key in ("action", "result") if entry.get(key)), "—"),
         show(event_details(entry), "—")) for entry in data["decisions"]
    ]) if data["decisions"] else "No decisions recorded"
    notifications = table(("Time", "Notification"), [
        (show(local_time(ts, data["now"])), show(key))
        for key, ts in sorted(data["notifications"].items(), key=lambda item: item[1], reverse=True)
    ]) if data["notifications"] else "None sent"
    tabs = " ".join(f'<button type="button" aria-pressed="false" data-log-source="{key}">{label}</button>'
                    for key, label in LOG_SOURCES.items())
    stop = form("stop-worker", "Stop now", "yes")
    return f"""<!doctype html><html lang="en"><meta charset="utf-8">
<title>Victron dev loop</title><link rel="stylesheet" href="/dashboard.css"><h1>Victron dev loop</h1>
<button id="toggle" data-action="{"resume" if data["paused"] else "pause"}">{"Paused — Start" if data["paused"] else "Running — Pause"}</button>
<button id="run-now" data-action="run-now">Run now</button>{stop}<span id="toast" role="status"></span>
<section id="overview" data-paused="{str(data['paused']).lower()}" data-run-id="{show(last.get('id'), 'none')}"
 data-result="{show(last.get('result'), 'Unknown')}">
<p>{phase}</p><p>Budget: {data["budget"]["used"]}/{data["budget"]["cap"]}</p>
<p>Last run: {last_text} · Last timer: {show(data["timer_last"])} · Next timer: {show(data["timer_next"])}</p>
<p>Timer: {show(data.get("timer_state"))} {show(data.get("timer_error"), "")}</p>
<p>GitHub loop token: {show(token_state)} · Last rotation: {show(rotated, "Not recorded")}
{show(" — Could not read expiry metadata" if token.get("metadata_error") else "", "")}</p>
<h2>Worker and PR</h2>{worker_view}<div>{pr_view}</div><p>{show(errors.get("open-prs"), "")}</p>
<h2>Master Test GX, deploy and health</h2>{table(("Workflow", "Status", "Details"), workflow_rows)}
<h2>Next task</h2><p>{next_text} · Pinned: {show(data["pinned_row"], "None")}</p>
<p>{show(plan.get("error"), "")} Plan commit: {show(plan["commit"])} {form("refresh", "Refresh plan")}</p>
{table(("Row", "Task", "State", "Controls"), rows)}
<h2>Decisions</h2>{decisions}<h2>Notifications sent</h2>{notifications}
</section>
<form method="post" action="/api/note"><input type="hidden" name="csrf" value="{csrf}">
<label>Owner note<textarea name="value" maxlength="4000">{escape(data["owner_note"])}</textarea></label>
<button>Save note</button></form>
<h2>Logs</h2><div aria-label="Log sources">{tabs}</div>
<label>Filter lines <input id="log-filter" maxlength="200"></label><pre id="log-lines">Select a log source.</pre>
<script src="/dashboard.js"></script></html>"""


def make_server(cfg: LoopConfig, store: StateStore) -> ThreadingHTTPServer:
    host, _, port = cfg.web_bind.rpartition(":")
    ip = ipaddress.IPv4Address(host)
    names = {host}
    for name in cfg.web_hosts:
        if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                   for label in name.lower().split(".")):
            raise ValueError("web_hosts must contain bare DNS host names")
        names.add(name.lower())
    # RFC 6598 shared address space is neither private nor globally reachable.
    if not (ip.is_loopback or (not ip.is_private and not ip.is_global)):
        raise ValueError("web_bind must use a Tailscale IPv4 or loopback address")
    token = cfg.web_token_file.read_text(encoding="utf-8").strip() if cfg.web_token_file else ""
    if cfg.web_token_file and not re.fullmatch(r"[a-zA-Z0-9._~-]{16,}", token):
        raise ValueError("web_token_file must contain a URL-safe token of at least 16 characters")
    private = [token] if token else []
    try:
        private.append(read_token(cfg.token_file))
    except (OSError, UnicodeError):
        # The status endpoint reports an unreadable token without exposing its contents.
        pass
    csrf = secrets.token_urlsafe(32)

    def redact(value):
        if isinstance(value, dict):
            return {redact(key): redact(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [redact(item) for item in value]
        if isinstance(value, str):
            value = ANSI_RE.sub("", value)
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
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(content)

        def error(self, code, message):
            self.reply(code, json.dumps({"ok": False, "error": message, "message": message}).encode())

        def valid_host(self):
            headers = self.headers.get_all("Host", [])
            if len(headers) != 1 or headers[0].lower() not in {
                f"{name}:{self.server.server_port}" for name in names
            }:
                self.error(403, "Invalid Host")
                return False
            return True

        def authorized(self):
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
            if not self.valid_host():
                return
            if token and self.path == "/login":
                self.reply(200, (
                    '<!doctype html><meta charset="utf-8"><title>Victron loop sign-in</title>'
                    '<form method="post" action="/login">'
                    f'<input type="hidden" name="csrf" value="{csrf}">'
                    '<label>Access token <input type="password" name="value" required></label>'
                    '<button>Sign in</button></form>'
                ).encode(), "text/html; charset=utf-8")
                return
            if not self.authorized():
                return
            request = urlsplit(self.path)
            if request.path == "/dashboard.js":
                self.reply(200, DASHBOARD_SCRIPT.encode(), "application/javascript")
                return
            if request.path == "/dashboard.css":
                self.reply(200, DASHBOARD_STYLE.encode(), "text/css")
                return
            params = parse_qs(request.query)
            if request.path == "/api/logs":
                source = params.get("source", [""])[0]
                query = params.get("q", [""])[0]
                try:
                    limit = int(params.get("lines", ["500"])[0])
                    if source not in LOG_SOURCES or not 1 <= limit <= 500 or len(query) > 200:
                        raise ValueError
                except ValueError:
                    self.error(400, "Invalid source, line limit, or filter")
                    return
                try:
                    lines = redact(read_logs(store, source, 500 if query else limit))
                except (OSError, subprocess.SubprocessError):
                    self.error(503, "Could not read log source")
                    return
                matches = [line for line in lines if query.casefold() in line.casefold()]
                self.reply(200, json.dumps({"lines": matches[:limit]}).encode())
                return
            if request.path not in {"/", "/api/status"}:
                self.error(404, "Not found")
                return
            node = params.get("node", [""])[0]
            data = redact(snapshot(cfg, store, node))
            if request.path == "/api/status":
                self.reply(200, json.dumps(data).encode(), headers=(("X-CSRF-Token", csrf),))
            else:
                self.reply(200, render(data, csrf).encode(), "text/html; charset=utf-8")

        def do_POST(self):
            if not self.valid_host():
                return
            login = bool(token and self.path == "/login")
            if not login and not self.authorized():
                return
            action = urlsplit(self.path).path.removeprefix("/api/")
            if not login and (self.path != f"/api/{action}" or action not in ACTIONS):
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
            if login:
                if not hmac.compare_digest(value.encode(), token.encode()):
                    self.error(401, "Invalid access token")
                    return
                self.reply(303, headers=(
                    ("Location", "/"),
                    ("Set-Cookie", f"victron_loop={token}; Path=/; HttpOnly; SameSite=Strict"),
                ))
                return
            try:
                result = apply_control(store, cfg, action, value)
            except LockBusyError as exc:
                self.error(409, str(exc))
                return
            except ValueError as exc:
                self.error(400, str(exc))
                return
            except (OSError, RuntimeError, subprocess.SubprocessError):
                self.error(503, "Control action failed")
                return
            if is_json or action in {"pause", "resume", "run-now"}:
                self.reply(200, json.dumps(result).encode())
            else:
                self.reply(303, headers=(("Location", "/"),))

    return ThreadingHTTPServer((host, int(port)), Handler)


def serve(cfg: LoopConfig, store: StateStore) -> None:
    with make_server(cfg, store) as server:
        server.serve_forever()
