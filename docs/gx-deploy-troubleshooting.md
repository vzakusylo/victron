# GX deployment runbook: connection, drift, dry-run, backup and verification

This is the recovery procedure used for the **15 Nov 2026 d#187 deployment from master**, not an instruction to force a failed deploy. See [the deployment guide](gx-deploy.md#command-runners) for the tools and fixed steps, and [the work log](heat-pump-work-log.md#2026-11-15-1035-1038-europeoslo-master-deployed-without-stopping-node-red) for the actual result and backups.

**Never copy the raw repository template over the GX's `flows.json`. Never deploy the secret workflow just to update code.** The current runner prepares the target with Tuya file-secret references, checks for drift, and asks Node-RED to deploy modified nodes without restarting the service.

## 1. Restore connectivity before trying a deployment

Use PowerShell 7, a reviewed checkout of the deployment scripts, and the real GX address/key from private notes:

```powershell
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
& $ts status
$gx = 'root@<gx-hostname-or-IP>'
$key = "$HOME\.ssh\id_ed25519_cerbo"
$sshOptions = @('-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
ssh @sshOptions $gx 'hostname'
if ($LASTEXITCODE -ne 0) { throw 'GX SSH is not ready; do not deploy.' }
```

| Symptom | Check and resolution |
|---|---|
| Empty peer list / `Unable to connect to the Tailscale coordination server` | Check internet, login/key expiry, another VPN/proxy and firewall access to `controlplane.tailscale.com`. When disconnecting current tailnet sessions is acceptable, run `& $ts down`, then `& $ts up`, then `& $ts status`. Preserve existing non-default flags if `up` requests them. Use the tray sign-in action and authenticate in Edge if required. |
| GX address is unknown | Find the actual GX peer in `status`, then `& $ts ip -4 '<gx-hostname>'`. Without a hostname this prints the PC's address. Check the Tailscale machines page or GX **Settings > Tailscale (remote VPN access)** if the peer is absent. |
| Tailscale is still unavailable, but the PC is at home | Find the GX LAN address in the router or private network notes, and use `root@<LAN-IP>` instead. The PC must have a route to that LAN. GitHub-hosted runners cannot use this local fallback. |
| `Permission denied (publickey)` | Check the root account, the correct local private-key file and its matching authorized key on GX. Never print or upload the key. |
| Unknown/changed SSH host key | Verify the fingerprint through a trusted channel before updating standard `~/.ssh/known_hosts`. Do not disable host-key checking. |
| SSH works but `/flows` cannot be read | Check `svstat /service/node-red-venus` and the Node-RED log over SSH. Diagnose service/API availability; do not restart the service as a routine deployment step. |

