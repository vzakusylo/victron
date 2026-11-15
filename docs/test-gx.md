# Test GX: a Cerbo copy in Docker for tests and deploy rehearsal

A Cerbo GX runs Venus OS (Linux, ARM) with Victron services on D-Bus and Node-RED. Victron publishes no Docker image of the whole Venus OS, so the copy is built from parts. It lives in `tools/test-gx/`.

| GX part | In the copy | Faithful? |
|---|---|---|
| Node-RED, our flow, dashboard | `nodered/node-red` image with the Node-RED and palette versions of the GX backup | Yes (palette patch version may differ, see traps) |
| `/data/home/nodered/...` files (`tools/`, `grid-control-config/`, logs) | Copied from a **sanitized** GX backup | Yes, secrets replaced by fakes |
| SSH as `root`, admin API | sshd in the same container | Yes, `tools/gx/*` and `scripts/gx-*.ps1` run unchanged |
| Victron D-Bus services | [`victronenergy/venus-docker`](https://github.com/victronenergy/venus-docker), simulation `e` (MultiPlus + BMV) | Partly: demo values, other device instances |
| Tuya devices, Qingping, solar forecast | Not connected | No (step B) |
| Real hardware, ARM specifics | Not available | No |

It proves that the flow loads, function nodes run, the dashboard renders and the deploy chain (`live-snapshot` → `compare` → `deploy` → `verify`) works. It does **not** prove that the inverter or battery react correctly: that is still checked on the real GX with the monitor.

## Safety rules

1. A real backup holds secrets (Tuya keys, mail password, MCP token). It stays in `C:\learn\test-gx-data\raw\`, **outside the repository and outside Docker**. `test-gx-refresh.ps1` refuses paths inside the repository.
2. Only the output of `sanitize-backup.js` goes into an image. It replaces every secret by a deterministic fake, deletes `flows_cred.json` and the Node-RED user files, and stops with exit code 3 if anything that still looks like a secret is left. Never copy real secret files in by hand.
3. The test GX has its own SSH key (`tools/test-gx/test_key`, git-ignored), not the key of the real GX.
4. The dashboard tab label ends with `TEST-GX`, so a screenshot cannot be mistaken for the live system.
5. Never print secret values into a log or a chat.

## Quick start

Needs Docker Desktop, Node.js and PowerShell 7.

```powershell
# 0. once: ssh alias (scripts/gx-deploy.ps1 accepts only user@host, the port goes into the ssh config)
#    ~/.ssh/config
#      Host test-gx
#          HostName 127.0.0.1
#          Port 2222
#          User root
#          IdentityFile <repo>\tools\test-gx\test_key
#          IdentitiesOnly yes
#          StrictHostKeyChecking accept-new
#          UserKnownHostsFile ~/.ssh/known_hosts_test_gx

# 1. everything: newest backup in C:\learn\test-gx-data\raw -> sanitize -> rebuild -> compare
.\tools\test-gx\test-gx-refresh.ps1

# with access to the real GX: download the newest backup and also compare the image with the live flow (read-only on the GX)
.\tools\test-gx\test-gx-refresh.ps1 -GxHost root@<gx> -SshKey <key>
```

Result: Node-RED `http://localhost:1881`, dashboard `http://localhost:1881/ui`, `ssh test-gx`, and a report in `C:\learn\test-gx-data\runs\<date>\` ending with `STATUS: OK / WARN / FAIL`.

Pieces, to run separately:

| Script | What it does |
|---|---|
| `up.ps1 [-Backup <sanitized dir>] [-Down]` | Builds the Venus simulator image (patched, see traps) and the Node-RED image, starts both |
| `sanitize-backup.js <tar.gz> <outDir> [--days 14] [--no-logs]` | Backup → sanitized tree + `versions.json` + `sanitize-report.json` |
| `snapshot-file.js flows.json` | Same snapshot as `tools/gx/live-snapshot.js`, from a file |
| `compare-image.js --backup <dir> [--live live.b64]` | Table `OK / WARN / DIFF / EXPECTED`, exit 0 / 1 / 2 |
| `node tools/gx/compare.js a.b64 --against b.b64` | Snapshot against snapshot |

### What `compare-image.js` checks

| Check | Rule |
|---|---|
| Flow (image vs backup, and vs live GX with `--live`) | No code differences; Tuya config differences are EXPECTED |
| Node-RED and palette versions | Equal; same minor but other patch → WARN |
| Files in `tools/`, `grid-control-config/` | SHA-256 equal; state files the flow rewrites → WARN |
| Global context keys | Compared when the backup has a context store |
| Start log | No error except the known ones: fake Tuya keys, missing D-Bus paths in the simulator |
| Revision, tab label and git commit (with `--live`) | Differ → WARN: a deploy happened after the backup, take a new one |

## Rehearse a deploy

```powershell
.\scripts\gx-deploy.ps1 -GxHost root@test-gx -SshKey tools\test-gx\test_key           # dry run
.\scripts\gx-deploy.ps1 -GxHost root@test-gx -SshKey tools\test-gx\test_key -Apply    # on the test GX this is safe
```

The window check says WAIT until the emulator provides DHW state, valve, bypass and fault-code data (step B).

## Traps

- **Volume hides the image.** The named volume `gx-data` is mounted on `/data` and hides the files copied into the image. `up.ps1 -Down` removes it; always use it before building a new backup.
- **ID starting with a digit.** Flow code uses ids as bare object keys (`{ 6ca39...: {...} }`). A fake id that starts with a digit is a syntax error, so the sanitizer makes fake ids start with a letter.
- **Palette not on npm.** `@victronenergy/node-red-contrib-victron@1.6.31` is not published; `up.ps1` falls back to `~1.6` and warns. Versions then differ from the GX (WARN).
- **venus-docker.** Clone with `core.autocrlf=false` (CRLF breaks the `#!` scripts). The HTML5-app stage fails upstream and is removed by `up.ps1`, so the Venus app on `:8080` does not work. D-Bus over TCP is on port 3000; the palette reads it from `NODE_RED_DBUS_ADDRESS=venus:3000`.
- **Device instances.** The flow expects `com.victronenergy.battery/289` and `vebus/276`; the simulator uses others. This produces `DBUS ERROR UnknownObject`, "not found in cache" and `Set error status`. Never change the instance in the flow: the test would no longer match the real GX. The fix is step B (own D-Bus services).
- **sshd as root.** The Alpine image needs `apk add --upgrade openssh openssh-server bash curl`, an unlocked root account and a key without passphrase. The host key changes with every image, so `~/.ssh/known_hosts_test_gx` is separate and deleted by the refresh script.
- **Restart order.** Node-RED must start after the simulator is up, otherwise the palette finds no services.

## Status

| Step | State |
|---|---|
| A1 backup stored outside the repository | done |
| A2 sanitizer with leftover-secret scan | done |
| A3 versions from the backup | done (`versions.json`) |
| A4 image from the sanitized tree | done |
| A5 compare image with backup / with live GX | done; the live GX comparison needs SSH access to the GX and is not yet exercised |
| A6 `test-gx-refresh.ps1` | done |
| B sensor emulation and scenarios | planned |

## Step B (planned): sensor emulation and scenario tests

Goal: every input of the flow gets a value that a test controls, every output is recorded, and YAML scenarios say "given these inputs over time, the automations must do this". Estimate 9–12 working days.

1. **Inventory** (`inventory.js`): generated from `flows.json` (Victron D-Bus: 7 inputs, 4 outputs; 4 Tuya devices; Tuya cloud scripts; Qingping MQTT; solar forecast HTTP; 29 inject nodes). CI fails when a new input type is not covered by the emulator.
2. **Emulator** with an HTTP API (`/state`, `/set`, `/stale`, `/fail`, `/writes`, `/reset`):
   - Victron D-Bus: fake services (`system`, `battery` instance 289, `vebus` 276, `settings`) with simple physics; every write the flow makes is recorded.
   - Tuya: local-protocol stub; fallback: a test-image transform that replaces each Tuya node by an MQTT pair with the same id and wires.
   - Qingping via mosquitto, solar forecast from fixtures, scenario start time via `libfaketime` (check early that it works with Node.js timers; fallback: start at real time).
3. **Scenarios** (`scenarios/*.yml`): initial state, steps, expectations, plus rules that hold all the time (grid limit, current limit, at most N writes per minute). Areas: tariff, battery, solar, DHW and shower, sensor failures, midnight, DST, month change, dashboard console errors.
4. **Runner**: runs all scenarios and writes a JUnit report. Every change passes the scenarios, then the deploy rehearsal, then CI, and only then goes to the real GX. A bug found on the real GX first gets a scenario that reproduces it, then the fix.

Risks: `libfaketime` with Node.js timers; the Tuya protocol stub may be costly; the victron palette may need D-Bus paths that the emulator lacks.
