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

Set `web_bind` to the Omarchy box's Tailscale IPv4 plus `:8787`; the server
refuses wildcard and public addresses. Start `victron-loop-web.service` with
`systemctl --user start victron-loop-web.service` and visit
`http://<tailscale-ip>:8787/` from the tailnet. Use tailnet ACLs to restrict access.
For optional extra authentication, set `web_token_file` to a mode-0600 file
outside the install directory containing a random URL-safe token (at least 16
characters). Supply it via `Authorization: Bearer …` or the `victron_loop`
cookie; don't put it in a URL or an owner note.

**Pause** leaves the worker running but disables picks and retries; timer ticks
only observe repo status. **Stop now** confirms, sends SIGTERM to the tracked
worker group, records `stopped`, and pauses. It doesn't undo pushes or close
PRs. **Start** clears the pause flag; the timer still determines when the
next tick runs. The page shows the current phase, checks, budget and recent
logs. The next-task list is a deterministic preview, not a bypass for the
tick's PR, deployment-health, worker or budget gates.

Use **Approve** for a gated row, **Skip** / **Unskip** to override eligibility,
and **Pin as next** to prioritize an eligible row for one launch. The owner note
is used on the next launch. To change the plan, pause, edit `BACKLOG.md` through
the normal PR process, select **Refresh plan** after merge, then start again.
Over SSH, the equivalent CLI commands are `pause`, `resume`, `approve <row>`,
`skip <row>`, `unskip <row>`, `pin <row>`, and `note "<text>"`.