The complete Windows connectivity commands are in [Finding the GX and restoring Tailscale](gx-deploy.md#finding-the-gx-and-restoring-tailscale-on-windows). On 15 Nov the PC had lost coordination connectivity; after reconnecting, SSH and the read-only snapshot worked.

## 2. Freeze the target master commit

Before merging code changes, sync the numbered sources, check them and run tests:

```powershell
node tools/flows.js sync
node tools/flows.js check
node --test "tests/*.test.js"
```

After the changes are pushed, reviewed and merged, resolve a full SHA:

```powershell
git fetch --quiet origin
if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed.' }
$sha = (git rev-parse --verify 'origin/master^{commit}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve master.' }
git branch -r --contains $sha
```

Keep `$sha` unchanged for diagnosis, dry-run and apply. A pushed feature branch, a closed PR and the latest working-tree files are **not** evidence that the change is in master. Check the merge state and master history first.

Do not run `sync` merely to deploy an already merged commit: it changes the working tree, not the pinned deployment target. Do not use `-UseWorkTreeScripts` for a production deployment.

## 3. Investigate drift, not just version labels

The normal dry run reports drift against the stamped and prepared Git baseline. It names changed fields
without showing their values. If you need to inspect changed *code*, use the separate diagnostic snapshot.
Keep run files outside the repository:

```powershell
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('gx-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$snapshotFile = Join-Path $runRoot 'live.b64'
$snapshot = Get-Content -Raw .\tools\gx\live-snapshot.js,.\tools\gx\admin-api.js |
    ssh @sshOptions $gx "tr -d '\r' | node -"
if ($LASTEXITCODE -ne 0 -or -not $snapshot) { throw 'Snapshot failed.' }
[IO.File]::WriteAllText($snapshotFile, ($snapshot -join "`n") + "`n")
node .\tools\gx\compare.js $snapshotFile --commit $sha --history 20
if ($LASTEXITCODE -ne 0) { throw 'Comparison failed.' }
```

The snapshot excludes Tuya settings/credentials but contains live function/template code. Treat it and the detailed reports as private: a hard-coded live secret could still be present. Do not commit them or upload them to public artifacts.

The diagnostic output shows code differences against the selected commit, not necessarily drift.
Ordinary Git changes are reported separately in the plan. To inspect one node, use its ID:

```powershell
node .\tools\gx\compare.js $snapshotFile --commit $sha --history 100 --show temps-fn-01
node .\tools\gx\compare.js $snapshotFile --commit $sha --show temps-page-01
node .\tools\gx\compare.js $snapshotFile --commit $sha --show temps-record-01
```

**The actual 15 Nov finding:** all three temperature fields matched `a4af86d`. Master replaced local-time day selection with Europe/Oslo, added archive-error handling and 400-day cleanup, and avoided duplicate archive series. There were no unique live lines to copy back. The owner explicitly approved replacing the reviewed older code.

Preserve wanted differences in Git. A missing, split or local record is not a valid Git drift baseline and
cannot be bypassed with the override.

## 4. Historical example: output and wiring migration

The previous runner patched code fields, not topology. On 15 Nov, `temps-record-01` had two outputs on GX but three in master:

```text
GX:     [["temps-file-01"], ["temps-catalog-01"]]
master: [["temps-file-01"], ["temps-catalog-01"], ["temps-exec-01"]]
```

Without the third output, the new recorder code would not deliver its cleanup command. Do not deploy that new function while silently leaving the old topology.

The successful one-off updater checked the exact old code/configuration, revision, unchanged first two routes, the existing exec target and the safe window again immediately before POST. It backed up the flow/credentials and original API response, changed only `outputs` and `wires` of this recorder, and verified every other node was unchanged. This is a historical, specific migration, **not** a generic permission to modify arbitrary wiring.

The current whole-flow deploy posts code and topology together after the drift gate. Do not perform
a separate editor migration as part of the ordinary deployment.

## 5. Run dry-run; apply the same SHA only when all checks pass

Normal dry-run:

```powershell
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key `
    -Commit $sha -RunDirectory (Join-Path $runRoot 'dry-run')
```

If the owner explicitly approved replacing the specific drift, add `-OverwriteDrift` to the reviewed dry run:

```powershell
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key `
    -Commit $sha -OverwriteDrift -RunDirectory (Join-Path $runRoot 'reviewed-dry-run')
```

Read `plan-output.txt`, `plan.json`, `window.txt` and `dry-run.txt` in that run folder. Before applying, require:

- the target SHA is the intended pushed master commit;
- no unexplained lost live code, added/removed nodes, wiring/output/settings differences or `ABORT`;
- every listed node/tool change and dashboard rename is understood;
- SSH, downloads, SHA-256 and syntax checks succeeded;
- the live revision is current and the safe-window check passes;
- the owner's deployment approval has been given.

For normal apply, omit the exception flag:

```powershell
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key `
    -Commit $sha -Apply -WaitWindowMin 30 -RunDirectory (Join-Path $runRoot 'apply')
```

For the same explicitly approved drift replacement as above:

```powershell
pwsh -NoProfile -File .\scripts\gx-deploy.ps1 -GxHost $gx -SshKey $key `
    -Commit $sha -OverwriteDrift -Apply -WaitWindowMin 30 `
    -RunDirectory (Join-Path $runRoot 'reviewed-apply')
```

Use a new run-directory name for each retry; never overwrite the evidence from a failed run. Apply repeats the snapshot, comparison, plan, window and dry-run checks before changing anything. If another deployment changed the revision, start again from a fresh snapshot. If DHW/defrost/rule activity blocks the safe window, wait or rerun later; do not bypass it.

**Backup timing:** an apply that changes the GX creates its backup before replacing files or posting the flow. Record the printed path before continuing. A dry run and `NOTHING TO DO` create no GX backup.

Success means the normalized full readback matches the stamped, prepared target and the requested tool
files are current. A previously applied version with matching tools returns `NOTHING TO DO`.

## 6. Verify immediately, then again after 15-20 minutes

The apply runner must finish with `DONE` and the expected label after full-flow verification. Check independently:

```powershell
pwsh -NoProfile -File .\scripts\gx-monitor.ps1 -GxHost $gx -SshKey $key -Drift
ssh @sshOptions $gx 'svstat /service/node-red-venus'
```

`-Drift` compares with the locally fetched `origin/master`. If master advanced since `$sha` was chosen, inspect against the pinned SHA rather than calling that later difference a failed deployment.

Confirm local control is on, automations tick, heat pump/valve/bypass are connected, the service uptime did not reset, and there are no new Node-RED errors. Repeat the monitor after **15-20 minutes**; a newly reset outdoor average needs time to refill.

A historical 24-hour automation-log warning is not the same as a new deployment fault. On 15 Nov the monitor reported old Er03 events (4 errors / 2 aborted cycles), while the live pump had no fault and no new Node-RED errors appeared. Do not hide a new/active Er03, disconnected device or stalled controller behind that explanation.

Record the time, SHA, version, backup paths, migrations, review exceptions and results in the work log. Keep private run folders locally.

## 7. GitHub Action problems encountered

| Problem | Resolution |
|---|---|
| Job stays `waiting` | The `victron-gx` environment requires its configured reviewer. In Edge, open the run, choose **Review deployments**, select the environment and **Approve and deploy**. Saying "continue" in chat is not the GitHub approval. Dry-run and apply are separate approved runs. |
| `master` changes while awaiting approval | The workflow must pass `-Commit $env:GITHUB_SHA`. Match the approved dry-run SHA with the apply SHA; a later run of master may point to a different commit. |
| The drift gate stopped the deployment | Keep wanted changes in Git. Only a manual dispatch can set `overwrite_drift`, after explicit approval and a reviewed dry run. The matching Git deployment record and revision are still required. |
| Run reports cannot be found on Ubuntu | The script uses .NET's temp directory; set `TMPDIR` to `runner.temp` or pass an exact `-RunDirectory`. Do not search a different directory or assume Windows `cmd` exists. Git blob extraction must preserve bytes cross-platform. |
| Public artifacts could leak GX-only code | Upload only the deliberately constructed public summary. Never upload the entire run folder, live snapshots, diffs or raw live reports. |
| Tailscale/SSH secret is missing | Configure `GX_SSH_HOST`, `GX_SSH_KEY`, `GX_SSH_KNOWN_HOSTS`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` in the repository/environment. Keep `known_hosts` in the standard SSH location; preserve strict verification and remove runner key material in `always()`. |
| GitHub CLI uses the wrong host/token | Use `--repo github.com/vzakusylo/victron` and API `--hostname github.com`; inspect `gh auth status`. Do not print tokens. Use the intended stored account in a separate shell without conflicting token/host environment overrides. |
| Copilot app cannot create a PR with the repository's selected account | Select an account with access in the repository's GitHub Account setting. Using a separate authenticated CLI account requires the owner's choice; it does not fix the app's selected account. |
| Updated branch does not appear in master | Verify the PR is merged, not merely pushed/closed, and fetch master. Optional report labels and other workflow improvements exist only where their commits were actually merged. |
| Both `PR tests` and `Check` fail in the fake-GX E2E test with an unexpected changed `function` | The old test HTTP server concatenated raw Buffers into a string, decoding each TCP chunk separately. A split UTF-8 character corrupted the simulated flow source and made an untouched node appear changed; Linux exposed it while a local run could pass. Decode the request stream with `req.setEncoding('utf8')` before collecting chunks. The regression test deliberately splits a character between two HTTP writes. This is a test-fixture transport problem, not a live GX deployment or a reason to relax the unchanged-node assertion. |

## 8. If apply fails after changes began

Exit 1 means the runner stopped before its code deployment began; inspect the reports and correct the cause. A separately completed topology migration is still a real earlier change even if the later code runner exits 1. Exit 2 means changes may already have begun: keep the reports, inspect the actual live state and the printed backup; do not retry blindly.

The code backup contains `flows.json`, `flows_cred.json`, `original-live.json` and previous replaced tools. Follow [Rollback](gx-deploy.md#rollback) with a safe window and explicit approval: rollback stops Node-RED and is not the normal no-restart deploy. Restore replaced tools as well as flow/credentials; nested tool paths are stored with separators flattened, for example `gx__verify.js` restores to `tools/gx/verify.js`. Never restore the repository template or expose credential files.

The 15 Nov deployment kept **two** backups: one before output-topology migration and one before code deployment. The latter contains the already migrated topology. Choose the backup that represents the state you actually intend to restore.
