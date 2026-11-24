# Test GX: detailed handoff and operational instructions

> Historical record only. Use [Test GX](../test-gx.md) and the [agent workflow](../agent-workflow.md) for current instructions.

Prepared on 2026-11-16 from this conversation, its checkpoints, repository files and live GitHub metadata.

This is a task handoff, not a replacement for authentication, native permission prompts or global agent instructions. It contains no secret values. Commands below are a runbook: preparing this document did not execute the future implementation or authorize another merge.

## 1. Outcome and current state

The project is a Docker test copy of a Victron Cerbo GX. It runs Node-RED with sanitized backup data and controlled D-Bus/MQTT inputs. It is not a Docker image of the complete Venus OS and cannot validate real inverter/battery reactions, the native Tuya protocol or ARM-specific behavior.

Current state independently read during this handoff:

| Item | State |
|---|---|
| Repository | `vzakusylo/victron` |
| Current worktree branch | `test-gx-forecast` |
| Current worktree HEAD | `244f720feb2b6dc72ba4e48df179a1a3cd90788d` |
| Worktree changes | None at the metadata check |
| PR #45 | MERGED; merge commit `244f720feb2b6dc72ba4e48df179a1a3cd90788d` |
| PR #45 reviewed head | `4df7a52d54175d91b38379369c21e14af07984d6` |
| Open PR | #46, `Add boiler emulation to Test GX` |
| PR #46 branch | `test-gx-boiler` |
| Latest PR #46 head | `5f9125c9795fe5f879cab10d928297b4575ba943` |
| Latest PR #46 checks | All returned check runs are SUCCESS |
| Latest PR #46 review | Claude reports "safe to merge"; remaining Low/Nit issues |
| Latest PR #46 independent validation | Not performed by this session on `5f9125c` |

Important correction: the earlier "PR #45 pushed, without merge" report is historical. The user subsequently explicitly requested its merge, and that merge is complete.

PR references:

- https://github.com/vzakusylo/victron/pull/43
- https://github.com/vzakusylo/victron/pull/44
- https://github.com/vzakusylo/victron/pull/45
- https://github.com/vzakusylo/victron/pull/46

## 2. Goal, boundaries and sequencing

The original plan had two major stages:

1. **A: backup-derived image.** Obtain a real backup, sanitize it, preserve settings/history, build matching Node-RED/palette versions, compare image/backup/live snapshots, and wrap the process in one refresh command.
2. **B: emulation and scenarios.** Inventory every input/output, implement controlled sensor interfaces and write recording, establish a workable clock, then add YAML scenarios and a JUnit runner.

Work is delivered sequentially, with one open PR at a time. A subsequent branch is based on fresh merged `master`, not on an unmerged prerequisite. The user moved Tuya ahead of forecast because Tuya depended on the Mosquitto PR.

Production `flows.json` and numbered JS sources must remain unchanged for this test-infrastructure work. Image-only transformations are appropriate; production fixes require a separate assignment.

The remaining implementation order is:

1. Finish the current PR #46 review/validation process; do not merge it solely because this document exists.
2. Continue forecast fixtures on fresh merged `master` after the open-PR gate is satisfied.
3. Cover remaining exec-based Tuya sensors and other uncovered inputs.
4. Implement YAML scenarios and the JUnit runner.
5. Complete deploy rehearsal and CI gates before any separately authorized production rollout.
6. Backlog item 8, battery efficiency, and item 9, dashboard corner version, follow the complete test-GX work.

## 3. Permission register: explicitly answered individually

The first round of ten permission questions returned "user is not available." Those responses were not approvals.

In the subsequent round, the user selected **Allow** individually for all twelve requests below. These are scoped task capabilities, not unrestricted authority.

