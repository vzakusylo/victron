# Run AUTO1 on Windows

Use PowerShell 7, Git, GitHub CLI, and `uv` or the Windows `py -3.12` launcher.
For live workers, use a terminal tab inside the already-running Herdr server
with Copilot CLI available. The loop never starts or restarts Herdr.

From the repository, run:

```powershell
pwsh tools/dev-loop/run-windows.ps1 -Once
pwsh tools/dev-loop/run-windows.ps1
```

`-Once` runs one dry cycle without opening a listening socket. Without it,
open the dashboard at `http://127.0.0.1:8790`. The terminal reports each
result and the next cycle, every 10 minutes by default. **Run now** queues
an immediate cycle. `Ctrl+C` finishes the current cycle and stops the server
without closing any Herdr worker.

The launcher creates or updates the venv under `%USERPROFILE%\victron-loop`.
On first run it creates `config.toml` there with backend `herdr`, dry run on,
and checkout `C:\learn\victron`. Set `-RepoPath` or `-WebBind` on first run
to override those defaults; afterward edit that file directly. State and
cycle logs live in `%LOCALAPPDATA%\victron-loop\state`. A Tailscale bind
requires the machine's Tailscale IPv4 rather than a wildcard address. Use
`web_token_file` and tailnet ACLs for dashboard access and add allowed
MagicDNS names in `web_hosts` if needed.

## Set up the token

Follow the [fine-grained token scope](dev-loop-token.md), then install the
token through hidden input. Neither the token nor its backup belongs in the
checkout. Rotation validates repository, PR and Actions access, stores
expiry metadata, and limits the token and its `token.prev` backup to the
current Windows account.

```powershell
pwsh tools/dev-loop/rotate-token.ps1
pwsh tools/dev-loop/rotate-token.ps1 -Check
pwsh tools/dev-loop/rotate-token.ps1 -Rollback
```

With no scoped token, a dry cycle reports `token-missing` without falling
back to the machine's GitHub login. Rerun `-Once` after installing the token.

## Run live without competing with Omarchy

**Pause or disable the Omarchy loop and make sure its current worker has
finished before starting Windows live.** Resume Omarchy only after stopping
the Windows loop and checking that no Windows worker remains active.

For an additional guard, set different `instance_name` values and point
`peer_status_url` at the other dashboard's `/api/peer-status` endpoint. A
configured peer that reports live and unpaused blocks the cycle, as does a
failed or invalid peer response. The endpoint exposes only instance name,
live and paused status. Use it on the trusted tailnet. This check is not a
distributed lock: it does not replace the operator handoff. If Omarchy's
dashboard is offline, leave the peer check unset only after confirming the
timer is off and no worker is active.

```powershell
pwsh tools/dev-loop/run-windows.ps1 -Live
```

`-Live` overrides dry run for that process only. Keep the main checkout up to
date so `tools\herdr\herdr-task.ps1` supports the loop. The dashboard reads
the worker's Herdr pane and shows its last observed agent state. **Stop
worker** requests an interrupt and pauses the loop; it retains the pane.
Check the pane yourself if Herdr could not interrupt it. After its PR
merges, the loop closes its Herdr worktree; unrelated uncommitted changes
can block cleanup.
