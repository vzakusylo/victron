# Deploying to the Cerbo GX: scripts and step-by-step guide

> How to find out what the GX really runs, deploy only the difference from a pushed commit, and check the result. Written after the d#180 deploy of 14 Nov 2026; the scripts in `tools/gx/` are the reusable form of what was done by hand that day.

**Start with [GX deployment handoff](gx-handoff.md)**: it has the one-command runners (`scripts/gx-deploy.ps1`, `scripts/gx-secrets-install.ps1`) that do the steps below in a fixed order. This page explains the single scripts they call.

Related: [Development & deployment](development.md) (rules, versioning) · [Secrets](../scripts/SECRETS.md) (private files, GitHub workflow) · [Backup & restore](backup-restore.md) · [Work log](heat-pump-work-log.md)

For connection failures, differing versions/GX-only lines, output migrations and the complete pinned dry-run/apply/backup procedure, use the [GX deployment troubleshooting runbook](gx-deploy-troubleshooting.md).

## Contents

- [The three things that get deployed](#the-three-things-that-get-deployed)
- [Which script is for what](#which-script-is-for-what)
- [Finding the GX and restoring Tailscale on Windows](#finding-the-gx-and-restoring-tailscale-on-windows)
- [Step by step](#step-by-step)
- [Monitoring](#monitoring)
- [Reading the comparison report](#reading-the-comparison-report)
- [Deploy mail](#deploy-mail)
- [What the deploy script checks](#what-the-deploy-script-checks)
- [Rollback](#rollback)
- [Traps met on 14 Nov](#traps-met-on-14-nov)
- [What was done on 14 Nov 2026](#what-was-done-on-14-nov-2026)

## The three things that get deployed

| What | Where on the GX | How it gets there |
|---|---|---|
| Flow code (function nodes, dashboard templates, exec commands) | Node-RED, `/data/home/nodered/.node-red/flows.json` | `tools/gx/deploy.js`: patch of the changed nodes through the admin API |
| Tool scripts run by exec nodes (`tools/tuya-*.js` and others) | `/data/home/nodered/tools/` | `tools/gx/deploy.js` (the `tools` part of the plan) |
| Private files (Tuya keys, mail, MCP token, `settings-user.js`) | `grid-control-config/`, `.node-red/` | GitHub workflow *Deploy Victron secrets*, see [SECRETS.md](../scripts/SECRETS.md). Not covered here |

The repository `flows.json` is a portable template: its Tuya nodes have no keys and no file-secret references. **Never replace the live flow with it.** A deploy copies single code fields into the live nodes and leaves everything else as it is.

## Which script is for what

| Script | Runs on | Changes anything? | Use |
|---|---|---|---|
| [`tools/gx/live-snapshot.js`](../tools/gx/live-snapshot.js) | GX (piped over SSH) | no | Reads the live flow from the admin API and prints a compressed snapshot: the code of every node, a hash of its other properties, the tab label and the live revision. No credentials or Tuya settings leave the GX |
| [`tools/gx/compare.js`](../tools/gx/compare.js) | PC | no | Compares a snapshot with `flows.json` of the work tree or of a commit. Shows what differs and why (`--show`, `--history`). With `--plan` writes the deploy plan |
| [`tools/gx/deploy.js`](../tools/gx/deploy.js) | GX (as root) | only with `DRY=0` | Executes a plan: downloads the commit, checks, backs up, replaces tool files, posts the changed nodes with the source commit label, reads back. Dry run by default |
| [`tools/gx/verify.js`](../tools/gx/verify.js) | GX (piped over SSH) | no | After a deploy: label and recorded commits, DHW state and wait reason, master switch, errors in the Node-RED log since the deploy |
| [`tools/gx/monitor.js`](../tools/gx/monitor.js) | GX (piped over SSH, or installed) | no | Health of the automations at any time: service, version label, devices, pump fault, tank, DHW and heating state, log errors, aborted cycles. One line per check, `STATUS: OK / WARN / FAIL`, exit code 0 / 1 / 2 |
| [`scripts/gx-monitor.ps1`](../scripts/gx-monitor.ps1) | PC | no | Runs the monitor over SSH; `-Drift` adds the comparison of the live code with `origin/master`; `-Watch <s>` repeats and prints on a change; `-Json` for other tools |
| [`tools/deploy-version.js`](../tools/deploy-version.js) | used by `deploy.js` | no | Stamps the editor tab label and stores full source SHAs in its `info`. Removes legacy suffixes from the dashboard site and page names |
| [`tools/flows.js`](../tools/flows.js) | PC | repository only | `sync` copies the numbered sources into `flows.json` and bumps `d#`; `check` verifies it. Always before a commit |
| [`scripts/install-gx-secrets.sh`](../scripts/install-gx-secrets.sh) | GX, started by the workflow | yes | Installs the private files with Node-RED stopped. Part of the secret workflow, not of a code deploy |

Why two places to run: the PC has git and the repository, the GX has the live flow. Pushing large files from the PC to the GX stalls on this link, so the GX downloads the commit itself from `raw.githubusercontent.com` and checks the SHA-256 values that the PC put in the plan.

## Finding the GX and restoring Tailscale on Windows

Use PowerShell. If `tailscale` is not on `PATH`, invoke its installed executable:

```powershell
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
& $ts status
```

### 1. Restore the PC connection

If the peer list is empty or reports `Unable to connect to the Tailscale coordination server`, first check internet access and whether another VPN, proxy or firewall blocks `controlplane.tailscale.com`. Do not disable firewall protections to work around this.

To reconnect, run the following **only when interrupting this PC's Tailscale connections is acceptable**; existing SSH sessions over Tailscale will disconnect:

```powershell
& $ts down
& $ts up
& $ts status
```

If `up` asks for existing non-default flags, preserve the original settings rather than reset them. If reconnection does not help, open the Tailscale tray menu and choose **Log in** (or the sign-in action shown there), then authenticate in Microsoft Edge. Login/key expiry is one possible cause, not proof of the problem.

### 2. Find the GX address

In `status`, look for the Cerbo GX; its hostname may be `einstein`, `cerbo`, `venus` or another configured name. Use the actual peer name, not a guess:

```powershell
& $ts status
& $ts ip -4 '<hostname-gx>'
```

The second command prints the peer's Tailscale IPv4 address. **Without a hostname, `ip -4` prints this PC's address, not the GX's.**

If the GX is missing, open the [Tailscale machines page](https://login.tailscale.com/admin/machines) in Microsoft Edge and check its online state and key expiry. On the GX, check **Settings > Tailscale (remote VPN access)**; the device name and Tailscale IP (`100.x.y.z`) are shown there when available.

### 3. Check SSH without changing the GX

Replace the placeholder with the discovered hostname or IP. Use the existing GX key; the example below uses `id_ed25519_cerbo`:

```powershell
$gx = 'root@<hostname-or-100.x.y.z>'
$key = "$HOME\.ssh\id_ed25519_cerbo"
ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 $gx 'hostname'
```

An unknown or changed host key must be checked against a trusted fingerprint before updating `known_hosts`. Never bypass the check with `StrictHostKeyChecking=no`.

### 4. Use the local network if you are at home

If Tailscale remains unavailable, find the GX's LAN IP in the router's client list or your private network notes (for example, `C:\learn\home-network\NETWORK.md`). The PC must have a route to that LAN:

```powershell
$gx = 'root@<local-IP-GX>'
ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 $gx 'hostname'
```

This fallback is for the local PC, not a GitHub-hosted runner. Once SSH works, use the discovered `$gx` and `$key` for the snapshot/compare procedure below or the dry-run runner. Do not apply a deployment that would discard unreviewed GX-only code.

## Step by step

PowerShell 7 on the PC, in the repository root. Take the host and key from your private notes; keep the quotes.

```powershell
$gx  = 'root@<gx-tailscale-host>'
$key = "$HOME\.ssh\<gx-key-file>"
```

### 1. Commit and push first

**Owner-requested exception:** when the owner explicitly asks for no commit or
push, `tools/gx/deploy-local.js` can prepare a self-contained work-tree plan:
`node tools/gx/deploy-local.js --prepare LIVE.b64 PLAN.json`.
Transfer the script and plan to the GX, run `node deploy-local.js PLAN.json`
for a dry run, then `DRY=0 node deploy-local.js PLAN.json` only in a safe window.
This route checks the snapshot revision, file/code hashes and live wiring,
backs up the flow, credentials and replaced files, preserves all untouched
devices/automations and verifies the result. It labels the UI as
`local:<SHA-256>` rather than inventing a Git commit. The plan includes the
compact Elvenett import, never the session token or raw account archive.
The Dashboard 3.6.6 bootstrap patch waits for the sidenav registration,
restores its missing loading view and replaces conflicting ngTouch gestures
with AngularJS Material gestures; a package upgrade can overwrite these assets.
After reinstalling Dashboard 3.6.6, run the standalone asset repair with a
dry run and reviewed apply to restore the patch. Code deployments, including
`deploy-local.js`, do not inspect or repair installed Dashboard assets. After
upgrading to another version, review and adapt the version-specific patch first:
the helper intentionally refuses unfamiliar versions/code; never bypass that guard.
For an asset-only repair without changing flows or their source label, use the
[standalone Dashboard repair](dashboard.md#dashboard-366-bootstrap-and-ngtouch-compatibility).
The normal pushed-commit procedure below remains the default.

A deploy is always from a pushed commit: the GX downloads it by SHA and the label on the dashboard names it.

```powershell
node tools/flows.js sync
node tools/flows.js check
node --test "tests/*.test.js"
```

Commit, push, wait for the checks of the pull request. Deploy from the commit that will be in `master` (with a squash merge the branch commit disappears from `master`, so merge first or use a merge commit).

The **PR tests** workflow additionally runs the Node test suite for every opened, updated or reopened PR, on submitted PR reviews, and after pushes to `master`. Event types use separate concurrency groups and do not cancel active runs, so a submitted review cannot interrupt PR tests. The existing Node tests in **Check** and the test instructions in **Claude Code Review** remain in place; this is intentional duplication. **Check** also verifies flow/source sync and the PowerShell secret-file tests.

### 2. Take a snapshot of the live flow

```powershell
Get-Content -Raw tools\gx\live-snapshot.js | ssh -i $key $gx "tr -d '\r' | node -" > live.b64
```

`tr -d '\r'` removes the carriage returns PowerShell adds. `live.b64` is about 300 KB; keep it out of git (it contains the flow code, no keys).

### 3. Compare

```powershell
$sha = git rev-parse HEAD
node tools\gx\compare.js live.b64 --commit $sha --history 20
```

Read the report ([below](#reading-the-comparison-report)) before going on. If a node has `-N` (lines only on the GX), look at them:

```powershell
node tools\gx\compare.js live.b64 --commit $sha --show dv-fn-01
```

Removed lines may be genuinely uncommitted GX code or older code already present in Git history. Inspect `--show` and the `--history` matches first. Copy wanted unique lines into the numbered source, `sync`, test, merge and start again from step 1. Use `-AllowLiveOnlyLines` only after the specific replacement/removal is reviewed and explicitly approved; see the [runbook](gx-deploy-troubleshooting.md#3-take-a-private-snapshot-and-compare-code-not-just-version-labels).

### 4. Write the plan

```powershell
node tools\gx\compare.js live.b64 --commit $sha --plan gx-plan.json `
  --tools tools/tuya-cloud-sensors.js,tools/tuya-local-sensors.js
```

- `--tools`: the tool scripts that changed since the last deploy (`git diff --stat <deployed sha> $sha -- tools`). The deployed SHA is in the report line `live deployment source`. A tool that is already equal is skipped on the GX.
- To keep the deploy and check scripts on the GX itself (and so in its backup), add them to `--tools` too: `tools/gx/live-snapshot.js,tools/gx/deploy.js,tools/gx/node-additions.js,tools/gx/verify.js`. They land in `/data/home/nodered/tools/gx/`.
- `--scopes dashboard` or `--scopes automations`: record the commit for one part only. Default is both. The other part keeps its previous commit on the label (`[UI …; Auto …]`).
- `--include-trailing`: also deploy nodes that differ only in whitespace at the end. Not needed; it restarts nodes for nothing.
- `--allow-new-nodes`: include reviewed additions in the plan. Take the snapshot with `node - --topology` first; keep that snapshot private. With the PowerShell runner, `-AllowNewNodes` handles both steps.

The plan is a small JSON file: commit, expected live revision, file hashes, `{ node id: [fields] }`, added node IDs, wiring patch IDs and tool hashes. Read it.

### 5. Dry run on the GX

```powershell
scp -i $key gx-plan.json "${gx}:/tmp/gx-plan.json"
scp -i $key tools\gx\deploy.js "${gx}:/tmp/gx-deploy.js"
scp -i $key tools\gx\node-additions.js "${gx}:/tmp/node-additions.js"
ssh -i $key $gx "node /tmp/gx-deploy.js /tmp/gx-plan.json"
```

The dry run does every check and prints the code changes, the nodes that will restart and the new label. It ends with `DRY RUN - nothing changed`. Any `ABORT:` line means: fix the cause, do not force it.

### 6. Deploy

Only with the owner's go-ahead, and not during a DHW cycle (the script refuses anyway).

```powershell
ssh -i $key $gx 'DRY=0 node /tmp/gx-deploy.js /tmp/gx-plan.json; result=$?; rm -f /tmp/gx-deploy.js /tmp/gx-plan.json /tmp/node-additions.js; exit $result'
```

Note the `backup` line of the output.

### 7. Verify

```powershell
Get-Content -Raw tools\gx\verify.js | ssh -i $key $gx "tr -d '\r' | node -"
```

Expected: the new label with ` [git <sha12>]`, `master true`, `errors since then: none`. `dhw.why` may say `no outdoor value yet` for a while (see [traps](#traps-met-on-14-nov)); run it again after 15–20 minutes and check that the reason is gone or is an ordinary one (tank warm enough, interval). Then look at the Heat Pump and Automations pages: devices CONNECTED, the same master / rule modes as before.

Take a new snapshot and compare once more: `code differs (0)` is the proof that the GX equals the commit.

### 8. Write it down

Add a row to the [work log](heat-pump-work-log.md) (time, `d#`, commit, backup directory).

## Monitoring

Read-only, any time, also between deploys:

```powershell
pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key            # health now
git fetch; pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key -Drift   # + GX code vs origin/master
pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key -Watch 300          # every 5 min, prints on a change
```

```text
OK   service         Node-RED up for 355 min
OK   version         d#180 Day / Night Grid Control [git 97c023b52bca]
OK   device hp       connected, data 0 min ago
OK   heat pump       no fault, supply 37 / return 32 °C, 69 Hz, mode mute
OK   tank            42 °C
OK   automations     ticking
OK   DHW             idle: last cycle 20 min ago (min 1 h)
OK   heating         Silent, target 36 °C, lag 0.8: collecting data
OK   Node-RED log    no errors in the last 30 min (known: 4 x [tuya-smart-device:SA1 power meter (heat pump)])
WARN automation log  4 error(s), 2 aborted DHW cycle(s) in 24 h; last 18:56 UTC: end of DHW (fault Er03 (water flow)) …
WARN drift           1 node(s) differ in code, 0 only on the GX, 0 only in the repository (vs origin/master)
STATUS: WARN
```

| Level | Meaning | Checks |
|---|---|---|
| `FAIL` (exit 2) | Needs action now | Node-RED down; heat pump, valve or bypass disconnected or silent for 5 min; pump fault code; DHW blocked after an aborted cycle (allow it again on the Heat Pump page); automations not ticking for 2 min; a DHW cycle longer than 150 min |
| `WARN` (exit 1) | Look at it | Master switch off; DHW or heating controller not On; tank below 38 °C; Node-RED log errors in the last 30 min; errors or aborted DHW cycles in the automation log of the last 24 h; no recorded source commit; `-Drift`: the live code differs from the commit |
| `INFO` | Normal, but worth knowing | Node-RED started less than 10 min ago; a DHW cycle is running; DHW has no outdoor average yet (after a deploy or around a defrost) |

- The SA1 power meter errors are listed as *known* and do not raise the status (the meter has never connected, see the work log).
- Times in the output are UTC: an SSH shell on the GX has no time zone, Node-RED logs local time.
- The limits are in `LIMITS` at the top of `tools/gx/monitor.js`; `tests/gx-monitor.test.js` holds the cases.
- `-Json` prints the collected values and the findings for another tool. Exit code 3 means the GX could not be read at all.
- For an unattended check on the PC, schedule the first command (Task Scheduler) and act on a non-zero exit code. Nothing runs on the GX between calls and nothing is stored there.

## Reading the comparison report

```text
live  : d#180 Day / Night Grid Control [git 97c023b52bca]  (rev 4cd6602bfba8, read …)
repo  : d#180 Day / Night Grid Control  (commit b67864b04bb0)
live deployment source: {"dashboard":"97c0…","automations":"97c0…"}

code differs: repo lines to add (+) / live lines to drop (-) (2)
  hpa-fn-01    function   Heat pump automations   func   +162 -20  live = 9661738
  dv-fn-01     function   Devices model           func   +0 -4     live = no commit of the last 20
trailing whitespace only (14)
config differs (not deployed by the plan) (4)
only on the GX (0)
only in the repository (0)
```

| Section | Meaning | What to do |
|---|---|---|
| `code differs` | A function, template or exec command is different. `+N` repository lines the GX lacks, `-N` GX lines the repository lacks | This is the deploy. `live = <commit>` (with `--history`) names the commit the GX code equals: the GX is simply behind. `no commit` with `-N` means **code that exists only on the GX**: save it first |
| `trailing whitespace only` | The editor added an empty line at the end | Nothing. Not in the plan |
| `config differs` | Wires, outputs or settings differ | The four `tuya-smart-device` nodes are always here (file-secret references on the GX, template in the repository). Anything else: a structural change, deploy that node by hand |
| `only on the GX` / `only in the repository` | A node would be removed / added | Each requires a separate manual opt-in below |

### Reviewed node removals

In **Actions → Deploy GX code**, set `allow_removed_nodes` to the exact comma-separated list of reviewed node IDs. Empty input blocks removals; automatic runs never pass this input. The runner rejects missing, extra or duplicate IDs. Each listed node must match its definition (apart from editor coordinates) in the recorded Git deployment, which must be a readable ancestor of the target. It must also be absent from the target. Tabs, editor groups and configuration nodes are not removable through this path.

On an existing flow tab, approved removals are limited to the supported core and Dashboard node types (the same type allowlist as for additions) plus read-only `victron-input-*` nodes. This does not allow adding Victron inputs or removing `victron-output-*` nodes or subflow instances.

Before approving a Victron input removal, verify that surviving logic no longer depends on the value it published, including any last value cached in node or flow context. A clean wiring plan does not check those dependencies.

For example, the G2 (#136) transition from d#210 to d#213 needs this exact list:

```text
9217554766842bb8,7ec26167c492e338,8db34d06b6591d5e,3e6dccae307e4561,1d4e50f4d614e8a5,fd95dc1c428330fb,b2064b2168543e59,e84b0d054ca0f956,efb076ae80adc1c5,87b4ad2bc3ec6903,ec0378c28791feff,4ae3639bc75d0d14,dc3b8e51a09c72d4,dc9d4c2e7a1b83f6,pv-charger-tag-01
```

Set `allow_new_nodes=true` as well for this transition. Review `node to remove` and `removal wiring` in the dry run before applying the same SHA and inputs. The runner checks affected connections against the recorded commit, preserves unrelated connections, and takes the replacement wires from the target. It backs up flows and credentials, then verifies the removals and changed connections after posting. The public report lists only Git-sourced metadata, never unverified live node details.

Affected layout groups are compared as sets without duplicates: order differences are normal after additions, and removals restore target order for surviving members.

For PowerShell use `-AllowRemovedNodes 'id-one,id-two'`. With the low-level runner use a `--topology` snapshot, pass `--allow-removed-nodes id-one,id-two` to `compare.js`, and copy `live-snapshot.js` alongside `deploy.js` on the GX.

### Reviewed new nodes

Use `-AllowNewNodes` for the PowerShell runner or `allow_new_nodes: true` for a manual workflow run. Start with a dry run of the same commit, review every `node to add` entry (ID, type, name, URL, wires) and every `wire patch`, then repeat with apply and the same opt-ins. The new-node opt-in does not bypass the separate GX-only code-lines check.

- New IDs must be in the pinned commit, absent on the GX and on a tab that already exists there. Wires must lead to existing or planned nodes on that tab. Existing wiring may only gain connections to the new nodes, including a new function output if needed; other settings and existing code must still pass the normal checks.
- Allowed runtime nodes: sourced functions (`flows.js check` at the pinned commit), HTTP in/response, exec, inject, change, switch, delay, link in/out, file and supported Dashboard widgets in an existing `ui_group`. Link endpoints must link back. A new editor layout group is allowed only if all its members are new nodes on the same tab.
- HTTP routes must not overlap any existing or planned route. If a collision cannot be ruled out, or an addition needs configuration, credentials or unsupported node types, the owner handles it manually. Additions do not authorize any removals.
- Apply backs up flows and credentials, posts with deployment type `nodes`, and re-reads the flow to verify each added node and patched connection against the commit. The deploy report and successful apply mail list the new nodes using metadata from Git.

Offline regression: after building the synthetic Test GX image, run `node tools/test-gx/check-deploy-additions.js`. It uses a network-isolated Node-RED container to test the six UTCP additions from `523ba74` (d#205) to `084387f` (d#206).
When adding a runner dependency, cover both committed-script extraction and the dry-run upload in the PowerShell runner test. Running the JavaScript tools directly does not exercise those paths.

The `d#` number alone proves nothing: on 14 Nov both sides said `d#179` with different code. Compare the code.

## GitHub Actions

After the code commit is on `master`, run **Actions → Deploy GX code**. It defaults to `dry-run` and pins the run's `GITHUB_SHA`, even if `master` advances. Select `apply` only after reviewing a dry run of the **same SHA**, and type `deploy-gx-code` in the confirmation field. The `victron-gx` approval is still required. Both modes accept replaced lines without an override when live code exactly matches a recorded deployment that is an ancestor of the target. Otherwise the dry-run summary explains the stop and next step. Preserve wanted edits in Git; enable `allow_live_only_lines` only after reviewing unverified lines and confirming their removal is intended.

Select `version: test` (default) or `stable` to label the report. This is an operator-selected **report label only**, not a health guarantee: it creates no Git tag/status and changes neither the deployment behavior nor the GX UI.

The job log, summary and artifact show the target SHA, version label, run outcome, comparison counts, and repository commit subjects/changed file paths since the previously recorded GX commit. Dashboard and automations are compared separately when their previous SHAs differ. Missing or unavailable previous commits are explicitly reported; they are never replaced with a guessed baseline. The repository file list is context, not a promise to deploy every listed file; the existing code-node/tool plan still determines what changes on GX.

Full snapshots, node code, live labels, live-only node IDs and raw compare/deploy/verify reports are **not uploaded**: this repository is public. Planned additions in the public report use only metadata from the target Git commit. For detailed live reports, use the local runner instead. The workflow allows 60 minutes, including up to 30 minutes waiting for a safe deployment window.

Configure these repository or `victron-gx` environment secrets before running it: `GX_SSH_HOST` (`root@<gx-tailscale-host>`), `GX_SSH_KEY`, `GX_SSH_KNOWN_HOSTS`, `TS_OAUTH_CLIENT_ID`, and `TS_OAUTH_SECRET`. The workflow runs only from `master`; the environment should also restrict deployments to `master` and require its configured reviewer.

### Automatic deploy after Test GX

Every PR and every push to `master` starts **Test GX scenarios**. Only PR runs can skip Docker and the scenarios based on changed paths or cancel in-progress runs in their concurrency group. After a successful `master` push run, **Deploy GX code** starts automatically (`workflow_run`) with `mode=apply`, `version=test`. The `confirm` check is skipped only for this automatic path.

[`tools/gx/deploy-gate.js`](../tools/gx/deploy-gate.js) selects the newest successful Test GX push on the current first-parent history of `master`. It will not deploy across an untested change to `flows.json` (which carries `d#`), but a newer documentation-only commit does not block a green ancestor. The triggering run must itself be green, be a push to this repository's `master`, and still be an ancestor. The workflow rechecks the pinned selection before connecting to the GX. A skip emits a warning and writes its reason to the job summary. Automatic runs still refuse new nodes and never use the manual `allow_live_only_lines` override. Runs share the `deploy-gx-code` concurrency group.

Automatic runs can replace GX-only code lines when the live snapshot matches its last recorded Git deployment. The record is the `victron-deployment-source` block in the versioned flow tab's info, stamped by `tools/deploy-version.js`. The dashboard and automations entries must agree on one full Git SHA, and that commit must be a readable ancestor of the target. Before writing the plan, `compare.js` checks live node IDs, types, and all code fields against that commit's `flows.json`. As in post-deploy verification, CRLF and whitespace at the very end of a field are ignored; changes inside the code still block verified replacement. Expected configuration differences such as secret references are not part of this comparison, and the existing deploy checks still govern config and topology. The plan uses the same snapshot revision for the eventual apply. Missing, invalid, split, or non-Git records and substantive code mismatches stop verified replacement; review the comparison and use the manual path when appropriate.

**Deploying by hand when auto skipped:** Wait for the newer production commit's own Test GX run if it is still pending. If automatic deployment did not run, follow the manual dry-run and approval procedure above.

Automatic runs use the environment **`victron-gx-auto`**; manual runs keep `victron-gx`. The owner creates `victron-gx-auto` once: same five secrets as `victron-gx` (or rely on the repository secrets), deployment branch `master` only, and no required reviewer (otherwise the deploy waits for approval).

## Deploy mail

After every successful **apply** (manual or automatic) the deploy job sends one mail through the GX's own mail path: it builds the message with [`tools/gx/deploy-mail.js`](../tools/gx/deploy-mail.js) and pipes it over the existing SSH connection into `node /data/home/nodered/tools/send-mail.js` (recipient and SMTP settings come from `email.json` on the GX; nothing is stored in the repository or CI).

### Camera alert mail: restricted SSH key

The GX code deploy keeps `tools/camera-mail-gate.js` executable (0755) alongside `tools/send-mail.js`. After the tool is deployed, the owner adds the dedicated camera public key to the GX SSH account's `authorized_keys` (replace the placeholder with the key's public blob):

```text
restrict,command="/data/home/nodered/tools/camera-mail-gate.js" ssh-ed25519 <public-key-blob> camera-ai@omarchy
```

Use an SSH server that supports the `restrict` key option, and do not accept client-controlled executable paths or Node startup variables such as `NODE_OPTIONS`. Keep the tool directory and its parents writable only by trusted GX accounts. Do not copy a deployment key to the camera host or authorize the camera key elsewhere without the restriction. To revoke access, remove that exact line and close any existing connections using the key. A compromised key can still send mail to the configured mailbox; it cannot select the recipient or execute a command through the gate.

- **Check:** `ssh -T -i ~/.ssh/id_ed25519_camera_mail -o IdentitiesOnly=yes -o BatchMode=yes <gx-user>@<gx-host> check`. Exact `check` tests SMTP login without sending or reading stdin. Any other remote command is ignored and follows the send protocol.
- **Send:** use one SSH call with no remote command, no PTY, and host key verification. Write exactly one UTF-8 JSON object on stdin and close stdin (EOF within 45 seconds). Its total size, including Base64 and trailing whitespace, must be at most 10 MiB (10,485,760 bytes). Required fields: `subject` (nonblank; at most 200 Unicode code points; no controls or line separators) and `text` (string, may be empty). Optional `jpg_b64` is a JPEG encoded as canonical standard Base64 with padding when required, without whitespace or a data URL. Omit the field for text-only mail; unknown fields, including `to`, are rejected.
- **Result:** stdout is one JSON line: `{"ok":true}`, `{"ok":true,"check":true}` for check, or `{"ok":false,"error":"..."}`. Exit codes: `0` success, `1` sender/internal failure, `2` invalid or timed-out input. Parse stdout even for nonzero exits; SSH transport failures may return `255` without a JSON line. A transport timeout does not prove that no mail was sent.

Subject: `GX deployed d#205 (523ba74)`. Body (plain text): previous and new `d#` with short commits, the trigger (manual dispatch by `<actor>` or automatic after a Test GX run, with its link), whether `allow_live_only_lines` was used, the changed files grouped as flow sources / lib / pages / tools (other files only counted), the commits between the previous and the new GX commit (`git log --no-merges`, at most 40, then `+N more`), and the Test GX and deploy run links. The previous commit is the one recorded on the GX tab; if it is not recorded the mail says so and omits files and commits. No hosts, IPs or addresses are included.

Dry runs, skipped (gate) runs and failed applies send nothing. A mail problem never fails the deploy: the step logs `::warning::deploy mail: failed (<reason>)` and writes the same line to the job summary; success logs `deploy mail: sent`.

## What the deploy script checks

In this order; the first failure stops it before anything is written.

1. The plan is well formed (full SHA, hashes, known scopes, only code fields).
2. `flows.json`, `tools/deploy-version.js` and the planned tool files of the commit download and match the SHA-256 of the plan. A commit that is not pushed fails here.
3. Each tool file passes `node --check`.
4. The live revision equals the one of the snapshot: nobody deployed in between.
5. The live `d#` is not newer than the commit.
6. The heat pump automations are in `HEATING` with no cycle running.
7. Every planned node exists on both sides and, after the patch, equals the commit in everything except its editor position.
8. The node count is unchanged.

With `DRY=0` it then makes the backup, replaces the tool files (owner and mode set first, then a rename; the previous file is saved in the backup directory), posts with the revision and `Node-RED-Deployment-Type: nodes`, waits, reads the flow back and compares the planned fields. If the POST fails and the live revision is unchanged, the previous tool files are put back, so the flow and its tools still match; if the flow state is unknown after a failed POST, the tool files stay and the script says so. A missing or unreadable DHW state stops the deploy.

What restarts: the patched nodes. The first deployment that removes legacy source suffixes also changes the dashboard site and page configuration, which can restart widgets. Subsequent source stamps do not rename pages. Function nodes lose their node context; the heat pump automations read their settings file again on start. Credentials stay: `GET /flows` returns none and Node-RED keeps those of the nodes it does not replace.

The dashboard header shows `d#<n> · <sha7>` in the top-right corner on every page. The short SHA is the dashboard source commit (not the automation commit); it is omitted when no dashboard Git source was stamped. The badge reads the runtime flow name and refreshes on load and within 30 seconds while the page is visible. The tab's `info` remains the source of the full SHAs for `verify`, `monitor`, and `compare`.

If the four `dashboard-version-*` nodes are missing, use the guarded process for reviewed new nodes. Later releases can update their code with the regular selective deploy workflow.

## Rollback

The deploy prints `backup : /data/home/nodered/.node-red/backup-<time>-pre-d<n>`. It holds `flows.json`, `flows_cred.json`, `original-live.json` (the untouched API answer) and the previous version of every replaced tool file.

```sh
svc -d /service/node-red-venus
cp -p <backup>/flows.json <backup>/flows_cred.json /data/home/nodered/.node-red/
svc -u /service/node-red-venus
```

Tool files: the previous copies are in the same backup directory; `cp -p <backup>/<name>.js /data/home/nodered/tools/`.

## Traps met on 14 Nov

| Trap | What happened | Rule |
|---|---|---|
| Same `d#`, different code | The GX had four `pir_state` lines in the Devices model that were in no branch; `master` reached `d#179` again with other changes | Compare the code (step 3). Never deploy from an uncommitted work tree |
| Trailing newline | 14 nodes differed only by an empty last line | The report separates them; do not deploy them |
| CRLF | Tool files copied from Windows had CRLF; their hashes matched no commit | Let the GX download from GitHub. Compare without CR |
| No `install` on Venus OS | A script using `install -m … -o …` stopped with `command not found` | Use `cp` / `chown` / `chmod`, or set owner and mode and rename. `install` in tests must not be mocked away |
| Symlink at the destination | `cp` as root writes through a link that the `nodered` user could have put there | Write to a root-only directory on the same filesystem, then rename |
| `node -` has no main module | `require.main === module` is false for a script piped to `node -`, so it printed nothing | `if (!require.main \|\| require.main === module)` |
| PowerShell redirection | `>` may add a BOM; JSON built in a pipe was unreadable | `compare.js` keeps only the base64 characters. Write files from Node, not through a PowerShell pipe |
| LAN address did not answer | From the PC on Wi-Fi the GX LAN address and `venus.local` timed out | Use the Tailscale host |
| Large pushes stall | Hundreds of KB from the PC to the GX take minutes | Small files by `scp`, everything else downloaded by the GX |
| Waiting after the deploy | The automations showed `no outdoor value yet; defrost now or < 15 min ago` | Normal: the outdoor average starts empty and no samples are taken during a defrost and 15 minutes after it. Check again later |
| Page names | An older live flow may still have the source label appended | The current stamper strips legacy suffixes; check that page names are plain and look for the version badge in the header |

## What was done on 14 Nov 2026

For the record, and as a worked example of the steps above.

1. **Fetched `master`** (d#179 after PR #29 and #30) and read the new deployment parts: the secret workflow and `tools/deploy-version.js`.
2. **Reached the GX** over Tailscale, read-only: listed the files, saw `flows.json` last written at 13:21 (the secret migration), hours before PR #29 was merged.
3. **Fingerprinted both flows**: a script on the GX hashed every node's code; the same on the repository file. 25 nodes differed.
4. **Pulled the code of those nodes** (gzip + base64) and compared line by line with each commit of `flows.json`: 14 were trailing-newline noise, 7 were behind `master` (PR #29, motion sensor), 4 Tuya nodes were the expected secret references, and the Devices model had four lines found in no commit.
5. **Compared the tool files** by SHA-256 without CR: two were behind (`tuya-cloud-sensors.js`, `tuya-local-sensors.js`).
6. **Checked GitHub**: all `SECRETFILE_*` present, none of the five access secrets, no `victron-gx` environment, the workflow never run.
7. **Saved the GX-only code**: copied the four lines into `50 Devices model.js`, `sync` → d#180, pull request #31.
8. **Updated the two tool files**: downloaded by the GX from the commit, hash checked, `node --check`, old files kept as `*.pre-d180`.
9. **Dry run, then deploy** at 18:56: 7 nodes patched, label `d#180 … [git 97c023b52bca]`, backup `backup-20261114T1756-pre-d180`, read back and compared.
10. **Verified**: no errors in the log, master switch on, shower option off, devices connected.
11. **Created the `victron-gx` environment** (required reviewer, `master` only) and started the workflow in `check` mode.
12. **Fixed the secret installer** (`install` missing on the GX, then the symlink issue found in review), with tests.
13. **Turned the one-off scripts into `tools/gx/`** and tested them on the GX: snapshot, comparison, a dry run of a plan, verify.

At the end of 14 Nov, the five access secrets and workflow approval were still pending. The secrets were present and Tailscale/SSH were proven by the 15 Nov code dry-run; environment approval is required for each new run. See the [15 Nov runbook](gx-deploy-troubleshooting.md) and work log for the later recovery and deployment.