| # | Approved scope | Exclusions / conditions |
|---|---|---|
| 1 | Read repository files; edit assigned test infrastructure, tests and documentation | Production flows and numbered JS excluded |
| 2 | Read sensitive GX backup configuration; write sanitized backups, maps and reports outside Git | Secrets stay local; no secrets in commits or Docker images |
| 3 | Run needed PowerShell, Node.js, Python, Git, gh, SSH and archive commands | Unrelated commands excluded; native approvals still apply |
| 4 | Pull/build images; create/start/stop/recreate test-GX containers and networks; reset its test volume | Other Docker workloads/data excluded |
| 5 | Root SSH inside the test-GX container for inspection | Host root and real-GX root access excluded |
| 6 | Test APIs/dashboard: inspect status/flows, deploy/remove temporary tabs, set readings/faults, exercise controls | Production APIs and real hardware control excluded |
| 7 | Edge through Playwright: relevant GitHub/test pages, values, console inspection, screenshots and test controls | Unrelated browsing and account settings excluded |
| 8 | gh CLI: repository/PR/check inspection, scoped pushes and requested PR creation | Resolving discussions, merging and remote deletion still require task-specific instruction |
| 9 | Scoped local commits, branch switching/creation, merged branch deletion and updating master | No force operations, discarded work or rewritten commits |
| 10 | Downloads from GitHub/npm/container registries/upstream sources; local test SSH/HTTP/MQTT/D-Bus traffic | No secret uploads or real-home-device control |
| 11 | Generate separate test SSH key; maintain only test-GX SSH/known-host entries as necessary | Production keys and unrelated entries unchanged |
| 12 | Read session checkpoints, maintain task tracking, create/remove named review copies, write this handoff/register | No global or repository agent-instruction modification |

Separately, the user explicitly authorized the historical commit/push/PR operations and the resolution/merge/deletion of PR #45. That is not a standing instruction to merge PR #46 or future PRs.

Operational rule: obtain actual authentication/permission when required. A permission entry does not prove an OAuth scope exists or that a native prompt has been accepted.

## 4. Paths and reproducibility facts

Repository worktree:

```text
C:\Users\O90\.copilot\repos\copilot-worktrees\victron\vadym-zakusylo-silver-robot
```

Session artifacts/checkpoints:

```text
C:\Users\O90\.copilot\session-state\7dff0745-c62e-4ab9-97af-9dc8862c4eb6
```

Backup and reports:

```text
C:\learn\test-gx-data\raw\grid-backup-20261115-011623.tar.gz
C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623
C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623.map.json
C:\learn\test-gx-data\runs\20261115-224009
C:\learn\test-gx-data\runs\20261116-094642
```

The raw backup, raw live snapshots and substitution map are sensitive. The map is adjacent to, not inside, the sanitized build tree. Do not print their values, attach them to PRs, or copy them into an image.

Version facts:

- Node-RED: 3.1.15.
- Dashboard: 3.6.6.
- Tuya palette: 5.4.0.
- `victron-vrm-api`: 0.2.13.
- Backup Victron palette: 1.6.31, unavailable from npm during these runs.
- Installed fallback: 1.6.65; same minor, differing patch, explicitly WARN rather than claimed identical.
- Source synchronization baseline: `d#187`, 277 nodes, 60 sources.
- Backup main tab is older, `d#181`; compare against its own sanitized source, not an assumed identical repository revision.

Windows filesystem commands use backslashes. Use `py -B` for host Python; the Store aliases `python`/`python3` were not reliable. `-B` avoids stray bytecode files.

## 5. History: what was actually completed

### Initial Docker copy and deploy dry run

The initial stack combined `victronenergy/venus-docker` and Node-RED. Upstream issues included CRLF-broken scripts and a failing optional HTML5-app build. The build helper uses Linux-compatible checkout endings and skips that HTML5 stage. The advertised Venus-app port does not establish that its UI works.

SSH needed a separate test key, an unlocked container root account and a test host alias on port 2222. The existing deploy wrapper accepts a host alias rather than a port parameter.

The initial deploy dry run passed steps 1-6, with no code differences. The apply path was initially blocked by the expected safety window because fake heat-pump/DHW data was not yet available. Do not turn that historical dry run into a claim of a completed full apply/verify/rollback rehearsal.

### Backup image and D-Bus/inventory refinements

Step A was delivered in PR #36. Subsequent PRs #38-#42 incrementally improved emulation, readiness, inventory, startup-log rules, context/file classification and live mapping. PR #42 merged at `04f28ab`.

Relevant improvements:

- D-Bus fake system, VE.Bus instance 276 and battery instance 289.
- Identity/device paths needed by the palette and Devices page.
- `python3 py3-dbus` inside Node-RED and the TCP system-bus address.
- Readiness before Node-RED startup.
- Strict classification of startup errors, rather than accepting arbitrary D-Bus failures.
- Separate pure comparison rules and focused tests.
- Original-to-fake live snapshot mapping.

