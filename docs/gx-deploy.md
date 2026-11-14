# Deploying to the Cerbo GX: scripts and step-by-step guide

> How to find out what the GX really runs, deploy only the difference from a pushed commit, and check the result. Written after the d#180 deploy of 14 Nov 2026; the scripts in `tools/gx/` are the reusable form of what was done by hand that day.

Related: [Development & deployment](development.md) (rules, versioning) · [Secrets](../scripts/SECRETS.md) (private files, GitHub workflow) · [Backup & restore](backup-restore.md) · [Work log](heat-pump-work-log.md)

## Contents

- [The three things that get deployed](#the-three-things-that-get-deployed)
- [Which script is for what](#which-script-is-for-what)
- [Step by step](#step-by-step)
- [Reading the comparison report](#reading-the-comparison-report)
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
| [`tools/deploy-version.js`](../tools/deploy-version.js) | used by `deploy.js` | no | Adds ` [git <sha12>]` to the tab label and the dashboard page names and stores the full commit SHA in the tab `info` |
| [`tools/flows.js`](../tools/flows.js) | PC | repository only | `sync` copies the numbered sources into `flows.json` and bumps `d#`; `check` verifies it. Always before a commit |
| [`scripts/install-gx-secrets.sh`](../scripts/install-gx-secrets.sh) | GX, started by the workflow | yes | Installs the private files with Node-RED stopped. Part of the secret workflow, not of a code deploy |

Why two places to run: the PC has git and the repository, the GX has the live flow. Pushing large files from the PC to the GX stalls on this link, so the GX downloads the commit itself from `raw.githubusercontent.com` and checks the SHA-256 values that the PC put in the plan.

## Step by step

PowerShell 7 on the PC, in the repository root. Take the host and key from your private notes; keep the quotes.

```powershell
$gx  = 'root@<gx-tailscale-host>'
$key = "$HOME\.ssh\<gx-key-file>"
```

### 1. Commit and push first

A deploy is always from a pushed commit: the GX downloads it by SHA and the label on the dashboard names it.

```powershell
node tools/flows.js sync
node tools/flows.js check
node --test "tests/*.test.js"
```

Commit, push, wait for the checks of the pull request. Deploy from the commit that will be in `master` (with a squash merge the branch commit disappears from `master`, so merge first or use a merge commit).

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

Lines that exist only on the GX were deployed from an uncommitted work tree. Copy them into the numbered source, `sync`, commit, and start again from step 1. Otherwise the deploy removes them.

### 4. Write the plan

```powershell
node tools\gx\compare.js live.b64 --commit $sha --plan gx-plan.json `
  --tools tools/tuya-cloud-sensors.js,tools/tuya-local-sensors.js
```

- `--tools`: the tool scripts that changed since the last deploy (`git diff --stat <deployed sha> $sha -- tools`). The deployed SHA is in the report line `live deployment source`. A tool that is already equal is skipped on the GX.
- `--scopes dashboard` or `--scopes automations`: record the commit for one part only. Default is both. The other part keeps its previous commit on the label (`[UI …; Auto …]`).
- `--include-trailing`: also deploy nodes that differ only in whitespace at the end. Not needed; it restarts nodes for nothing.

The plan is a small JSON file: commit, expected live revision, file hashes, `{ node id: [fields] }`, tool hashes. Read it.

### 5. Dry run on the GX

```powershell
scp -i $key gx-plan.json "${gx}:/tmp/gx-plan.json"
scp -i $key tools\gx\deploy.js "${gx}:/tmp/gx-deploy.js"
ssh -i $key $gx "node /tmp/gx-deploy.js /tmp/gx-plan.json"
```

The dry run does every check and prints the code changes, the nodes that will restart and the new label. It ends with `DRY RUN - nothing changed`. Any `ABORT:` line means: fix the cause, do not force it.

### 6. Deploy

Only with the owner's go-ahead, and not during a DHW cycle (the script refuses anyway).

```powershell
ssh -i $key $gx "DRY=0 node /tmp/gx-deploy.js /tmp/gx-plan.json; rm -f /tmp/gx-deploy.js /tmp/gx-plan.json"
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
| `only on the GX` / `only in the repository` | A node was added or removed | Not handled by the plan. Add the node in the editor or by a one-off patch, then compare again |

The `d#` number alone proves nothing: on 14 Nov both sides said `d#179` with different code. Compare the code.

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

What restarts: the patched nodes, and every dashboard page and widget, because the source label renames the pages. Function nodes lose their node context; the heat pump automations read their settings file again on start. Credentials stay: `GET /flows` returns none and Node-RED keeps those of the nodes it does not replace.

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
| Page names | The source label is appended to every dashboard page name | Nothing switches pages by name here (no `ui_control` node). Keep it that way or strip the label first |

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

Left for the owner: the five access secrets (`GX_SSH_HOST`, `GX_SSH_KEY`, `GX_SSH_KNOWN_HOSTS`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`) and the approval of the workflow run.
