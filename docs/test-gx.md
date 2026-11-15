# Test GX: a Cerbo copy in Docker for tests and deploy rehearsal

A Cerbo GX runs Venus OS (Linux, ARM) with Victron services on D-Bus and Node-RED. Victron publishes no Docker image of the whole Venus OS, so the copy is built from parts. It lives in `tools/test-gx/`.

| GX part | In the copy | Faithful? |
|---|---|---|
| Node-RED, our flow, dashboard | `nodered/node-red` image with the Node-RED and palette versions of the GX backup | Yes (palette patch version may differ, see traps) |
| `/data/home/nodered/...` files (`tools/`, `grid-control-config/`, logs) | Copied from a **sanitized** GX backup | Yes, secrets replaced by fakes |
| SSH as `root`, admin API | sshd in the same container | Yes, `tools/gx/*` and `scripts/gx-*.ps1` run unchanged |
| Victron D-Bus services | [`victronenergy/venus-docker`](https://github.com/victronenergy/venus-docker), simulation `e` (MultiPlus + BMV) | Partly: demo values, other device instances |
| Qingping MQTT | Internal Mosquitto + emulator `/mqtt` publications | Real MQTT and flow parsing; synthetic readings |
| Tuya devices, solar forecast | Not connected | No (later step B) |
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
| `up.ps1 -Backup <sanitized dir>` / `up.ps1 -Down` | Builds the Venus simulator image (patched, see traps) and the Node-RED image, starts them with an internal Mosquitto broker |
| `sanitize-backup.js <tar.gz> <outDir> [--days 14] [--no-logs]` | Backup → sanitized tree + `versions.json` + `sanitize-report.json`, and **beside** `<outDir>` the secret `<name>.map.json` (original → fake) |
| `snapshot-file.js flows.json` | Same snapshot as `tools/gx/live-snapshot.js`, from a file |
| `compare-image.js --backup <dir> [--live live.b64 [--map <name>.map.json]]` | Table `OK / WARN / DIFF / EXPECTED`, exit 0 / 1 / 2 |
| `node tools/gx/compare.js a.b64 --against b.b64` | Snapshot against snapshot |

### Comparing with the live GX: the map

The sanitizer rewrites device ids, addresses, MACs and e-mails, so a live snapshot differs from the image in exactly those nodes. `<name>.map.json` lists the pairs, so `--live` can replace the originals in the live snapshot with the fakes before comparing (never the other way round). With the map, an exact copy gives 0 DIFF; without `--map` a WARN says that DIFF on rewritten nodes is expected.

- The map is **secret** (it holds the originals). It is written next to the sanitized tree, never inside it, so it never reaches the Docker build context, and never inside the repository. The report and the console show counts per kind only.
- If sanitization stops (`STOPPED` or `FAILED`), do not use the output; remove `$out` before retrying. The script removes the adjacent map automatically.
- `live-snapshot.js` hashes node config into `rest`, which cannot be rewritten. Take the snapshot with `node - --raw` (as `test-gx-refresh.ps1 -GxHost` does): it adds the config text of each node, so the map can be applied and the hash recomputed. That `live.b64` holds real ids: keep it outside the repository.
- WARN `not in map`: ids, addresses or e-mails in the live code that are neither in the map nor already in the image. A device or setting was added on the GX after the backup: take a new backup.
- WARN `without restJson`: the snapshot was taken without `--raw`; config of rewritten nodes will differ.
- MQTT config is a deliberate test endpoint transform: the sanitizer sets `mqtt-broker` to `mosquitto:1883` without TLS. With `--live --map`, comparison applies the same endpoint transform only for matching broker nodes in the sanitized backup, keeping all other properties checked. MACs in function-code literals are mapped too; colon-separated and compact forms of the same identity receive matching fake MACs.

### Sanitizer limitations

- The `replaced N <kind>` count is a count of occurrences: the same value may be counted in both `code` and `restJson`.
- After `STOPPED`, `sanitize-report.json` still names `<name>.map.json`, although the sanitizer removes that map and does not create it.
- The cleanup instruction above used to ask the operator to delete the map even though the script already deletes it. It is harmless but redundant.

### What `compare-image.js` checks

| Check | Rule |
|---|---|
| Flow (image vs backup, and vs live GX with `--live --map`) | No code differences; Tuya config differences are EXPECTED |
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

- **Temporary probes and PowerShell wires.** Add probes with `POST /flow`, not `POST /flows` (which replaces the flow set); remove them with `DELETE /flow/<id>`. Keep the main `d#...` tab id and label unchanged before and after. Build each output as a nested array, for example `$wires = ,([string[]]@($targetId))`, then serialize with `ConvertTo-Json -Depth 10`: sufficient depth alone does not restore arrays already flattened by PowerShell. Use `node.warn` for console markers; debug defaults to the editor sidebar.
- **Volume hides the image.** The named volume `gx-data` is mounted on `/data` and hides the files copied into the image. `up.ps1 -Down` removes it; always use it before building a new backup.
- **ID starting with a digit.** Flow code uses ids as bare object keys (`{ 6ca39...: {...} }`). A fake id that starts with a digit is a syntax error, so the sanitizer makes fake ids start with a letter.
- **Palette not on npm.** `@victronenergy/node-red-contrib-victron@1.6.31` is not published; `up.ps1` falls back to `~1.6` and warns. Versions then differ from the GX (WARN).
- **venus-docker.** Clone with `core.autocrlf=false` (CRLF breaks the `#!` scripts). The HTML5-app stage fails upstream and is removed by `up.ps1`, so the Venus app on `:8080` does not work. D-Bus over TCP is on port 3000; the palette reads it from `NODE_RED_DBUS_ADDRESS=venus:3000`.
- **Device instances.** The flow expects `com.victronenergy.battery/289` and `vebus/276`. With `-Sim emu` the emulator publishes its own services with exactly these instances; the stock simulator uses others, which gives `DBUS ERROR UnknownObject`, "not found in cache" and `Set error status`. Never change the instance in the flow: the test would no longer match the real GX.
- **sshd as root.** The Alpine image needs `apk add --upgrade openssh openssh-server bash curl`, an unlocked root account and a key without passphrase. The host key changes with every image, so `~/.ssh/known_hosts_test_gx` is separate and deleted by the refresh script.
- **One `UnknownObject` at start is expected.** The victron palette reads `/DeviceInstance` on `com.victronenergy.settings` during service discovery and localsettings has no such path (found with `dbus-monitor`). The start-log check accepts one such line per start (the log keeps all starts), only right after "Polling is disabled", skipping blank lines and the specific successful `mqtt://mosquitto:1883` connection message that can interleave the D-Bus log. Other intervening lines and any other `UnknownObject` are reported as unknown errors.
- **Emulated identity paths.** Every fake service has `/CustomName`, `/Serial` (`HQEMU0001`) and `/FirmwareVersion` (`0x0510`); vebus has `/VebusError`, battery has `/Dc/0/Temperature`. They feed the Devices page (`dv-exec-01`), so the inventory gives no WARN.
- **Python D-Bus in the Node-RED image.** The Devices page reads Victron devices with `python3` + `dbus` (`dv-exec-01`). The image installs `py3-dbus` and sets `DBUS_SYSTEM_BUS_ADDRESS=tcp:host=venus,port=3000`; without them the page shows "python dbus module: No module named 'dbus'" instead of the Victron devices. Dashboard tab numbers in the URL (`/ui/#!/<n>`) do not match the `ui_tab` order in `/flows`: Devices is `#!/13`.
- **Restart order.** Node-RED must start after the simulator is up, otherwise the palette finds no services. The venus healthcheck (`emulator/healthcheck.sh`) passes only when the emulator API answers, which happens after all fake services are registered. Node-RED does not reconnect to a restarted simulator (`ServiceUnknown`): restart both, `docker compose -p test-gx restart venus nodered`. Until the emulator is ready both GET and POST answer 503; it is ready when the signal of its own startup write arrives (that write never shows in `/writes`), or after 10 s with `ready by timeout, startup write signal not seen` in its log. If the signal arrives after that timeout, the `-1` write to `MaxChargeCurrent` does appear in `/writes` (a rare, accepted trade-off) and the log says `late startup signal recorded as write`. `EMU_READY_DELAY=<s>` holds it in 503 for a test; `tools\test-gx\test-emulator-ready.ps1` uses it to check 503 then 200. It is a manual check (needs Docker): CI runs only `node --test`, so the 503 behaviour is not covered by CI.

## Clock

The Node-RED image is Alpine 3.18 (musl); its configured repositories do not contain `libfaketime`. The Dockerfile builds upstream `libfaketime` v0.9.13 against musl and keeps only `libfaketimeMT.so.1`. The entrypoint enables it only when `TEST_GX_FAKETIME` is non-empty. In that case Node-RED receives `FAKETIME=<value>`, `LD_PRELOAD=/usr/local/lib/faketime/libfaketimeMT.so.1` and `FAKETIME_DONT_FAKE_MONOTONIC=1`. Without the variable it runs on real time. Venus and the D-Bus emulator are separate containers and remain on real time.

SSH processes use real time because sshd starts before the preload is exported; use `verify.js` cautiously under faketime, as its "since deploy" log filter compares different clocks. The smoke script leaves `TEST_GX_FAKETIME` in the calling shell: after success or failure, run `Remove-Item Env:TEST_GX_FAKETIME -ErrorAction SilentlyContinue` before a real-time `up.ps1` run (the existing container stays on fake time until recreated). The library is pinned to a release tag, not an immutable commit SHA; tag rewriting remains a reproducibility limitation. Probe cleanup failures can mask the original smoke-check error.

Use the manual smoke script; it rebuilds the test GX from a sanitized backup and removes the test volume:

```powershell
.\tools\test-gx\test-faketime.ps1 -Backup C:\learn\test-gx-data\sanitized\<name> `
  -FakeTime '@2026-03-29 01:50:00'

# To observe the real flow around its 06:00 cron tick:
.\tools\test-gx\test-faketime.ps1 -Backup C:\learn\test-gx-data\sanitized\<name> `
  -FakeTime '@2026-03-30 05:59:30' -ObserveSeconds 40

# Verify the first closed hour of a new month (start at 00:59):
.\tools\test-gx\test-faketime.ps1 -Backup C:\learn\test-gx-data\sanitized\<name> `
  -FakeTime '@2026-12-01 00:59:00' -ObserveSeconds 80 -CheckMonthRollover
```

`@YYYY-MM-DD HH:mm:ss` means start at that local time and advance at normal speed; accelerated time (`x10`) is not enabled. The smoke script checks the Node process's `Date`, a `setTimeout` backed by Node/libuv monotonic time, Node-RED health/startup, and that emulator write timestamps remain close to the host clock. It does not import a test tab into the repository's `flows.json`.

| Check | Result |
|---|---|
| `Date` at `@2026-03-29 01:50:00` | PASS; Node-RED startup and Node report the requested Europe/Oslo time |
| 10-second timer | PASS; Node timer completed in about 10 real seconds with `FAKETIME_DONT_FAKE_MONOTONIC=1` |
| `DAY 06:00` inject | PASS; starting the real flow at `@2026-03-30 05:59:30` produced the expected D-Bus writes after the tick |
| Spring DST wall clock | PASS; `01:59:59` → `03:00:00` |
| Fall DST wall clock | PASS in Node-RED function logs; the local prefix moved from `02:59` to `02:00` |
| Fall repeated-hour cron | No duplicate; a temporary `02:00` cron added after the first `02:00` had passed did not fire in the repeated hour |
| Node-RED `delay` flow | PASS; temporary `POST /flow` tab logged both `node.warn` markers 10.0 real/fake seconds apart, then `DELETE /flow` removed it while preserving the main tab |
| 22:00 schedule | PASS; a temporary inject using the same cron expression fired once at 22:00 on 2026-10-25, after the autumn change. This confirms the scheduler tick, not the main flow's business effects |
| Duplicate 06:00 / 22:00 / midnight business effects | NOT TESTED; the temporary 22:00 marker fired once, but business effects were not checked for duplicates |
| Midnight cleanup | N/A; disabled in the flow since d#97 to keep the full history, as documented in [control logic](control-logic.md#energy-history-files). The smoke script explicitly refuses this check when either node is disabled. |
| Month tier reset | PASS; dashboard changed from November tier 2 with 16 days tracked to December tier 1 with 1 day tracked after midnight |
| New monthly CSV | PASS; `energy-2026-12.csv` was written with its `2026-12-01 00` row when the first December hour closed |
| New daily automation log | NOT VERIFIED; no non-empty `automations/2026-12-01.jsonl` appeared in the short midnight run. Controlled automation events and daily log rollover remain for sensor scenarios |
| Monthly tariff maximum in context | NOT VERIFIED directly; dashboard month/tier rollover passed, but internal `tariffMonth.dayPeaks` reset was not inspected. Add an assertion in the scenario runner |
| D-Bus emulator timestamps | PASS; writes remain near real time |
| Node-RED startup and healthcheck | PASS; admin API accepted a flow deploy (HTTP 200) |

These are manual checks, not CI coverage. The temporary probe must use `POST /flow` / `DELETE /flow/<id>` so it does not replace the main flow; its `wires` arrays must remain two-dimensional. It uses `node.warn` because a debug node normally writes only to the editor sidebar. The first attempt used a full deployment and flattened wires, so the nodes appeared in `GET /flows` but were not connected. The main tab is checked both before and after the probe. Cron was checked on the actual 06:00 inject; a test-only 02:00 cron did not run in the repeated hour because its first scheduled time had already passed. A temporary inject with the same 22:00 schedule logged exactly one tick on the autumn-change date; this verifies the cron scheduler, not the main flow's business effect. The disabled midnight cleanup could not be tested as a main-flow action. The month rollover check starts at 00:59 because the new monthly CSV is written only when the first hour closes at 01:00. Backdating also makes the real HTTPS certificate for `api.forecast.solar` appear not-yet-valid; stub the forecast endpoint during clock scenarios. External processes started by Node-RED inherit `LD_PRELOAD`; their behavior with fake time has not been validated.

## Status

| Step | State |
|---|---|
| A1 backup stored outside the repository | done |
| A2 sanitizer with leftover-secret scan | done |
| A3 versions from the backup | done (`versions.json`) |
| A4 image from the sanitized tree | done |
| A5 compare image with backup / with live GX | done; the live GX comparison needs SSH access to the GX and is not yet exercised |
| A6 `test-gx-refresh.ps1` | done |
| B1 test-GX image, D-Bus emulator, inventory and live comparison | done |
| B2 `libfaketime` clock smoke test | done; `Date`, delay, cron, DST and month rollover checked; midnight cleanup is intentionally disabled since d#97 |
| B3 Qingping MQTT | done; internal broker and emulator `/mqtt`, real Air quality dashboard verified |
| B4 forecast, Tuya and automated scenarios | planned |

## Qingping MQTT

Compose runs `eclipse-mosquitto:2.0.22` with no host port and an explicit anonymous listener inside the test network. Node-RED and the emulator start only after the broker is healthy. The sanitizer redirects MQTT broker config to `mosquitto:1883`; rerun refresh for older sanitized trees.

Publish through `POST http://127.0.0.1:8081/mqtt`. Only `qingping/<fake MAC>/up` topics with a `02:00` prefix (colon-separated or compact) are accepted; wildcards, real MACs, non-object payloads and mismatching payload MACs give HTTP 400. Payloads are limited to 256 KiB. HTTP 200 means a QoS 1 broker acknowledgement, not that the dashboard rendered; connection/publication failures return 503 and are logged. Publications are not retained.

Use the fake MAC from the adjacent secret map locally, never copy the map into the image or repository:

```powershell
$map = Get-Content 'C:\learn\test-gx-data\sanitized\<name>.map.json' -Raw | ConvertFrom-Json
# Select the entry for Qingping's compact MAC from the live Devices model.
$mac = ($map.pairs | Where-Object { $_.kind -eq 'mac' -and $_.from -eq '<original compact MAC>' }).to
$body = @{
  topic = "qingping/$mac/up"
  payload = @{
    type = 12; mac = $mac; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    sensorData = @(@{
      co2 = @{ value = 678 }; pm25 = @{ value = 4.5 }; pm10 = @{ value = 8.2 }
      tvoc = @{ value = 99 }; temperature = @{ value = 22.4 }; humidity = @{ value = 46.7 }
    })
  }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post 'http://127.0.0.1:8081/mqtt' -ContentType 'application/json' -Body $body
```

In Edge, Air quality (`/ui/#!/14` for the current backup) displayed all six published values; the flow also appended the reading to its daily air CSV. Node tests cover MAC mapping, the MQTT endpoint transform and publisher validation/acknowledgement failures without Docker (Python 3 is needed: `py` on Windows, `python3` on Linux). Broker-failure/recovery and image comparison are manual Docker checks.

The inventory marks `qingping/+/up` as emulated and rejects new MQTT input topics until a publisher covers them. Manual checks confirmed HTTP 400 for a wildcard topic, 503 with Mosquitto stopped, and successful publication after recovery. Image comparison gave 0 DIFF; fresh refresh and paired Venus/Node-RED restart warned only about the palette patch mismatch. A longer run also warned about runtime changes in `compressor-resource.json`. Click Refresh on Air quality to read newly appended samples.

## Next: sensor scenarios and runner

Goal: every remaining input of the flow gets a value that a test controls, every output is recorded, and YAML scenarios say "given these inputs over time, the automations must do this". The D-Bus image, inventory, `/writes` and Qingping `/mqtt` are implemented; forecast fixtures, the Tuya stub and automated scenarios remain.

1. **Inventory** (`inventory.js`): generated from `flows.json` (Victron D-Bus: 7 inputs, 4 outputs; 4 Tuya devices; Tuya cloud scripts; Qingping MQTT; solar forecast HTTP; 29 inject nodes). Exec nodes are classified by `command` plus the function node feeding them: `tuya-*.js` sensor scripts (planned), `send-mail.js` (stub), local file/shell work (`exec:local`, explicit tool list), `dbus` calls (checked as service + path pairs against `emulator.py`). The Devices model reader (`dv-exec-01`) is a tolerant reader: its COMMON/TYPE path tables are checked too, but a path the emulator lacks is only a WARN because the script returns null for it. Pairs the emulator lacks must be listed in `PLANNED_DBUS` (now the BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`); an exec that fits no category (for example one calling the network), a Victron node without a path, a `settings` path not in the localsettings list, or an unknown node type fails CI.
2. **Emulator** with an HTTP API (`/state`, `/set`, `/stale`, `/fail`, `/writes`, `/reset`, `/mqtt`):
   - Victron D-Bus: fake services (`system`, `battery` instance 289, `vebus` 276, `settings`) with simple physics; every write the flow makes is recorded.
   - Tuya: local-protocol stub; fallback: a test-image transform that replaces each Tuya node by an MQTT pair with the same id and wires.
   - Qingping via internal mosquitto and `/mqtt` (done); solar forecast from fixtures (planned), scenario start time via `libfaketime` (Clock checks above pass for Node `Date`, the 06:00 inject and real-time timers; business assertions across DST/month-end remain).
3. **Scenarios** (`scenarios/*.yml`): initial state, steps, expectations, plus rules that hold all the time (grid limit, current limit, at most N writes per minute). Areas: tariff, battery, solar, DHW and shower, sensor failures, midnight, DST, month change, dashboard console errors.
4. **Runner**: runs all scenarios and writes a JUnit report. Every change passes the scenarios, then the deploy rehearsal, then CI, and only then goes to the real GX. A bug found on the real GX first gets a scenario that reproduces it, then the fix.

Risks: business behavior at DST/month-end needs scenario assertions; the Tuya protocol stub may be costly; the victron palette may need D-Bus paths that the emulator lacks.

Backlog items 8 (battery efficiency) and 9 (dashboard corner version) follow the complete test-GX work, not the MQTT step.
