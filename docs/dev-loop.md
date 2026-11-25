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

