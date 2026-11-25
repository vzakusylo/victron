# AUTO1 dev loop

`tools/dev-loop/` adds a lightweight autonomous runner for the Omarchy box:

1. Read GitHub state (open PRs, Test GX status, Deploy GX status + D-R14 post-deploy health).
2. Pick exactly one next eligible backlog item when the repository is idle.
3. Start one background Copilot worker in its own worktree.
4. Watch for merge + green checks + green deploy health, with one retry on failure.
5. Notify only blockers (noisy success paths are suppressed).

## Guardrails

- One worker and one PR at a time.
- Daily worker budget (`max_worker_runs_per_day`, default 3).
- Hard live-control rows need explicit `approve <row>` in state first.
- No local Docker/Test GX runs, no live GX writes, no secrets handling, no merges by loop.
- `--dry-run` disables worktree creation, Copilot execution, and notifications.

## Runtime layout

- Config: `~/victron-loop/config.toml`
- GitHub token file: `~/victron-loop/token` (if present, exported as `GH_TOKEN` for `gh`)
- Venv: `~/victron-loop/venv`
- State: `${XDG_STATE_HOME:-~/.local/state}/victron-loop/state.json`
- Decision log: `${XDG_STATE_HOME:-~/.local/state}/victron-loop/decisions.jsonl`
- Timer: `~/.config/systemd/user/victron-loop.timer`

## Control page (AUTO2)

Set `web_bind` to the Omarchy box's Tailscale IPv4 plus `:8790`; the server
refuses wildcard and public addresses. Start `victron-loop-web.service` with
`systemctl --user start victron-loop-web.service` and visit
`http://<tailscale-ip>:8787/` from the tailnet. Use tailnet ACLs to restrict access.
The Host header must match the bound IP or an exact name in `web_hosts`, with
the configured port. The default allows `http://omarchy:8790/`; add your actual
MagicDNS FQDN with `web_hosts = ["omarchy", "omarchy.example-tailnet.ts.net"]`.
Use `web_hosts = []` for IP-only access.

Dry runs preserve worker state but record GitHub observations for the dashboard.
Pending approval is shown as pending, and GitHub read errors appear in status
and the decision log (with a deduplicated blocker notification in live mode).

The dashboard's Start/Pause toggle reports the result immediately. **Run now**
queues the same systemd unit as the timer and refuses to start while a tick is
active; it does not resume a paused loop. The page shows the timer's last and
next activation. The Logs tabs filter the most recent 500 lines per source,
refresh every 15 seconds, and redact recognized secrets before display. The
loop keeps the last 50 run outputs under the state directory's `runs/` folder;
these local files can contain raw output and should not be shared.

**victron-langchain-dev-dashboard** deploys the loop and the page on the `omarchy`
runner after a master push that changes `tools/dev-loop` or the workflow.
Manual dispatch defaults to `dry_run_only: true`: it tests the checked-out
code against an existing installation without refreshing or restarting services.
Turn it off to install or deploy. Dry runs use temporary config and state and
upload their output as an artifact.

On the first install, the workflow enables and starts the timer and page.
Later deploys leave the timer alone and restart the page only if enabled.
The deployment probes the enabled page's `/api/status` on its configured bind
(default `127.0.0.1:8790`) and summarizes `paused`, `phase`, and the last result.
The probe does not use credentials; enabling optional web token authentication
makes it fail closed.

For optional extra authentication, set `web_token_file` to a mode-0600 file
outside the install directory containing a random URL-safe token (at least 16
characters). In the browser, open `/login` to enter the token and set the
session cookie. API clients can use `Authorization: Bearer …`. Don't put the
token in a URL or an owner note. Without a token, anyone allowed to reach the
port by your tailnet ACLs can read and operate the controls.

**Pause** leaves the worker running but disables picks and retries; timer ticks
only observe repo status. **Stop now** confirms, sends SIGTERM to the tracked
worker group, records `stopped`, and pauses. It doesn't undo pushes or close
PRs. **Start** clears the pause flag; the timer still determines when the
next tick runs. The page shows the current phase, checks, budget and recent
logs. The next-task list is a deterministic preview, not a bypass for the
tick's PR, deployment-health, worker or budget gates.

Hard rows and other owner-gated rows require **Approve** before they become
eligible. Use **Skip** / **Unskip** to override the manual skip,
and **Pin as next** to prioritize an eligible row for one launch. The owner note
is used on the next launch. Dry-run ticks never launch a worker, so they leave
the pin and note pending. To change the plan, pause, edit `BACKLOG.md` through
the normal PR process, select **Refresh plan** after merge, then start again.
Over SSH, the equivalent CLI commands are `pause`, `resume`, `approve <row>`,
`skip <row>`, `unskip <row>`, `pin <row>`, and `note "<text>"`.


## Owner setup on Omarchy

Run once from the PC (interactive; the token is asked for hidden and saved to `~/victron-loop/token`, mode 600):

```bash
scp tools/dev-loop/setup-omarchy.sh omarchy:setup-omarchy.sh
ssh -t omarchy 'bash ~/setup-omarchy.sh'
```
It checks the self-hosted runner (Omarchy needs a runner registered to this repo, `actions-runner-victron.service`), the fine-grained token, the Copilot CLI login and the loop install/timer. Re-run with `ssh -t omarchy 'bash ~/setup-omarchy.sh --live'` to set `dry_run = false`. The control page runs on `web_bind` in `config.toml` (Omarchy: `<tailnet-ip>:8790`; 8787 is used by another app).

