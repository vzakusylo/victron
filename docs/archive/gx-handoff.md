# GX deployment handoff (14–15 Nov 2026)

> Historical record only. Use the [current GX deployment guide](../gx-deploy.md) for operations.

> Everything that was done to the Cerbo GX and to the deployment tooling on 14–15 Nov 2026, the scripts that came out of it, and how to repeat each operation with one command. Read this first; [Deploying to the Cerbo GX](../gx-deploy.md) explains the single scripts, [SECRETS.md](../../scripts/SECRETS.md) the secrets.

The [Victron GX connector](../victron-gx-connector.md) documents interfaces and signals.

For the later d#187 deployment, connection recovery, version/code mismatches,
reviewed topology migration, pinned dry-run/apply, backups and verification,
see the [GX deployment troubleshooting runbook](../gx-deploy-troubleshooting.md).
The state table below is the historical 01:30 handoff, not a live status report.

## Contents

- [State at the end](#state-at-the-end)
- [The four operations](#the-four-operations)
- [Operation A: deploy code](#operation-a-deploy-code)
- [Operation B: install the private files](#operation-b-install-the-private-files)
- [Operation C: look at the GX](#operation-c-look-at-the-gx)
- [Operation D: access secrets](#operation-d-access-secrets)
- [Every script, and why it exists](#every-script-and-why-it-exists)
- [What was done, in order](#what-was-done-in-order)
- [From the one-off scripts to the permanent ones](#from-the-one-off-scripts-to-the-permanent-ones)
- [Which test repeats which step](#which-test-repeats-which-step)
- [Not verified on the real device](#not-verified-on-the-real-device)
- [Rules learned](#rules-learned)
- [Open items](#open-items)

## State at the end

| What | State on 15 Nov 2026 01:30 |
|---|---|
| Live flow | `d#181 Day / Night Grid Control [git 97bd93be46f1]`; its code equals `master` (`scripts/gx-monitor.ps1 -Drift` → `OK drift`) |
| Tool scripts on the GX | `/data/home/nodered/tools/` equal to `master`; the deploy / check scripts are also in `tools/gx/` there |
| Private files on the GX | Installed once through the workflow (run 43657863888), identical to what the GX had before |
| GitHub secrets | 14 `SECRETFILE_*` (synced from the GX 15 Nov 01:12), 5 access secrets, all proven by that install |
| GitHub environment | `victron-gx`: required reviewer, branch `master` only |
| Backup | `grid-backup-20261115-011623.tar.gz` on the GX, the first one that contains the `tools` folder |
| CI key | PC: `~\.ssh\victron_ci_ed25519`; GX: line `victron-ci-github-actions` in `/root/.ssh/authorized_keys` |
| Automations | DHW and heating controller On, running; no fault |

Take host names and key file names from the private notes; this repository holds only placeholders.

## The four operations

Each one is a single command with a fixed order of steps. A step that fails stops the run and says why. Nothing here deploys by itself on a push.

| | Operation | Command | Changes the GX? |
|---|---|---|---|
| A | Deploy code (flow + tool scripts) | `scripts\gx-deploy.ps1` | only with `-Apply` |
| B | Install the private files | `scripts\gx-secrets-install.ps1` | yes (Node-RED down ~2 min); `-DryRun` does not |
| C | Look at the GX | `scripts\gx-monitor.ps1` | no |
| D | Create or rotate the access secrets | `scripts\setup-ci-access.ps1` | adds / removes one SSH key line |

All commands below assume PowerShell 7 in the repository root and:

```powershell
$gx  = 'root@<gx-tailscale-host>'
$key = "$HOME\.ssh\<gx-key-file>"
```

## Operation A: deploy code

```powershell
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key            # dry run, changes nothing
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key -Apply     # deploy
```

Before: merge the change into `master` (`node tools/flows.js sync`, `check`, tests, pull request). The runner deploys `origin/master` unless `-Commit <sha>` names another pushed commit.

The steps (`-Steps` prints them):

```text
1 preflight   fetch, resolve the commit, check that it is pushed, extract the scripts of the commit
2 snapshot    read the live flow from the GX (read-only)
3 compare     check live drift against the recorded commit and report Git changes
4 plan        pin base, target, tool files, hashes and expected live revision
5 window      no DHW cycle, no running rule sequence, no defrost (read-only)
6 dry run     all checks of tools/gx/deploy.js on the GX, nothing changed
7 deploy      only with -Apply: backup, tool files, POST, read back
8 verify      informational health report (label, log and automations); deploy.js already verified the flow
```

Why it gives the same result every time:

- **One input.** Everything is derived from one commit SHA: the scripts that run on the PC and on the GX are extracted from that commit (`git show <sha>:…`), not taken from the work tree, and the GX downloads `flows.json` and the tool files by that SHA and checks their SHA-256 from the plan.
- **One moment.** The plan carries the live revision of the snapshot. If anybody deploys in between, step 6 or 7 refuses and you start again.
- **Fixed gates.** The live flow must match its recorded baseline unless `-OverwriteDrift` has been explicitly approved. Additions and removals are reported from Git and do not require opt-ins. A DHW cycle, a running rule sequence or a defrost stops `-Apply` (`-WaitWindowMin 30` waits for a free moment).
- **Idempotent.** When the GX already runs the commit and all tool files are equal, the run ends with `NOTHING TO DO` and exit code 0.
- **A record.** Every run writes its snapshot, comparison, plan, dry-run and deploy output to a run folder under the temp directory (printed first and last).

Exit code: 0 done or nothing to do, 1 stopped by a check before any change, 2 failed after the deploy started (read `deploy.txt` in the run folder; it names the backup).

After `-Apply`: run operation C again 15–20 minutes later, and add a row to the [work log](../heat-pump-work-log.md). What restarts and how to roll back: [gx-deploy.md](../gx-deploy.md#what-the-deploy-script-checks).

An explicitly owner-requested deployment without commit/push uses
`tools/gx/deploy-local.js`, not the normal commit runner. Prepare against a fresh
snapshot, transfer the hash-checked plan, dry-run, apply only in a safe window
and verify. The UI records a `local:<SHA-256>` source while preserving the
unchanged automation commit. Record the backup directory in the work log.
For rollback, restore both the live flow and replaced files from that backup,
retaining the original credentials and revision safeguards.

## Operation B: install the private files

Needed only when a private file must come from GitHub: a restored or new GX, or to prove the chain after a change of the workflow, the installer or an access secret. In daily use the files are edited on the GX and copied to GitHub (`sync-secrets.ps1 -FromGx`), not the other way.

This is separate from a dashboard deployment; do not invoke it just to change a page.

```powershell
pwsh -NoProfile -File .\scripts\gx-secrets-install.ps1 -GxHost $gx -SshKey $key -DryRun
pwsh -NoProfile -File .\scripts\gx-secrets-install.ps1 -GxHost $gx -SshKey $key -WaitWindowMin 45
```

Before: create a backup on the dashboard (**Backup → Create backup now**); the runner refuses when the newest one is older than 24 h. Stay at GitHub: you approve two workflow runs.

```text
1 preflight   gh login, all secret names present, SSH to the GX, Node-RED up, a recent dashboard backup exists
2 sync        copy the 11 private files from the GX to the GitHub secrets (skipped with -SkipSync)
3 check       run the workflow in check mode; YOU approve it; it must succeed
4 window      no DHW cycle, no rule sequence, no defrost due (tools/gx/window.js --for stop)
5 dispatch    start the workflow in install mode, then stop Node-RED and confirm it is down
6 approve     YOU approve the run; wait for it; on timeout or failure start Node-RED again
7 compare     installed files vs the copies the installer kept; local check of the secret mappings
8 start       start Node-RED, wait until the automations tick, print the monitor
```

- **Approval** is a click in GitHub (Actions → the run → *Review deployments* → `victron-gx` → *Approve and deploy*). The runner prints the link. Writing "approved" anywhere else does nothing.
- **Step 2 matters.** An install writes what GitHub has. If a file on the GX changed after the last sync, an install without step 2 puts the older file back.
- **Step 4** asks for more than operation A: while Node-RED is down the *DF exchange* rules do not switch the bypass, so no defrost may be due in the next 8 minutes.
- **Node-RED is started again in every case** in which the runner stopped it: success, a failed or cancelled run, no approval within `-ApprovalTimeoutMin` (default 10), an error in the script. The installer on the GX restores the previous files itself when a copy or its check fails.
- **Step 7** prints `same` / `CHANGED` per file. After a sync all are `same`; `CHANGED` is expected only when a secret was edited in GitHub on purpose.

Exit code: 0 installed and healthy, 1 stopped by a check before anything changed, 2 failed after Node-RED was stopped (it is running again unless the last lines say otherwise).

## Operation C: look at the GX

```powershell
pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key            # health now
git fetch; pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key -Drift   # + live code vs origin/master
```

`STATUS: OK / WARN / FAIL`, exit code 0 / 1 / 2. Levels and limits: [gx-deploy.md](../gx-deploy.md#monitoring). Is this a good moment to deploy or to stop Node-RED:

```powershell
Get-Content -Raw tools\gx\window.js,tools\gx\admin-api.js | ssh -i $key $gx "tr -d '\r' | node - --for stop"
```

## Operation D: access secrets

```powershell
pwsh -NoProfile -File .\scripts\setup-ci-access.ps1 -GxHost $gx -SshKey $key -DryRun
pwsh -NoProfile -File .\scripts\setup-ci-access.ps1 -GxHost $gx -SshKey $key                          # first time
pwsh -NoProfile -File .\scripts\setup-ci-access.ps1 -GxHost $gx -SshKey $key -Rotate -SkipTailscale   # new CI key
```

The two Tailscale values come from the admin console (Settings → Trust credentials → OAuth client, scope *Auth Keys* write, tag `tag:ci`); the tailnet policy needs `"tagOwners": { "tag:ci": ["autogroup:admin"] }`. Details, checks and the maintenance table: [SECRETS.md](../../scripts/SECRETS.md#access-secrets-add-check-maintain). A rotated key or a new Tailscale client is proven only by operation B.

## Every script, and why it exists

**Runners (PC, PowerShell 7)** — what you start.

| Script | What it does | Why |
|---|---|---|
| [`scripts/gx-deploy.ps1`](../../scripts/gx-deploy.ps1) | Operation A: the eight deploy steps in a fixed order, dry run by default | The steps were done by hand on 14–15 Nov; a skipped step (compare, window, read-back) is how a deploy goes wrong |
| [`scripts/gx-secrets-install.ps1`](../../scripts/gx-secrets-install.ps1) | Operation B: sync, check, window, stop, install, compare, start | The order matters (sync before install, dispatch before stop) and Node-RED must come back in every case |
| [`scripts/gx-monitor.ps1`](../../scripts/gx-monitor.ps1) | Operation C: runs the monitor over SSH, `-Drift`, `-Watch`, `-Json` | One command instead of piping scripts by hand |
| [`scripts/setup-ci-access.ps1`](../../scripts/setup-ci-access.ps1) | Operation D: CI key, its line on the GX, five `gh secret set` without printing a value | Credentials are created by the owner, and never typed into a chat or a file |
| [`scripts/sync-secrets.ps1`](../../scripts/sync-secrets.ps1) | GX → GitHub: collects the 11 private files and uploads them | GitHub must hold what the GX runs before an install |

**Scripts that run on the GX** — started by the runners; read-only admin scripts can also be piped by hand with their shared helper (`Get-Content -Raw <file>,tools\gx\admin-api.js | ssh … "tr -d '\r' | node -"`). Since d#181 they are also installed in `/data/home/nodered/tools/gx/`.

| Script | What it does | Why |
|---|---|---|
| [`tools/gx/live-snapshot.js`](../../tools/gx/live-snapshot.js) | Reads the live flow from the admin API; prints the code of every node, a hash of its other properties, the label and the revision (gzip + base64, ~300 KB) | The repository file is a template; only the GX knows what really runs. Hashes instead of settings: no Tuya IDs or keys leave the GX |
| [`tools/gx/window.js`](../../tools/gx/window.js) | Says `SAFE` or `WAIT` with reasons: DHW cycle, rule sequence, queued writes, defrost flag, defrost now, valve, bypass, fault; with `--for stop` also "next defrost due" | A redeployed automations node loses its context; a stopped Node-RED does not switch the bypass in a defrost |
| [`tools/gx/deploy.js`](../../tools/gx/deploy.js) | Executes a plan: download by SHA, hash check, revision check, DHW check, patch of the planned code fields, source label, backup, tool files, POST, read-back; dry run unless `DRY=0` | The only script that changes the flow; it refuses instead of guessing |
| [`tools/gx/verify.js`](../../tools/gx/verify.js) | After a deploy: label, recorded commits, DHW state and wait reason, master switch, log errors since the deploy | A quick look right after step 7 |
| [`tools/gx/monitor.js`](../../tools/gx/monitor.js) | Health at any time, judged OK / WARN / FAIL | The same checks every time, with an exit code |
| [`scripts/install-gx-secrets.sh`](../../scripts/install-gx-secrets.sh) | Run by the workflow: refuses a running Node-RED, keeps the previous files, installs 7 files and 2 helpers, checks, rolls back | Private files are written only with Node-RED stopped, and never through a symlink |
| [`tools/victron-secrets.js`](../../tools/victron-secrets.js), [`tools/reload-victron-secrets.js`](../../tools/reload-victron-secrets.js) | Loaded by `settings-user.js` at start: turns the private files into the environment the Tuya nodes reference; `check` validates them | The flow holds references, not keys |

**Scripts that run on the PC inside a runner.**

| Script | What it does | Why |
|---|---|---|
| [`tools/gx/compare.js`](../../tools/gx/compare.js) | Snapshot vs a commit: `code`, `trailing`, `config`, added / removed nodes; `--show`, `--history`, `--summary`, `--plan` | Separates what a deploy changes from editor noise and from the secret references |
| [`tools/deploy-version.js`](../../tools/deploy-version.js) | Adds ` [git <sha12>]` to the tab and the dashboard pages and stores the full SHA in the tab `info` | The dashboard shows which commit runs |
| [`tools/flows.js`](../../tools/flows.js) | `sync` numbered sources → `flows.json` (+1 on `d#`), `check` | The numbered files are the source |

**GitHub.**

| File | What it does |
|---|---|
| [`.github/workflows/check.yml`](../../.github/workflows/check.yml) | On every pull request and push to `master`: `flows.js check`, all Node tests (Linux), the PowerShell tests (Windows) |
| [`.github/workflows/deploy-victron.yml`](../../.github/workflows/deploy-victron.yml) | Manual only: `check` rebuilds and validates the private files; `install` also joins the tailnet and runs the installer on the GX. Waits for the reviewer of `victron-gx` |

## What was done, in order

Times are local (CET). "Read-only" means nothing on the GX changed.

| # | When | What | With | Result |
|---|---|---|---|---|
| 1 | 14 Nov 18:40 | Fetched `master`, read the new workflow and `deploy-version.js` | git | Deployment of flows was manual; the workflow covered private files only |
| 2 | 18:45 | Found the GX (LAN address dead from the PC, Tailscale works), listed its files | ssh, read-only | Live `flows.json` written 14:21, hours before PR #29 |
| 3 | 18:47 | Hashed every live node and every repository node | one-off `fingerprint.js`, `compare.js` | 25 nodes differed |
| 4 | 18:50 | Pulled the code of those nodes and compared with each commit | one-off `pull.js`, `diff.js`, `detail.js` | 14 trailing-newline noise, 7 behind `master`, 4 Tuya secret references, 1 with **four lines found in no commit** (`pir_state` in the Devices model) |
| 5 | 18:50 | Compared the tool files by SHA-256 without CR | ssh, git | Two behind (`tuya-cloud-sensors.js`, `tuya-local-sensors.js`); all had CRLF from a Windows copy |
| 6 | 18:52 | Checked GitHub | gh | 14 file secrets present; no access secret, no environment, workflow never run |
| 7 | 18:55 | Copied the four GX-only lines into `50 Devices model.js`, `sync` → d#180 | one-off `port.js`, `flows.js` | PR #31 |
| 8 | 18:54 | Replaced the two tool files, downloaded by the GX from the commit | one-off `tools-update.sh` | First try stopped: **no `install` on Venus OS**; done with `cp` / `chown` |
| 9 | 18:56 | Dry run, then deploy of 7 nodes with the source label | one-off `deploy-d180.js` | d#180 `[git 97c023b52bca]`, backup `backup-20261114T1756-pre-d180` |
| 10 | 18:57 | Checked log, settings, devices | one-off `verify.js` | No errors; DHW waiting for an outdoor average (normal after a redeploy) |
| 11 | 18:58 | Created environment `victron-gx`; started the workflow in `check` mode | gh | Run waited for approval |
| 12 | 19:05–19:25 | Fixed the installer (`install` → rename into place), three review rounds on symlinks | PR #31 | Tests for a symlinked file and directory |
| 13 | 19:10 | Wrote `tools/gx/` from the one-off scripts, tested read-only and by dry run | — | `live-snapshot`, `compare`, `deploy`, `verify` |
| 14 | 19:53 | First DHW cycle after the deploy ended with **Er03** after 3 min | automation log | Same start sequence as the two earlier cycles of the day; cause not established; the owner allowed DHW again at 20:05 |
| 15 | 20:06–20:40 | Tests for the DHW and heating controllers, access setup script, secrets documentation, `tools` in the backup (d#181), monitor | PR #31 | Merged |
| 16 | 20:19 | Created the CI key, authorized it on the GX, uploaded three SSH secrets | `setup-ci-access.ps1 -SkipTailscale` | CI key logs in |
| 17 | 20:30 | Owner added `tag:ci` to the tailnet policy, created the OAuth client, entered the two values | `setup-ci-access.ps1` | Five access secrets present |
| 18 | 21:00 | Owner approved the `check` run: it failed | workflow | `chmod 700 (Split-Path $dir), $dir` passed its arguments literally on Linux |
| 19 | 22:08 | Fix merged (97bd93b), `check` run again | workflow | Success: 11 files rebuilt |
| 20 | 15 Nov 01:08 | Snapshot, compare, plan, dry run, deploy of d#181 and the four `tools/gx` scripts | `tools/gx/*` by hand | d#181 `[git 97bd93be46f1]`, backup `backup-20261115T000906-pre-d181`; `OK drift` |
| 21 | 01:12 | Synced the 11 private files from the GX to GitHub; `check` approved and passed | `sync-secrets.ps1 -FromGx`, workflow | GitHub copies equal the GX |
| 22 | 01:16 | Owner created a dashboard backup; checked its content | ssh, read-only | 22 entries under `tools/`, manifest lists the folder |
| 23 | 01:21 | Read defrost / DHW / sequence state | one-off `window.js`, `clear.js` | Idle, but a defrost was due |
| 24 | 01:22 | Dispatched `install`, stopped Node-RED, owner approved | gh, ssh | Run 43657863888 succeeded in 80 s |
| 25 | 01:24 | Compared the installed files with the kept copies, ran the local check, started Node-RED | ssh | 9 of 9 identical; Node-RED down 1 min 47 s; devices connected, automations ticking |
| 26 | 01:30 | Turned steps 20–25 into the two runners and `tools/gx/window.js`, with tests | this change | Operations A and B |

## From the one-off scripts to the permanent ones

Nothing of the temporary work is needed any more; each piece lives in a tracked script.

| One-off script (session scratchpad) | What it did | Now |
|---|---|---|
| `fingerprint.js` | Hash of every node on the GX / in the repository | `tools/gx/live-snapshot.js` (`snapshot()`) |
| `compare.js`, `diff.js`, `detail.js`, `pull.js` | Which nodes differ, which lines, which commit the GX code equals | `tools/gx/compare.js` (report, `--show`, `--history`) |
| `port.js` | Copied the GX-only lines of one node into its numbered source | Manual: `compare.js --show <id>`, edit the source, `flows.js sync` |
| `tools-update.sh` | Download by SHA, hash check, `node --check`, backup, replace two tool files | The `tools` part of a plan in `tools/gx/deploy.js` |
| `deploy-d180.js` | The d#180 deploy with its node list written into the script | `tools/gx/deploy.js` + a plan from `compare.js --plan` |
| `verify.js` | Label, DHW state, log errors | `tools/gx/verify.js`, `tools/gx/monitor.js` |
| `window.js`, `clear.js` | Is anything running; wait until the defrost is over | `tools/gx/window.js`; the waiting loop is `-WaitWindowMin` of the runners |
| `heatdbg.js` | Trace of the heating controller tick by tick | `tests/heat-automation.test.js` (the kick case) |
| Loops that waited for a workflow run | Poll `gh run view` until completed | `Wait-Run` in `scripts/gx-secrets-install.ps1` |
| The hand-typed order "snapshot, compare, plan, dry run, deploy, verify, drift" | — | `scripts/gx-deploy.ps1` |
| The hand-typed order "sync, check, window, dispatch, stop, wait, compare, start, monitor" | — | `scripts/gx-secrets-install.ps1` |

## Which test repeats which step

`node --test "tests/*.test.js"` runs all of them; the PowerShell tests run in the Windows job of `check.yml`.

| Step | Test | What it proves |
|---|---|---|
| A2–A8 as a whole | `tests/gx-deploy-e2e.test.js` | The real scripts as child processes against a fake admin API, a fake file server and a temp folder as the GX: snapshot → compare → plan → window → dry run (nothing changed) → refused while DHW runs → refused when the DHW state is unreadable → POST fails and the tool files come back → deploy → only the planned nodes and the labels changed, the Tuya reference and a trailing-newline node untouched, backup complete → verify → monitor OK → second comparison finds no code difference → the old plan is refused → a tampered plan is refused |
| A3 | `tests/gx-compare.test.js` | Code / trailing / config / added nodes are told apart; labels, key order and positions are not differences; no settings or credentials in a snapshot |
| A5, B4 | `tests/gx-window-runners.test.js` | The moment of 15 Nov 01:22 (safe to deploy, not to stop), right after a defrost, an overdue estimate, and every blocking state with its reason |
| A, B order | `tests/gx-window-runners.test.js` | The step lists of both runners are fixed and this document quotes them; the commands that change the GX sit behind `-Apply` / after the `-DryRun` exit; Node-RED is started in the `finally` block; a bad host is refused before any connection |
| A8, C | `tests/gx-monitor.test.js` | The judgement on a healthy GX, right after a deploy, the Er03 block, stale or silent devices, a stuck cycle, controllers off; log times from the TAI64N stamp |
| B5–B7 on the GX | `tests/install-gx-secrets.test.js` | The installer refuses a running service, installs, keeps recovery files, rejects foreign archives and symlinks, replaces a symlinked file or directory instead of writing through it, rolls back |
| B3 | `tests/secret-files.test.ps1`, `tests/deploy-secrets.test.ps1` | Secrets rebuild into the exact files (chunks, checksums, empty token, corrupt input) and the bundle holds the 7 active files |
| B3 | `tests/workflow-pwsh.test.js` | No workflow step passes `(expression),` to a native program (the `chmod` failure of step 18) |
| D | `tests/setup-ci-access.test.ps1` | Parsing, dry run without side effects, host validation, refusal of a second rotation |
| After a deploy | `tests/dhw-automation.test.js` | A redeployed node waits for an outdoor average, takes no sample around a defrost, then starts with the logged sequence; Er03 ends and blocks the cycle until allowed again |
| After a deploy | `tests/heat-automation.test.js` | The heating controller with the settings of the GX: no write on the curve, a full window before the first step, the kick, the hold around DHW, the owner's curve back after an abort |
| Backup | `tests/backup-tools.test.js` | The `tools` folder is in the backup and restore paths; every tool the flow runs is tracked |

## Not verified on the real device

Covered by tests only, never executed on the GX:

- `scripts/gx-deploy.ps1 -Apply` and `scripts/gx-secrets-install.ps1` without `-DryRun`. Their steps were done by hand in the same order (rows 20–25), and both were run in dry-run mode against the GX.
- The rollback of the installer, and the return of tool files after a failed POST.
- `setup-ci-access.ps1 -Rotate`.
- A restore from a backup.
- The refusal of the environment to run from another branch than `master`.

## Rules learned

| Rule | Because |
|---|---|
| Compare the code, not the `d#` | On 14 Nov the GX and `master` both said `d#179` with different code |
| Deploy from a pushed commit by default; use the local exception only on explicit owner request | The GX had lines deployed from an uncommitted work tree; they were in no branch |
| Never copy the raw repository flow over the live file | The deploy runner adds the deterministic Tuya file-secret references before posting |
| Sync the secrets from the GX before an install | GitHub had a copy 18 minutes older than the file on the GX |
| An approval is a click in GitHub | The run stays `waiting` otherwise, and Node-RED may already be stopped |
| No `install`, no `head -c`, no time zone in an SSH shell on Venus OS | BusyBox; use `cp` / `chown` / `chmod`, and the TAI64N stamp for log times |
| As root, never write over a path the `nodered` user owns; write next to it and rename | `cp` and `mv` follow a symlink; the folders belong to `nodered` |
| In a workflow, never `(expression),` after a native command | PowerShell passes it as text; the Windows test stubbed `chmod` and hid it |
| A script piped to `node -` has no main module | `if (!require.main \|\| require.main === module)` |
| Let the GX download; push only small files | Hundreds of KB from the PC stall |
| Not during a DHW cycle; not before a defrost when Node-RED goes down | The automations lose their context; the bypass rules do not run |
| After a restart `no outdoor value yet` is normal | No samples in a defrost and 15 min after it |

## Open items

- **Er03 on 14 Nov 19:56**, first DHW cycle after the d#180 deploy: cause not established. The next cycles ran. Watch the automation log (`WARN automation log` in the monitor).
- **Kick setting** `kickMin 1` / `kickSec 60`: a supply stuck below the curve is switched Silent → Smart → Silent every ~2.3 min for as long as it lasts (`tests/heat-automation.test.js`). The owner's choice; not seen in the log yet.
- **Heating band (P6)** `band` (off by default), `bandDown` 0 (0–4 °C), `bandUp` 2 (2–8 °C), with `up − down ≥ 2`: while the heating controller is On, the pump curve is written at point + up and DP 121 (heating hysteresis, 2–18 °C) at up − down. The owner's DP 121 is kept in `heatBandSaved` (settings file) and written back when the band is off or the controller is Off / Test. First live write of DP 121: after the deploy, turn the band on once and check that the pump reports the new value (`tests/heat-band.test.js`).
- **Tailnet policy** allows every device to reach every device, so a `tag:ci` runner sees the whole tailnet during an install. A rule for `tag:ci` → GX `tcp:22` only would narrow it.
- **GitHub Actions runner changes:** checkout and setup actions now use Node.js 24 (`@v7`); the project tests still use Node.js 22. Run `check` after future action or `ubuntu-latest` image changes.
- **13 nodes** differ from the repository by a trailing newline only. Harmless; `--include-trailing` in a plan would align them at the cost of a restart.
- **Local copies of the private files** from the sync of 15 Nov are in the git-ignored `.secrets\` folder of the work tree used that night; delete them when they are no longer wanted.
- **SA1 power meter** still not reachable from the GX (other network); the monitor lists its errors as known.