An early checkpoint records accidental exposure of some sensitive backup fields in diagnostic output. No values are repeated here. Treat old diagnostic history as potentially sensitive; any credential-rotation decision belongs to the user.

### Faketime, PR #43

Merged as `507bdbf`.

libfaketime v0.9.13 builds under Alpine/musl. It is enabled only by `TEST_GX_FAKETIME`; normal startup remains real time.

Verified over the completed investigation:

- Node Date and the real 10-second timer.
- Node-RED delay with start and after-delay log markers.
- Actual 06:00 inject.
- Spring and autumn clock transitions and temporary cron checks.
- Admin API adding/removing the temporary probe without removing the main tab.
- Monthly dashboard tier rollover.
- New December energy CSV at the first hour closure.

Intermediate checkpoints contain incomplete results which were superseded by later checks. The 45-day cleanup remains intentionally disabled since d#97: this is not a faketime failure and must not be enabled merely to make a test pass.

Daily automation-log rollover and direct internal tariff-peak reset were not fully established; they remain scenario assertions.

### Qingping MQTT, PR #44

Merged as `4acae3fe32b8bba76a77de7859e3f9b46dcd5e20`.

- Internal pinned `eclipse-mosquitto:2.0.22`, no published host port.
- Sanitized broker endpoint `mosquitto:1883`, TLS disabled.
- `/mqtt` endpoint with publication acknowledgement and explicit failure responses.
- Consistent fake MAC substitution including hardcoded compact MAC literals.
- Inventory coverage for Qingping.
- Strict startup-log allowance for the exact internal MQTT connection only.
- Dashboard Air quality showed all six tested values.
- Broker stopped: 503; restart/recovery, refresh and paired restart: 0 DIFF.

The first Tuya-branch commit, `924f3e1`, closed MQTT review follow-ups: broker-field documentation and missing/incompatible-paho failure handling.

### Four-device Tuya Plan B, PR #45

Main implementation: `e29e56ec398af99869626fb4e326c4d6a096cc2d`.

Image-only MQTT proxies replaced the four native nodes. Native production nodes and numbered sources were unchanged.

Manual checks included:

- Connected pump/valve/bypass/meter with live fake values.
- Dashboard P23 change generated SET DP133.
- Actual 15-minute startup quiet period was waited out, not bypassed.
- Lower tank temperature generated the expected DHW command/valve sequence.
- Pump offline disabled control and paused DHW; no SET attempts during the recorded 35-second observation.
- Fresh image refresh: 0 DIFF and 16 exact transformed IDs EXPECTED.

The sanitized gzip recorder was originally damaged by UTF-8 text handling. That tightly coupled bug was fixed by decompressing, sanitizing, recompressing and scanning decompressed content.

### PR #45 Medium fix and merge

The original unmapped live compare passed production broker `127.0.0.1:1883` to a transform that deliberately requires sanitized `mosquitto`. It threw and aborted the comparison.

Commit `4df7a52d54175d91b38379369c21e14af07984d6`:

- Transform live Tuya nodes only when a map is supplied.
- Without a map, emit `WARN Tuya proxy`.
- Keep raw differences DIFF; comparison exit 1 is correct when differences exist.
- Avoid an exception/exit 2.
- Add CLI-level regression using localhost HTTP and isolated SSH/docker transport mocks.
- Document Low/Note limitations.

Independent rerun: 211/211 tests passed. All current-head CI jobs and Claude review were green; verdict safe to merge, Medium fixed.

On the user's explicit merge assignment:

1. Enumerated review threads with GraphQL.
2. Resolved `PRRT_kwDOSIA3e863uGUg`.
3. Verified no unresolved thread remained.
4. Ran `gh pr merge 45 --merge --delete-branch`.
5. gh skipped local deletion because the branch was checked out.
6. Switched to `master`, fast-forwarded it, deleted the local old branch and created `test-gx-forecast`.
7. Confirmed the remote old branch was absent.

All steps completed without removing the session worktree.

### PR #46: old findings and updated state

