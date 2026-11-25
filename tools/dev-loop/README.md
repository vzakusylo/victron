# Victron dev loop (AUTO1)

Small Python + LangGraph loop for autonomous backlog execution on the Omarchy box.

- Polls repo/deploy state every timer run.
- Picks one eligible `BACKLOG.md` task when safe.
- Starts one headless Copilot worker in a dedicated worktree.
- Watches merge + Test GX + deploy health, and only notifies on blockers.

Design doc: [`../../docs/dev-loop.md`](../../docs/dev-loop.md)

Windows setup: [foreground loop with Herdr workers](../../docs/dev-loop-windows.md).

## Install (Omarchy user)

```bash
cd tools/dev-loop
./install.sh
cp config.example.toml ~/victron-loop/config.toml
```

Then edit `~/victron-loop/config.toml` and keep `dry_run = true` until ready.
By default, GitHub auth is read from `~/victron-loop/token` (fine-grained token content); if the file exists it is
used as `GH_TOKEN`.
The loop reads `BACKLOG.md` and `tools/herdr/models.json` from `~/victron-loop/repo` (origin/master clone).

## Control page (AUTO2)

Set `web_bind` to your Omarchy Tailscale IPv4 and port, then run
`systemctl --user start victron-loop-web.service`. Open `http://<tailscale-ip>:8787/`
from your tailnet. The installer enables the service only on a fresh install; on
an existing install, use `systemctl --user enable --now victron-loop-web.service`
if you want it to start at login. See [the control page guide](../../docs/dev-loop.md#control-page-auto2).

## CLI

```bash
~/victron-loop/venv/bin/python -m victron_loop.main --config ~/victron-loop/config.toml run-once --dry-run
~/victron-loop/venv/bin/python -m victron_loop.main --config ~/victron-loop/config.toml status
~/victron-loop/venv/bin/python -m victron_loop.main --config ~/victron-loop/config.toml approve G4
```

With the same prefix, use `pause`, `resume`, `skip <row>`, `unskip <row>`,
`pin <row>`, or `note "<text>"`.