This session independently reviewed `96ab06f5fe6d2efe136ad973db433acb7988f8a4`, not the current head.

215/215 tests passed in an isolated Git clone. Two defects were confirmed:

- High: stdout-only local poll stub did not write `tuya-devices-last.json`, which node 50 actually reads. Inventory nevertheless claimed that exec input was emulated. Boiler is already the flow-controlled valve and is excluded from this poller.
- Medium: tank cooling at 0.005 C/s without ambient floor. Reproduced 46 -> 28 C after one hour and 0 C after three hours.

No fixes to PR #46 were made by this session.

During this handoff, PR #46 had advanced to `5f9125c`. Claude reports:

- Stub removed; poller omitted from image with an `omitted` report entry; exec sensors remain planned.
- Phantom boiler MQTT alias removed.
- Tank decays toward 20 C with a 14-day time constant.
- Contradictory fixture and ineffective coverage check revised.
- 215 tests reported passing.
- Safe to merge with two Low findings and Nit observations.

Latest reported Low findings:

1. Poller absence check inspects the sanitized PC directory, not the running container; an old image/volume containing the poller would only receive a generic WARN.
2. Documented DP108 range 0-80 C differs from the real model's -40-120 C.

Nit observations: 36 C/h heating and very slow cooling are simplistic; added `--ssh-key` plumbing is unrelated to boiler scope.

These are external-review observations on the new head, not a fresh independent approval from this session. Do not repeat the old "needs changes" verdict as current, or claim the new head was independently tested here.

## 6. Correct device model and contracts

There is no additional electric "Boiler" socket to invent for this task.

- Tank temperature: `tuya.pump.dps.108`.
- Three-way valve: `tuya.valve.dps.1`, ON routes toward DHW.
- Heating also depends on pump operation and bypass route; valve ON alone does not supply heat.
- Metadata name Boiler refers to the valve relay already controlled by the flow.

Four original native node IDs:

| ID | Emulator role |
|---|---|
| `hp-tuya-pump-01` | pump |
| `hp-tuya-valve-01` | valve |
| `hp-tuya-bypass-01` | bypass |
| `hp-tuya-meter-01` | meter |

Each same-ID proxy preserves its original outputs 1 and 2 and adds output 3 to MQTT command publication. Deterministic additional IDs use `-mqtt-data`, `-mqtt-state`, `-mqtt-out`: four replacements plus twelve additions equals sixteen transformation entries.

MQTT topics: `tuya/<role>/command`, `tuya/<role>/data`, `tuya/<role>/state`.

Contracts verified against palette 5.4.0, consumers, sanitized metadata and recorder:

```javascript
// Flow -> device
{ operation: 'GET', schema: true }
{ operation: 'SET', dps: 133, set: 37 }
{ operation: 'SET', multiple: true, data: { '132': '1', '134': 4 } }

// Proxy data output
{ payload: { data: { dps: { /* device values */ } }, deviceId, deviceName } }

// Proxy state output
{ payload: { state: 'CONNECTED' } } // or CONNECTING / DISCONNECTED / ERROR
```

The meter uses DP6 phase encoding: base64, eight big-endian bytes for voltage/current/power. Optional fallback DPs stay absent by default so the actual phase decoder is exercised.

SET batches are validated atomically. Offline SETs are recorded but not applied. State is retained; data/commands are not retained, avoiding stale retained data falsely marking an offline device connected.

`/writes` records real timestamps plus device, operation, dps, value and applied result. `/reset` does not reset Node-RED controller context.

## 7. Script/file inventory: actions and reasons

| File | Action | Why |
|---|---|---|
| `tools\test-gx\sanitize-backup.js` | Sanitize archive, preserve configured history, rewrite endpoints/identities, transform nodes, scan leftovers | Prevent real credentials/network targets entering the image |
| `tools\test-gx\transform-tuya.js` | Same-ID image-only function/MQTT transformation | Test automation contracts without the native Tuya transport |
| `tools\test-gx\tuya-compare.js` | Recompute/validate exact transformation manifest and mapped live transformation | Do not hide unrelated node/code/wire changes |
| `tools\test-gx\live-map.js` | Apply private original-to-fake substitutions to raw snapshots | Compare intentional sanitization without broad exemptions |
| `tools\test-gx\compare-image.js` | Read image over SSH/admin API; compare flows, versions, hashes/context/logs and optional live snapshot | Report OK/EXPECTED/WARN/DIFF with distinct failure semantics |
| `tools\test-gx\compare-rules.js` | Pure startup-log/runtime-file classification | Focused regression tests; strict error allowance |
| `tools\test-gx\test-gx-refresh.ps1` | Backup -> sanitize -> recreate -> wait -> compare -> reports | Reproducible complete refresh |
| `tools\test-gx\up.ps1` | Build version-matched stack, generate test key if absent, reset volume, start compose | Avoid an old `/data` volume hiding new image contents |
| `tools\test-gx\Dockerfile` | Install SSH/Python D-Bus, matching palette and optional libfaketime | GX-like paths/interfaces with explicit version differences |
| `tools\test-gx\entrypoint.sh` | Start SSH then opt-in faketime for Node-RED | Real-time default; isolated fake clock |
| `tools\test-gx\docker-compose.yml` | Internal Mosquitto, emulator, Node-RED, health dependencies and loopback ports | Isolated test networking and deterministic startup |
| `tools\test-gx\emulator\emulator.py` | D-Bus services, HTTP API, writes, MQTT command subscriber | Controlled inputs and observable outputs |
| `tools\test-gx\emulator\tuya_devices.py` | Device state, validated writes, faults and simple physics | Coherent automation reactions, not hardware accuracy |
| `tools\test-gx\emulator\tuya-model.json` | Shared DPS defaults/ranges/permissions | Model and inventory use the same contract |
| `tools\test-gx\emulator\mqtt_publish.py` | Qingping publish with acknowledgement/error handling | Explicit 503 on broker/dependency failure |
| `tools\test-gx\inventory.js` | Classify input/output coverage and consumed DPS | CI detects newly uncovered interfaces |
| `tools\test-gx\test-faketime.ps1` | Check process clock/timers and add/remove temporary probe | Verify actual Node-RED behavior without production source edits |
| `tools\flows.js` | Source synchronization check | Detect accidental production flow/source divergence |
| `tests\test-gx-*.test.js` | Sanitizer, inventory, mapping, MQTT, proxy/model and CLI regressions | Focused no-Docker tests for introduced behavior |
| `tests\harness.js` | Execute generated function-node code | Test actual proxy function output routing |
| `docs\test-gx.md` | Contracts, limitations, manual results and remaining plan | Preserve evidence and avoid overstated coverage |

The old PR #46 `tools\test-gx\tuya-local-poll.js` stub is not a recommended script: latest review says it has been removed. Do not restore it from the obsolete PR revision.

## 8. Runbook: validation and refresh

Start commands from the repository worktree. `up.ps1` changes the caller's working directory; use absolute paths after calling it or run independent commands in fresh shells.

```powershell
node --test tests\test-gx-tuya.test.js
node --test tests\*.test.js
node tools\flows.js check
git --no-pager diff --check
```

No root package.json exists; do not invent npm build/test commands. No new tooling/dependencies are needed merely to run the existing Node tests.

Complete test-image refresh:

```powershell
Remove-Item Env:TEST_GX_FAKETIME -ErrorAction SilentlyContinue
& .\tools\test-gx\test-gx-refresh.ps1 `
  -BackupFile C:\learn\test-gx-data\raw\grid-backup-20261115-011623.tar.gz
```

This resets the test stack/volume. It is not a read-only command. Do not run it against an unrelated compose project.

Last independently repeated merged-head refresh wrote:

```text
C:\learn\test-gx-data\runs\20261116-094642
DIFF 0, WARN 1
16 exact Tuya transformations EXPECTED
```

Standalone, read-only compare:

```powershell
node tools\test-gx\compare-image.js `
  --backup C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623 `
  --compose tools\test-gx
```

Optional mapped snapshot comparison:

```powershell
node tools\test-gx\compare-image.js `
  --backup C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623 `
  --compose tools\test-gx `
  --live C:\learn\test-gx-data\raw\tuya-live-backup.b64 `
  --map C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623.map.json
```

That named snapshot was reconstructed from the backup, not captured over SSH from the real GX. A future actual live snapshot is a separate read-only access task; permission for test-container SSH does not authorize real-GX SSH.

Compare exit semantics:

- 0: OK/WARN/EXPECTED only.
- 1: actual differences.
- 2: the comparison itself failed.

## 9. Runbook: emulator and clock checks

Test endpoints:

- Node-RED/admin/dashboard: `http://localhost:1881`, `/ui`.
- Emulator: `http://127.0.0.1:8081`.
- Test SSH: port 2222.
- D-Bus TCP: loopback port 3000.
- Mosquitto: compose-internal `mosquitto:1883`, no host publication.

Dashboard routes observed: Heat Pump `#!/8`, data `#!/9`, Devices `#!/13`, Air quality `#!/14`. Do not infer route numbers from tab order.

```powershell
Invoke-RestMethod http://127.0.0.1:8081/state
Invoke-RestMethod http://127.0.0.1:8081/writes
Invoke-RestMethod -Method Post http://127.0.0.1:8081/set `
  -ContentType application/json `
  -Body '{"path":"tuya.pump.dps.108","value":25}'
Invoke-RestMethod -Method Post http://127.0.0.1:8081/fail `
  -ContentType application/json `
  -Body '{"path":"tuya.pump","mode":"offline"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8081/fail `
  -ContentType application/json `
  -Body '{"path":"tuya.pump","mode":"ok"}'
```

Fault modes: offline, invalid, ok. Stale suppresses publications, including GET replies, until cleared. For current merged code, address the tank through pump DP108, not a separate boiler device.

Faketime smoke:

```powershell
& .\tools\test-gx\test-faketime.ps1 `
  -Backup C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623 `
  -FakeTime '@2026-03-29 01:50:00' -DelaySeconds 10
```

Short month-rollover check uses first day 00:59, because the CSV is written at hour closure:

```powershell
& .\tools\test-gx\test-faketime.ps1 `
  -Backup C:\learn\test-gx-data\sanitized\grid-backup-20261115-011623 `
  -FakeTime '@2026-12-01 00:59:00' `
  -ObserveSeconds 90 -CheckMonthRollover
```

Required Node-RED process environment:

```text
TEST_GX_FAKETIME=@YYYY-MM-DD HH:mm:ss
FAKETIME=@YYYY-MM-DD HH:mm:ss
FAKETIME_DONT_FAKE_MONOTONIC=1
LD_PRELOAD=/usr/local/lib/faketime/libfaketimeMT.so.1
TZ=Europe/Oslo
```

The entrypoint supplies the derived variables. Fake realtime, not monotonic time. The `@` form advances at ordinary speed; acceleration has not been validated.

Temporary probe procedure:

1. GET the current flow set and identify the main tab.
2. POST `/flow` with `{label,nodes}`, not a replacement POST `/flows`.
3. Preserve nested output-wire arrays with JSON serialization depth or a JSON file.
4. Use inject once -> start marker -> delay -> after-delay marker.
5. Use `node.warn`; default debug goes to the editor sidebar, not container logs.
6. Check markers and real elapsed time.
7. DELETE `/flow/<returned-id>`.
8. Verify main tab and original nodes still exist.

Under faketime, sshd was started before preload. SSH processes see real time while Node-RED/exec children see fake time. `verify.js` log-since-deploy filtering therefore needs caution.

## 10. Runbook: GitHub and local Git

All GitHub operations use the explicitly requested gh CLI. Browser viewing uses Edge/Playwright, not browser actions for repository mutations.

The app account lacked repository access; stored CLI authentication worked after removing conflicting inherited environment credentials in the command process:

```powershell
Remove-Item Env:GH_TOKEN,Env:GITHUB_TOKEN,Env:GH_ENTERPRISE_TOKEN,Env:GITHUB_ENTERPRISE_TOKEN,Env:GH_HOST `
  -ErrorAction SilentlyContinue
```

Do not print token values or alter unrelated credentials.

```powershell
gh pr list --repo vzakusylo/victron --state open `
  --json number,title,headRefName,headRefOid,url
gh pr view 46 --repo vzakusylo/victron `
  --json state,headRefOid,statusCheckRollup
gh pr diff 46 --repo vzakusylo/victron --name-only
gh pr diff 46 --repo vzakusylo/victron --color never
gh pr checks 46 --repo vzakusylo/victron
```

`gh pr diff --stat` failed with `unknown flag: --stat`; use `--name-only` or a local Git diff stat instead.

Existing push pattern:

```powershell
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push
```

Commit message trailer used:

```text
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

PR creation is only after the one-open-PR and validation gates:

```powershell
gh pr create --repo vzakusylo/victron --base master --head <branch> `
  --title "<scoped title>" --body-file <prepared-body-file>
```

Wait for current-head checks; then read review text. A successful review workflow does not itself mean the reviewer approved the code:

```powershell
gh pr checks <number> --repo vzakusylo/victron --watch --interval 15
gh api repos/vzakusylo/victron/issues/<number>/comments `
  --jq '.[-1] | {body,updated_at}'
```

Historical PR #45 thread enumeration:

```powershell
gh api graphql -f query='query {
  repository(owner:"vzakusylo",name:"victron") {
    pullRequest(number:45) {
      reviewThreads(first:100) {
        nodes { id isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'
```

Historical authorized resolution:

```powershell
gh api graphql -f query='mutation {
  resolveReviewThread(input:{threadId:"PRRT_kwDOSIA3e863uGUg"}) {
    thread { id isResolved }
  }
}'
```

Paginate if `hasNextPage` is true. Do not reuse a thread ID for another PR.

Historical authorized merge/cleanup:

```powershell
gh pr merge 45 --merge --delete-branch
gh pr view 45 --json state,mergeCommit
git checkout master
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' pull --ff-only
git branch -d test-gx-tuya-devices
git checkout -b test-gx-forecast
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' `
  ls-remote --heads origin test-gx-tuya-devices
```

gh warned that local deletion was skipped while the branch was checked out. Switching first and then deleting resolved it. Do not follow a suggested worktree-removal command: this session's workspace must remain intact.

## 11. Review workflow used and improvements

For PR #46:

1. Read exact head SHA, PR metadata, CI and complete diff.
2. Read Claude's actual findings, not just green job status.
3. Trace the changed poller into the unchanged node-50 consumer and file contract.
4. Test the exact revision in a separate copy, preserving the active forecast worktree.
5. Reproduce the cooling result directly through the model.
6. Report evidence and severity without editing or merging the PR.
7. Remove only the two explicitly named temporary review directories.

An initial tarball-only test run failed:

```text
fatal: not a git repository (or any of the parent directories): .git
```

Some existing tests require Git metadata. Recovery used a local Git clone, set its origin to the repository, then `gh pr checkout 46`. The clone's HEAD was explicitly confirmed as `96ab06f` before running tests.

Preferred next-time isolated review pattern:

```powershell
# Use a fresh, explicitly named temporary destination outside the main checkout.
git clone --quiet --no-hardlinks . <review-directory>
git -C <review-directory> remote set-url origin https://github.com/vzakusylo/victron.git
Push-Location <review-directory>
gh pr checkout <number> --repo vzakusylo/victron
git rev-parse HEAD
node --test tests\*.test.js
node tools\flows.js check
Pop-Location
```

Check authentication in that process before checkout. Capture the test exit status before another command overwrites `$LASTEXITCODE`. Delete only the known temporary copy when finished.

## 12. Known limitations and evidence distinctions

- Real GX SSH comparison was not performed for the cited Tuya validation.
- Plan B validates automation contracts, not the native palette or local Tuya protocol.
- Full production-like apply/verify/rollback rehearsal is not established by the old dry-run result.
- Existing backup dashboard Angular `ng-style`/unquoted `vertical-align` error and loading.html 404 were not fixed here.
- Palette patch mismatch remains WARN.
- Missing old/manual `sanitize-report.json` gives ENOENT rather than a dedicated diagnostic.
- Tuya data publication at 1 Hz differs from the real event/poll cadence.
- Persistent paho constructor diagnostics can be improved.
- With DP132 enabled, physics overwrites a manually SET DP125 on the next tick.
- libfaketime is pinned to mutable tag v0.9.13, not a verified immutable commit.
- Midnight historical-log cleanup is intentionally disabled.
- Fake-time business assertions around DST/month boundaries are not all covered by automated scenarios.
- Old checkpoints contain superseded intermediate limitations. Use current files/results before declaring an old issue still open.
- Claude incorrectly said the PR #45 tick/phase-A test was absent; the existing Python-backed test exercises tick, meter DP6 encoding and heating route.

## 13. Next-agent action checklist

Before implementation:

1. Refresh PR #46 head and read latest review/inline comments.
2. If assigned to re-review, inspect and test `5f9125c` or its successor independently.
3. Verify actual container poller absence, not only absence in the sanitized PC tree, if validating that safety property.
4. Reconcile the documented DP108 range with the intended model validation range.
5. Do not make a new forecast PR while #46 remains open.
6. Confirm the current branch/worktree is clean and based on the intended merged prerequisite.

For forecast work, when assigned:

- Read the actual HTTP request node and downstream response parser first.
- Capture the required real API response shape without credentials.
- Add sunny/cloudy/snow fixtures using that shape.
- Redirect only sanitized-image URLs to the emulator.
- Extend exact transformation comparison and inventory.
- Add success, malformed response, unavailable/stale and consumer-contract tests.
- Verify actual UI/controller reaction, not merely HTTP 200.
- Refresh/compare, run current-head CI and read the review verdict before reporting readiness.

For scenarios:

- Keep scenario start clock explicit.
- Distinguish simulator time from real monotonic waiting time.
- Record outputs and assert invariants throughout the scenario, not only the final state.
- Include grid/current ceilings and write-rate limits.
- Preserve real startup/defrost guards unless the scenario explicitly tests those guards.
- Use deliberate tank draw-off inputs rather than unrealistic continuous cooling.
- Fail on uncovered input/model interfaces instead of relabeling missing coverage "emulated."

## 14. Efficiency and token-use improvements

These are workflow improvements based on observed work, not measured token-cost claims.

1. **Pin evidence to SHA.** Record the tested head once and re-check only when it changes. PR #46 changed during this handoff; that invalidates carrying forward the old verdict.
2. **Inspect scope first.** Read title/body, changed filenames and checks before loading a full patch. This avoids reading the nearly 1 MB production flow unnecessarily.
3. **Separate diff from review output.** Combining both produced a 36.9 KB spill file. Separate bounded reads make findings easier to attribute.
4. **Read ranges/symbols, not whole files.** Trace a concrete producer/consumer contract and only its relevant functions.
5. **Batch independent reads.** Metadata, distinct files and unrelated test/status checks can run together; mutations and dependent operations stay ordered.
6. **Use focused tests first.** Run the Tuya file after a Tuya change, then the full suite at the commit/PR gate.
7. **Use read-only compare before refresh when appropriate.** Refresh resets the test volume and rebuilds; do not use it for every metadata question.
8. **Suppress successful bulk logs, preserve failures.** Keep test totals, SHA, report directory, DIFF/WARN counts and actual stderr. Do not suppress the exit code.
9. **Watch checks rather than repeatedly manually polling.** Read the finished current-head review once.
10. **Use a Git review clone from the start.** Avoid the failed tarball approach for Git-dependent suites.
11. **Reuse verified helper modules.** Shared manifest validation and pure comparison rules are cheaper and safer than duplicated exceptions.
12. **Keep a compact state register.** Branch, HEAD, PR head, tested SHA, CI verdict, manual evidence, limitations and next action prevent repeated discovery.
13. **Keep raw output in artifacts.** Put detailed reports outside Git; hand off summaries and precise paths, not secrets or enormous logs.
14. **Do not delegate simple known-file reads.** Separate contexts are useful only for substantial independent work, not a single producer/consumer trace.
15. **Ask only for decisions that change work.** Permission requests are now recorded individually; do not infer that they authorize unrelated production actions.
16. **Do not optimize by weakening checks.** Broad EXPECTED rules, mocked hardware claims, skipped safety guards and green-job-only approval save tokens at the cost of correctness.

## 15. What happened while writing this handoff

Only read-only repository/GitHub/checkpoint inspection, permission questions and this session-artifact creation were needed. No production deployment, PR merge, test-volume reset or new implementation was performed as part of this handoff task.

The user answered all twelve second-round permission questions with Allow. Their scoped decisions are recorded in section 3. No global/repository agent instruction file was changed.

Use this document alongside `docs\test-gx.md` and fresh current-head metadata. It is a handoff snapshot, not a guarantee that future branch or review state remains unchanged.
