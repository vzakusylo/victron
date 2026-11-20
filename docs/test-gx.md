# Test GX: a Cerbo copy in Docker for tests and deploy rehearsal

A Cerbo GX runs Venus OS (Linux, ARM) with Victron services on D-Bus and Node-RED. Victron publishes no Docker image of the whole Venus OS, so the copy is built from parts. It lives in `tools/test-gx/`.

## Repository-only synthetic fixture

The default build context is `tools/test-gx/fixture-synthetic/`: committed
synthetic defaults plus ignored flows/tools copied from repository sources.
No external backup or `TEST_GX_BACKUP` is needed:

```powershell
.\tools\test-gx\up.ps1 -Sim emu
```

Without `-Backup` or `TEST_GX_BACKUP`, `up.ps1` runs `build-fixture.js` and
selects the isolated fixture override before building. For direct Compose use,
see [Fixture isolation and verification](#fixture-isolation-and-verification).
Bare Compose requires an explicit backup; it cannot start the fixture without
the isolation override. `up.ps1 -Backup <sanitized-directory>` retains the
sanitized-backup path and its palette-version resolution. `up.ps1` still removes
the selected stack's data volume before rebuilding; do not use it against a
shared stack without clearance.

`build-fixture.js` reads repository sources only. Existing function bodies,
initializers, finalizers and copied tool bytes are unchanged. Only broker
configuration, the TEST-GX tab suffix and the existing four-device MQTT
transformation differ. The broker's other fields, including its inactive TLS
reference, remain unchanged. `fixture-tuya.json` supplies synthetic identities,
keys and config names; the proxy messages retain repository device labels so
the scenario runner can verify their function hashes. `fixture-versions.json`
preserves the approved GX version metadata; the
generated `nodered/package.json` pins the test install and documents explicit
runtime dependencies. There is no repository-root package manifest.

Logs are excluded; configuration starts with synthetic defaults (automations
OFF, empty sensor/cache dictionaries, source-default controller/HV settings).
Historical tariff, energy and sensor state is intentionally not restored.
The sensor-history helper and its `heatpump-decode.js` dependency come from
the current repository, not the older backup tool list.

Generated settings are **TEST GX ONLY - not for any real Node-RED**. They have
`httpAdminRoot: '/'`, memory context, empty `functionGlobalContext`, enabled
function modules, a fake credential secret/account, and anonymous default admin
permissions for the unchanged scenario runner. Keep published ports bound to
`127.0.0.1` as in compose. No backup `settings.js` exists in the inventoried tree;
repository flows have no `global.get`/`global.set` or named persistent context
store dependency. GX vendor `settings-user.js` is not imported.

MQTT uses the internal anonymous broker. SMTP points to `smtp.test.invalid` with
fake credentials: delivery must fail and is not emulated; mail helper failures
are reported by the existing flow, not treated as successful delivery. Cloud
sensor metadata is empty to avoid real cloud calls. Native Tuya protocol, SMTP,
external forecast and exec-sensor emulation remain out of scope.

After source changes, regenerate the fixture; commit changed synthetic defaults
together with the source change, but never commit the derived
`nodered/.node-red/flows.json` or `nodered/tools/` copies.
`tests/test-gx-fixture.test.js` builds a temporary fixture and checks exact
regeneration of committed non-derived files, byte-identical copied tools, unchanged
function bodies, and sensitive strings against explicit test placeholders or
`git grep -F` at `HEAD` in the flow, Tuya transform and copied tool sources,
reporting source filenames for review against the base. It does
not sanitize or mask production function code. Backup-parity
`compare-image.js` still needs its genuine sanitizer report and is not a
synthetic-fixture comparator.

| GX part | In the copy | Faithful? |
|---|---|---|
| Node-RED, our flow, dashboard | Pinned Node-RED/palette install and repository-generated flow by default; optional sanitized backup | Function bodies unchanged (palette patch version may differ, see traps) |
| `/data/home/nodered/...` files (`tools/`, `grid-control-config/`, logs) | Repository tools, synthetic config and empty logs by default; optional **sanitized** GX backup | Synthetic state is not historical backup parity |
| SSH as `root`, admin API | sshd in the same container | Yes, `tools/gx/*` and `scripts/gx-*.ps1` run unchanged |
| Victron D-Bus services | [`victronenergy/venus-docker`](https://github.com/victronenergy/venus-docker), simulation `e` (MultiPlus + BMV) | Partly: demo values, other device instances |
| Qingping MQTT | Internal Mosquitto + emulator `/mqtt` publications | Real MQTT and flow parsing; synthetic readings |
| Four native Tuya devices | Same-ID MQTT proxies + four emulator models | Automation contracts only; native palette/protocol not tested |
| DHW boiler tank | Heat-pump pump DPS 108 | Tank-temperature and automation path emulated |
| Boiler Tuya valve | `valve` model, DPS 1 | Routing and automation path emulated |
| Exec-based local Tuya poll | Omitted; coverage remains planned | Local sensor protocol and file contract not tested |
| Other exec-based Tuya sensors, solar forecast | Not emulated yet | No (later step B) |
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
| `up.ps1 -Sim emu -Backup <sanitized dir>` / `up.ps1 -Down` | Builds the Venus simulator image (patched, see traps) and the Node-RED image, starts the D-Bus/Tuya emulator and internal Mosquitto broker |
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

- Live comparison deliberately does not check the original MQTT `broker`, `port`, `usetls` or `tls` fields: they are normalized to the internal test endpoint. Other broker properties remain checked.
- The `replaced N <kind>` count is a count of occurrences: the same value may be counted in both `code` and `restJson`.
- After `STOPPED`, `sanitize-report.json` still names `<name>.map.json`, although the sanitizer removes that map and does not create it.
- The cleanup instruction above used to ask the operator to delete the map even though the script already deletes it. It is harmless but redundant.
- Without `--map`, live Tuya transformation is skipped with a `Tuya proxy` WARN, including when the production broker is `127.0.0.1:1883`. Comparison still completes; raw unmapped code/config/node differences remain DIFF (exit 1), not a comparison exception (exit 2).
- Tuya data is published every second, unlike the real palette's change/poll cadence; this can hide throttle or timing issues. Change-only publication with a slower heartbeat remains future work.
- `compare-image.js` currently requires `sanitize-report.json`; an old/manual backup without it fails with ENOENT rather than a dedicated diagnostic.
- The persistent emulator MQTT client constructor is not wrapped with the incompatible-paho guard used by `/mqtt`; incompatible paho fails loudly at startup, but its diagnostic can be improved.
- With pump DP 132 = `'1'`, physics recalculates DP 125 from the weather curve every tick; a SET DP 125 is recorded/applied but overwritten on the next tick.

### What `compare-image.js` checks

| Check | Rule |
|---|---|
| Flow (image vs backup, and vs live GX with `--live --map`) | Exact Tuya transformations listed in `sanitize-report.json` are EXPECTED; every other code/config/wiring difference is DIFF |
| Node-RED and palette versions | Equal; same minor but other patch → WARN |
| Files in `tools/`, `grid-control-config/` | SHA-256 equal; state files the flow rewrites → WARN |
| Global context keys | Compared when the backup has a context store |
| Start log | No error except the exact known startup D-Bus messages; native Tuya nodes are removed from the test image |
| Revision, tab label and git commit (with `--live`) | Differ → WARN: a deploy happened after the backup, take a new one |

## Rehearse a deploy

```powershell
.\scripts\gx-deploy.ps1 -GxHost root@test-gx -SshKey tools\test-gx\test_key           # dry run
.\scripts\gx-deploy.ps1 -GxHost root@test-gx -SshKey tools\test-gx\test_key -Apply    # on the test GX this is safe
```

The deploy window check still requires every guarded input: the four heat-pump models do not cover exec-based boiler/sensor inputs. Do not bypass a WAIT verdict.

## Traps

- **Temporary probes and PowerShell wires.** Add probes with `POST /flow`, not `POST /flows` (which replaces the flow set); remove them with `DELETE /flow/<id>`. Keep the main `d#...` tab id and label unchanged before and after. Build each output as a nested array, for example `$wires = ,([string[]]@($targetId))`, then serialize with `ConvertTo-Json -Depth 10`: sufficient depth alone does not restore arrays already flattened by PowerShell. Use `node.warn` for console markers; debug defaults to the editor sidebar.
- **Compressed recorder logs.** `.csv.gz` must be decompressed, sanitized and recompressed, not read directly as UTF-8. The leftover-secret scan also checks their decompressed text. Refresh older sanitized trees: their gzip headers may have been corrupted by text decoding.
- **Volume hides the image.** The named volume `gx-data` is mounted on `/data` and hides the files copied into the image. `up.ps1 -Down` removes it; always use it before building a new backup.
- **ID starting with a digit.** Flow code uses ids as bare object keys (`{ 6ca39...: {...} }`). A fake id that starts with a digit is a syntax error, so the sanitizer makes fake ids start with a letter.
- **Palette not on npm.** `@victronenergy/node-red-contrib-victron@1.6.31` is not published; explicit-backup `up.ps1` falls back to `~1.6` and warns. The synthetic manifest pins `1.6.65`; provenance remains `1.6.31` in `versions.json`. GX 1.6.31 / test 1.6.65 (1.6.31 not on npm): this is a deliberate test-install difference, not version parity.
- **venus-docker.** Clone with `core.autocrlf=false` (CRLF breaks the `#!` scripts). The HTML5-app stage fails upstream and is removed by `up.ps1`, so the Venus app on `:8080` does not work. D-Bus over TCP is on port 3000; the palette reads it from `NODE_RED_DBUS_ADDRESS=venus:3000`.
- **Device instances.** The flow expects `com.victronenergy.battery/289` and `vebus/276`. With `-Sim emu` the emulator publishes its own services with exactly these instances; the stock simulator uses others, which gives `DBUS ERROR UnknownObject`, "not found in cache" and `Set error status`. Never change the instance in the flow: the test would no longer match the real GX.
- **sshd as root.** The Alpine image needs `apk add --upgrade openssh openssh-server bash curl`, an unlocked root account and a key without passphrase. The host key changes with every image, so `~/.ssh/known_hosts_test_gx` is separate and deleted by the refresh script.
- **One `UnknownObject` at start is expected.** The victron palette reads `/DeviceInstance` on `com.victronenergy.settings` during service discovery and localsettings has no such path (found with `dbus-monitor`). The start-log check accepts one such line per start (the log keeps all starts), only right after "Polling is disabled", skipping blank lines and the specific successful `mqtt://mosquitto:1883` connection message that can interleave the D-Bus log. Other intervening lines and any other `UnknownObject` are reported as unknown errors.
- **Emulated identity paths.** Every fake service has `/CustomName`, `/Serial` (`HQEMU0001`) and `/FirmwareVersion` (`0x0510`); vebus has `/VebusError`, battery has `/Dc/0/Temperature`. They feed the Devices page (`dv-exec-01`), so the inventory gives no WARN.
- **Python D-Bus in the Node-RED image.** The Devices page reads Victron devices with `python3` + `dbus` (`dv-exec-01`). The image installs `py3-dbus` and sets `DBUS_SYSTEM_BUS_ADDRESS=tcp:host=venus,port=3000`; without them the page shows "python dbus module: No module named 'dbus'" instead of the Victron devices. Dashboard tab numbers in the URL (`/ui/#!/<n>`) do not match the `ui_tab` order in `/flows`: Devices is `#!/13`.
- **Restart order.** Node-RED must start after the simulator is up, otherwise the palette finds no services. The venus healthcheck (`emulator/healthcheck.sh`) passes only when the emulator API answers, which happens after all fake services are registered. Node-RED does not reconnect to a restarted simulator (`ServiceUnknown`): restart both, `docker compose -p test-gx restart venus nodered`. Until the emulator is ready both GET and POST answer 503; it is ready when the signal of its own startup write arrives (that write never shows in `/writes`), or after 10 s with `ready by timeout, startup write signal not seen` in its log. If the signal arrives after that timeout, the `-1` write to `MaxChargeCurrent` does appear in `/writes` (a rare, accepted trade-off) and the log says `late startup signal recorded as write`. `EMU_READY_DELAY=<s>` holds it in 503 for a test; `tools\test-gx\test-emulator-ready.ps1` uses it to check 503 then 200. CI checks normal readiness, but the delayed-start 503 behaviour remains a manual Docker check.

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

`@YYYY-MM-DD HH:mm:ss` means start at that local time and advance at normal speed; this smoke script does not use accelerated time. The smoke script checks the Node process's `Date`, a `setTimeout` backed by Node/libuv monotonic time, Node-RED health/startup, and that emulator write timestamps remain close to the host clock. It does not import a test tab into the repository's `flows.json`.

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
| B4 four native Tuya devices | implemented as test-image MQTT proxies; see contracts and checks below |
| B5 forecast, exec-based Tuya sensors and automated scenarios | heat-pump scenario runner implemented; forecast and exec-based sensors remain planned |

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

## Tuya devices over MQTT (Plan B)

Only the image is transformed: production `flows.json` and numbered sources are unchanged. The four `tuya-smart-device` nodes become three-output functions with their original IDs and output 1/2 wires. Output 3 publishes non-retained QoS 1 commands to `tuya/<pump|valve|bypass|meter>/command`. Two deterministic MQTT inputs per device subscribe to `/data` and `/state`; all use the internal `mosquitto:1883` broker. Native `deviceKey`, `deviceIp` and protocol settings are not copied into proxies. An unknown Tuya node, unresolved device identity, unexpected output count or generated-ID collision stops sanitization; no native Tuya node may survive.

### Boiler tank

The DHW tank temperature is heat-pump pump DPS 108. The Tuya device named **Boiler** is the three-way valve relay (`valve`), with DPS 1 routing flow to DHW. The model heats the tank when the pump is running and valve DPS 1 is ON; otherwise, passive heat loss approaches a 20 °C ambient with a 14-day time constant. Water draw is not part of this base physics and belongs in a separate scenario.

| DPS | Meaning | Backup observation | Test-model range |
|---|---|---:|---:|
| Pump 108 | DHW tank temperature, °C | 32–50 °C in the heat-pump recorder | -40–120 °C |
| Valve 1 | Three-way valve relay; ON routes to DHW | 0–1 | boolean |
| Valve 9 | Countdown, seconds | 0 | 0–86400 |
| Valve 18 | Current, mA | 0 | 0–16000 |
| Valve 19 | Power, W × 10 | 0 | 0–36800 |
| Valve 20 | Voltage, V × 10 | 2220–2325 | 0–3000 |

The ranges in the backup-observation column are observed recorder values, not manufacturer limits. The broader test ranges are input-validation envelopes. DPS 108 belongs to the pump model; there is no separate `boiler` DPS alias. Use `/set tuya.pump.dps.108` for the tank temperature. Use `/fail` and `/stale` on the actual `pump` or `valve` device to exercise its status and safety behavior.

`tuya-local-poll.js` polls local-network sensors unrelated to the tank and valve. The Devices exec (`dv-exec-01`) discards its stdout, while node 50 reads `tuya-devices-last.json`; therefore the test image omits the real poller and leaves this exec-sensor coverage **planned** (B-tuya), rather than claiming an HTTP stdout-only stub fulfills its file contract. The tank shown on the Heat Pump page and consumed by the automation comes from pump DPS 108 through the existing Tuya proxy: node 34 builds the model, node 40 reads tank / valve state, node 47 handles connection alerts, and node 50 displays device data from the saved file.

Automation SETs for the valve remain on the existing Tuya MQTT proxy and appear in `/writes`. Neither the local sensor poller nor its protocol is tested.

Contracts were checked in the installed `node-red-contrib-tuya-smart-device@5.4.0` and TuyAPI source, the sanitized `tuya-nodes.json` / `tuya-devices-meta.json`, [heat-pump documentation](heat-pump.md#data-points) and a valid recorder keyframe from the backup (`2026-11-15/00.csv.gz`):

| Direction | Actual contract |
|---|---|
| Poll | `msg.payload = {operation:'GET', schema:true}` |
| Single SET | `{operation:'SET', dps:133, set:37}`; absent `dps` means DP 1 |
| Multiple SET | `{operation:'SET', multiple:true, data:{'132':'1','134':4}}`; not `dps:{...}` |
| Data, output 1 | `{payload:{data:{dps:{...},t:<seconds>},deviceId:<sanitized id>,deviceName:<name>}}`; partial DPS merge in Heat pump state |
| Status, output 2 | `{payload:{state:'CONNECTING'|'CONNECTED'|'DISCONNECTED'|'ERROR'}}` |

The proxy inserts the sanitized identity from `tuya-nodes.json`, resolving the backup's environment placeholders. The emulator sends DPS data every second and on GET/SET, with status on changes. Only status is retained: replaying an old retained DPS snapshot after an offline event could incorrectly refresh a newly deployed consumer. Broker reconnect republishes status and current data. GET/REFRESH and accepted SET commands are recorded in `/writes` with real timestamps, `device`, `operation`, `dps`, `value` and `applied`; offline SETs are recorded but not applied. Batch SET validation is atomic. CONTROL/discovery and the native Tuya protocol are not emulated.

### DPS model

`emulator/tuya-model.json` is shared with inventory validation. Writable limits follow the documented device model; read-only limits below are deliberately broad **test-model acceptance envelopes**, not manufacturer specifications. DP 4 is an opaque value (`6666`) observed in the recorder and is not interpreted.

| Device | DPS | Meaning / model range |
|---|---|---|
| Pump | 1, 2, 5 | power boolean; mode `smart/strong/mute`; work mode `wth/heat/cool/wth_heat/wth_cool` |
| Pump | 4, 15 | opaque reported value 0..10000 (default 6666); fault bitmap 0..65535 |
| Pump | 101, 102, 103, 104, 105, 106, 107, 108, 113 | return, supply, outdoor, discharge, suction, outdoor/cooling coil, DHW tank, heatsink; -40..120 C, except outdoor up to 80 and discharge up to 150 |
| Pump | 109 / 111 | Main / EVI expansion valve, 0..500 |
| Pump | 112 / 114 / 115 / 116 / 117 | Compressor current 0..50 A; DC bus 0..500 V; compressor 0..120 Hz; fans 0..1500 rpm |
| Pump | 121, 122, 123, 124, 125, 126 | heating/DHW hysteresis 2..18 C; DHW setpoint 28..60; cooling 7..30; heating writes 15..55 (curve reports up to 60); compensation -5..15 |
| Pump | 132, 133, 134, 135 | P22 `'0'/'1'`; P23 0..40 (manual UI 20..40); P24 1..30; frequency mode `'0'/'1'` |
| Pump | 136, 137, 138 | heater ambient trigger -20..20 C; delay 0..60 min; pump mode `'0'/'1'` |
| Pump | 139, 140, 141, 142, 143, 144 | defrost enter/exit -40..40 C; ambient-coil difference 0..40; frequency limits 30..120 Hz; DHW compensation -50..20 Hz |
| Valve, bypass | 1, 9, 18, 19, 20 | relay boolean (valve ON = DHW, bypass ON = bypass); countdown seconds; mA; W x10; V x10 |
| Meter | 1, 6, 32 | energy kWh x100; 8-byte base64 phase A (big endian V x10 / mA / W, 2/3/3 bytes); Hz x100 |
| Meter | 18, 19, 20 | optional plug-meter fallback mA / W x10 / V x10; absent by default so the real SA1 DP 6 decoder is exercised |

Simple physics couples pump power to meter DP 6 and energy DP 1, moves supply/return toward the weather curve, and heats DP 108 only with the valve on DHW and bypass off. It does not model real compressor dynamics, defrost physics or hydraulic transit.

```powershell
# Change tank temperature; wait for the actual automation, not a simulated SET.
Invoke-RestMethod -Method Post http://127.0.0.1:8081/set -ContentType application/json `
  -Body '{"path":"tuya.pump.dps.108","value":25}'
Invoke-RestMethod http://127.0.0.1:8081/writes | Where-Object operation -eq SET

# Freeze publications, disconnect a relay, or send invalid sensor values:
Invoke-RestMethod -Method Post http://127.0.0.1:8081/stale -ContentType application/json `
  -Body '{"path":"tuya.pump"}'
Invoke-RestMethod -Method Post http://127.0.0.1:8081/fail -ContentType application/json `
  -Body '{"path":"tuya.valve","mode":"offline"}'
# Restore with mode "ok"; /reset restores all four devices and clears writes.
```

Stale suppresses even GET replies until `/fail` with `mode:"ok"` or `/reset`; optional `seconds` gives a finite interval. `mode:"invalid"` publishes pump temperatures -127, current `null` (JSON-safe substitute for NaN), compressor frequency 0; relay DP 1 becomes `null`, meter DP 6 empty. Actual downstream guards, not the emulator, decide what to do. The 15-minute defrost quiet period after a Node-RED deploy remains untouched: wait for it before asserting a normal DHW start.

Comparison regenerates and validates flow transformations against `tuya-source-flows.json`, retained outside the image, and verifies that the unemulated local Tuya poller is omitted. For `--live --map`, only original Tuya node IDs are transformed before comparison; live wiring/code changes still propagate to DIFF, and there is no blanket Tuya-config exemption. Inventory checks the HP_DPS dictionary and consumed DPS against the shared model; adding an unmodelled DP or native device fails CI. New consumer aliases must be added to this parser rather than silently treated as covered. Accumulator/plate and battery sensor emulation remains separate planned work.

### Manual results

| Check | Result |
|---|---|
| Heat Pump page | PASS; four CONNECTED devices, outdoor 0 C, 40 Hz, fan 600, SA1 900 W and live tank/supply values |
| Dashboard manual command | PASS; P23 38 -> 37 produced an applied pump SET DP 133 in `/writes` |
| DHW response to tank `/set` | PASS after waiting the real startup quiet period: tank 60 C held HEATING; 60 -> 25 caused applied pump SET DP 133 = 0, then valve SET DP 1 = true and VALVE state |
| Pump offline and automation guard | PASS; page showed DISCONNECTED, curve control disabled and `waiting: device not connected / stale`; no SET attempts during 35 s with an already-started DHW cycle paused |
| Boiler valve offline and automation guard | PASS; `/fail` showed DISCONNECTED on Heat Pump and Devices; no Tuya SET appeared in `/writes` while offline |
| Image comparison | PASS; 0 DIFF, 16 exact transformations EXPECTED; palette patch mismatch WARN remains |

The backup's Heat Pump history widget still produces its pre-existing unquoted `vertical-align` Angular `ng-style` error (and dashboard loading.html 404). These are not introduced by the transform; do not change production UI sources in this branch. Plan B tests the automations and their data/command contracts, **not `tuya-smart-device` itself or the real local Tuya protocol**.

The `--live --map` path was exercised with a raw snapshot reconstructed from the backup (flow comparison 0 DIFF), not an SSH snapshot from the real GX; real-GX SSH access remains unavailable. An isolated Venus restart deliberately reproduces the already-documented D-Bus `ServiceUnknown`/`UnknownObject` failure; keep the strict log rule and refresh/restart both containers rather than classifying those errors as expected.

## Logic scenario runner

The YAML runner covers heat-pump commands and charging D-Bus outputs. Decision/input maps
are in the [heat-pump inventory](test-gx-heatpump-inventory.md) and
[charging inventory](test-gx-charging-inventory.md). It does not replace focused function-node
tests for output ports and missing/stale/NaN readings that the emulator API cannot inject.

Run against an already-running Test GX stack:

```powershell
# Run all checked-in YAML scenarios; JUnit defaults to the ignored tools/test-gx/out/ directory.
node .\tools\test-gx\run-scenarios.js

# Run charging, then the required heat-pump regression on the same retained volume.
node .\tools\test-gx\run-scenarios.js --suite charging --junit .\tools\test-gx\out\charging.xml
node .\tools\test-gx\run-scenarios.js --suite heatpump --junit .\tools\test-gx\out\heatpump.xml

# Run one scenario by its exact YAML `name`.
node .\tools\test-gx\run-scenarios.js --scenario "Er03 full restart sequence" `
  --junit C:\learn\test-gx-data\runs\heatpump-er03.xml

# Runner-only smoke test (uses a mock API; does not need Docker or mutate Test GX).
node .\tools\test-gx\run-scenarios.js --self-test --junit $env:TEMP\test-gx-scenarios.xml

# Focused function and runner tests; no Docker required.
node --test .\tests\test-gx-scenarios.test.js .\tests\heat-automation.test.js
```

Each heat-pump scenario restarts Node-RED with its `faketime`, applies `settings` through temporary Node-RED
UI inject nodes, resets emulator state, applies `inputs` through `/set`, `fail` through `/fail`,
`stale` through `/stale`, advances to each `when` offset, waits `settle`, then compares new
Tuya `SET` commands in `/writes` against `expect.writes`. Every step requires `expect.writes`,
including an explicit `[]` for guards; missing expectations and extra selected writes fail.
To observe D-Bus outputs instead, set scenario `observe` to a nonempty sequence of exact
`service` and `path` pairs (for example `settings` and `/Settings/SystemSetup/MaxChargeCurrent`).
Only matching writes are asserted, in order; unrelated D-Bus traffic and Tuya GETs are excluded.
Without `observe`, all Tuya `SET` commands are selected.
For change-notifying D-Bus settings, `expect.if_changed: true` requires every expected
output to differ from its pre-step `/state.outputs` value, then checks the actual write
and terminal value. A step whose output should remain unchanged uses
`expect.if_changed: false` with `expect.writes: []`; add `expect.outputs` to assert the
terminal D-Bus values without requiring a write. Default assertions retain their exact
count/order semantics.
Charging stops Node-RED, resets actuator values through `/reset` with `{"outputs":true}`,
checks the actual defaults (-1 A DVCC, 0 W setpoint, 25 A input limit), and stages inputs
before Node-RED starts; settings are then applied and
the real 10-second output pacing is allowed to settle before the checked steps begin.
Charging steps assert terminal values as well as all selected changes; setup is not a step.
They also check the controller's received input context, not merely `/set` acceptance.
Unavailable actuator reads carry an explicit error and `null`, never synthetic defaults.
Resetting actuators while Node-RED is stopped prevents a preceding case's correct output
from satisfying a broken controller. Plain `/reset` retains its existing input-only behavior.
Heat-pump initial writes remain included in the first step's exact assertion.
When `settings.heatCurve` is specified, the runner first loads that curve with master off and
other settings reset to their defaults, including the DHW block and last-cycle time; the UI
actions then save the resulting settings in the volume. This makes the quiet-period twins
independent of previously persisted settings. Before settings injection the runner saves
file/context snapshots outside the repository. It restores them after each scenario,
including on failure, and checks that no temporary flow remains. Cleanup failure stops the
suite. The [charging inventory](test-gx-charging-inventory.md#isolation-and-restoration)
lists the exact resources and the narrowly scoped cached-forecast fault fallback.
Before and after every scenario the runner also checks that no temporary nodes remain
and SHA-256 hashes the complete production function-node definitions against `flows.json`.
The four Test GX Tuya adapters are checked against `transform-tuya.js`, not mistaken for
production function nodes. A changed function, restore hook, missing temperature function
or leftover helper is a hard failure. Node-RED's verified default context store is
memory-only: restarting it before each scenario resets node-private manual-discharge state,
shade cache and subflow rate-limit context. No restore hooks are used. A filesystem context
store needs its own stopped-service baseline snapshot/restore; that mode is not automated here.
Optional `expected_fail: <bug-reference>`
marks a known mismatch as a JUnit skipped case; an unexpected pass is a failure. The runner writes
JUnit XML to `--junit`, `TEST_GX_JUNIT`, or `tools/test-gx/out/test-gx-scenarios.xml`, in that
precedence order. Faketime shifts recreate only the Node-RED service and do not remove `gx-data`.
The CLI prints a running case's elapsed real minutes once per minute.
Both `when` and `settle` are measured in fake time and divided by the scenario's `xN` rate
for real waits. `when` is relative to the runner's post-reset start, not the Node-RED deploy.
The automation tick inject starts 60 real seconds after Node-RED startup, then repeats every
10 real seconds; the live Er03 controls wait for three ticks. Set `TEST_GX_TAG` to the image tag
used by the running stack. If a separate Compose override is required, set `TEST_GX_COMPOSE_OVERRIDE`
to its absolute path; the runner uses it when recreating Node-RED.

The checked-in YAML has 33 charging scenarios, one trivial smoke scenario and seven heat-pump scenarios. Unit
tests additionally cover the individual decisions and all 17 read paths (three variants each:
missing, stale, and NaN). The deploy-window decision is covered directly in a unit test because
the runner observes emulator writes, not the deploy CLI's WAIT verdict.

## Known limitations

- Palette versions: GX 1.6.31 / test 1.6.65 (1.6.31 not on npm). The synthetic fixture explicitly pins the published patch; it also explicitly pins `tuyapi@7.7.1`, required by `tools/tuya-local-sensors.js`, instead of relying on the Tuya palette's transitive dependency. A behavior difference attributable to this patch is a limitation to report, not a reason to alter production code.
- The emulator API cannot remove an individual DPS or accept JavaScript `NaN`; `/set` validates values and `/fail invalid` publishes invalid sentinels. Missing/stale/NaN behavior is covered against the actual function source, not through YAML/API.
- Historical faketime can be ahead of or behind the emulator's real MQTT timestamps, so `/stale` is not reliable for a live freshness-threshold assertion. The YAML guard scenario uses `/fail offline`; stale-age behavior remains covered by the function-node tests.
- `/writes` records actuator commands (D-Bus and Tuya), not settings/log file effects, UI rendering, exec-node behavior or SMTP delivery.
- The deploy-window check is covered by a direct test of `tools/gx/window.js`, not by an API scenario.
- A finite but out-of-range saved heat-pump curve is not range-checked on load before restoration to pump DP 133/134. The in-process test marks this as expected_fail HP-SETTINGS-1; the scenario API cannot inject a settings file.
- Scenario timing requires the Test GX stack and Docker. Accelerated faketime (`xN`) changes Node's wall clock while monotonic timers remain real; with `x60`, the watchdog drops the Er03 sequence after its first valve command. The full-sequence scenario runs at normal speed instead.
- The eight-scenario heat-pump suite takes about 30 real minutes because DHW and full Er03 controls run at `x1`; CI should use a separate slow-scenario job.
- A previously observed Docker health-check failure refers to missing `/data/settings.js` even while the Node-RED API answers. Health-check cleanup belongs to `test-gx-ci`; API readiness is checked independently by the runner.
- Charging coverage gaps C-U1-C-U3 are listed in the charging inventory. Forecast fixtures require the updated emulator; restart Venus and Node-RED together without removing any volume.
- `test-gx-refresh.ps1` invokes `up.ps1 -Down`, which removes the `gx-data` volume. Do not use refresh when preserving that volume; refresh requires explicit acceptance of the volume removal.
- UI tests use the stack's backup-derived flows (currently `d#181`), not repository `flows.json`; Temperatures is untested until `test-gx-repo-flows`.

## Remaining Test GX work

1. **Inventory** (`inventory.js`): generated from `flows.json` (Victron D-Bus: 7 inputs, 4 outputs; 4 Tuya devices; Tuya cloud scripts; Qingping MQTT; solar forecast HTTP; 29 inject nodes). Exec nodes are classified by `command` plus the function node feeding them: `tuya-*.js` sensor scripts (planned), `send-mail.js` (stub), local file/shell work (`exec:local`, explicit tool list), `dbus` calls (checked as service + path pairs against `emulator.py`). The Devices model reader (`dv-exec-01`) is a tolerant reader: its COMMON/TYPE path tables are checked too, but a path the emulator lacks is only a WARN because the script returns null for it. Pairs the emulator lacks must be listed in `PLANNED_DBUS` (now the BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`); an exec that fits no category (for example one calling the network), a Victron node without a path, a `settings` path not in the localsettings list, or an unknown node type fails CI.
2. **Emulator** with an HTTP API (`/state`, `/set`, `/stale`, `/fail`, `/writes`, `/reset`, `/mqtt`):
   - Victron D-Bus: fake services (`system`, `battery` instance 289, `vebus` 276, `settings`) with simple physics; every write the flow makes is recorded.
   - Tuya: Plan B test-image MQTT proxies for the four native nodes (done). Do not build a local-protocol stub unless Plan B proves insufficient. Exec-based sensors are a separate item.
   - Qingping via internal mosquitto and `/mqtt` (done); solar forecast HTTP fixtures (charging row), scenario start time via `libfaketime` (Clock checks above pass for Node `Date`, the 06:00 inject and real-time timers; business assertions across DST/month-end remain).
3. **Scenarios** (`scenarios/*.yml`): initial state, steps, expectations, plus rules that hold all the time (grid limit, current limit, at most N writes per minute). Areas: tariff, battery, solar, DHW and shower, sensor failures, midnight, DST, month change, dashboard console errors.
4. **Runner**: heat-pump and charging rows use `tools/test-gx/run-scenarios.js`; remaining sensor, tariff and DST/month-end decisions are future work. The charging forecast fixtures exercise the real HTTP fetch/parse path, not upstream availability. Every change passes its scenarios, then the deploy rehearsal, then CI, and only then goes to the real GX. A bug found on the real GX first gets a scenario that reproduces it, then the fix.

Risks: business behavior at DST/month-end needs scenario assertions; Plan B does not validate the native Tuya palette/protocol; the victron palette may need D-Bus paths that the emulator lacks. After the Tuya PR merges, create `test-gx-forecast` from fresh `master`.

## Dashboard UI checks

The Playwright checks compare the runtime menu to the generated inventory, then visit each
visible, enabled page separately. Browser console errors and uncaught page errors fail the
test. `console-allowlist.json` matches exact `type` (`console` or `pageerror`), `text` and,
for console errors, `url`, with a reason for each entry. It currently allows only the
third-party Dashboard's missing `/ui/loading.html` asset and the SideNav boot error before
the first menu click at the default local URL. SideNav timing is recorded per test; the same
error after a click remains a failure. `expected-errors.json` lists the exact known Heat Pump
Angular `vertical-align` syntax error (`flows-hp-template-parse`, `hp-hist-template-01`).
Other errors still fail, as does a missing expected error. The checks use Microsoft Edge by
default and only
navigate between pages; they do not operate controls or call mutating APIs.

Run it against an already-running Test GX stack from the repository root:

```powershell
npm ci --prefix .\tools\test-gx\ui
npm run test:ui --prefix .\tools\test-gx\ui
```

Failure traces are retained under `tools/test-gx/ui/test-results`; keep them private because
they can contain dashboard content and network data.

The image is built from a sanitized GX backup; the persistent `/data` volume can retain a
different flow. The current running stack returned `d#181` from `/flows`, while the repository
contains `d#187`; its inventory has no Temperatures tab. `pages.json` is derived from the
running flow, not the repository flow. Regenerate it with a read-only GET and a private
temporary file outside the repository:

```powershell
$flows = Join-Path $env:TEMP "test-gx-flows-$([guid]::NewGuid()).json"
try {
    Invoke-WebRequest -Method Get -Uri http://127.0.0.1:1881/flows -OutFile $flows
    node .\tools\test-gx\ui\gen-pages.js --flows $flows
    if ($LASTEXITCODE -ne 0) { throw 'Page inventory generation failed' }
    node .\tools\test-gx\ui\gen-pages.js --flows $flows --check
    if ($LASTEXITCODE -ne 0) { throw 'Page inventory check failed' }
} finally {
    if (Test-Path -LiteralPath $flows) { Remove-Item -LiteralPath $flows }
}
```

Review the derived tab IDs and names before committing `pages.json`; never commit the flow
snapshot. The runtime-menu test detects an inventory that no longer matches the stack. Routes
predict Dashboard's widget-registration order, including ties. The two Energy entries are
distinct config IDs with the same name and order; neither has a widget, so neither gets a
route.

| Tab ID | Name | Order | Route / reason |
|---|---|---:|---|
| `ui-tab-hourly-stats-01` | Energy | 1 | No enabled widget |
| `6fb98cc3df6410d0` | Energy | 1 | No enabled widget |
| `ui-tab-analytics-01` | Analytics | 3 | `#!/0` |
| `ui-tab-hv-protection-01` | Protection | 4 | `#!/2` |
| `ui-tab-files-root-01` | Files | 4 | `#!/1` |
| `ui-tab-constants-01` | Constants | 5 | `#!/3` |
| `ui-tab-backup-01` | Backup | 6 | `#!/4` |
| `ui-tab-device-01` | Device | 7 | `#!/5` |
| `ui-tab-driver-01` | Driver | 8 | `#!/6` |
| `ui-tab-mcp-01` | Agent (MCP) | 9 | `#!/7` |
| `ui-tab-heatpump-01` | Heat Pump | 10 | `#!/8` |
| `ui-tab-hpdata-01` | Heat Pump data | 10 | `#!/9` |
| `hpa-ui-tab-01` | Automations | 11 | `#!/10` |
| `hpl-ui-tab-01` | Automation log | 12 | `#!/11` |
| `pb-ui-tab-01` | Payback | 13 | `#!/12` |
| `dv-ui-tab-01` | Devices | 14 | `#!/13` |
| `dv-aq-ui-tab-01` | Air quality | 15 | `#!/14` |

All 17 definitions currently have `disabled: false` and `hidden: false`. A tab with no
registered widget has no predicted runtime menu entry despite those flags.

Set `TEST_GX_UI_URL` to use a different dashboard URL, or `TEST_GX_UI_BROWSER` to select
another Playwright Chromium channel. Docker is not started by this test.

Backlog items 8 (battery efficiency) and 9 (dashboard corner version) follow the complete test-GX work, not the MQTT step.

## CI

**Status: green.** Manual run [44649823238](https://github.com/vzakusylo/victron/actions/runs/44649823238)
passed on `test-gx-ci-green`. The workflow runs on every PR and push to `master`. PR runs skip
the scenarios if no Test GX paths changed (see [GX deploy](gx-deploy.md#automatic-deploy-after-test-gx));
push runs always run the full suite. A scenario that exceeds its time limit
(20 minutes, `TEST_GX_SCENARIO_TIMEOUT_MS`) fails by itself and the run continues. The
earlier red run 44573678310 was on an older `master` commit (`9fc2f5d`) and failed the Tuya
proxy function-hash check; current `master` no longer reproduces it.

Run **Actions > Test GX scenarios > Run workflow** with `workflow_dispatch`. The single
job has a 120-minute limit. It builds the repository-only synthetic fixture, runs all checked-in scenarios,
and summarizes their JUnit results. Expected failures are skipped; an unexpected pass fails
the job. The `test-gx-logs` artifact retains JUnit, Compose and Node-RED logs, and the
`/writes` dump for 14 days. Every new Test GX branch adds its scenarios to this job.

## Fixture isolation and verification

The fixture runs Node-RED, Venus and Mosquitto on an internal network. A
two-network, read-only gateway exposes only the existing ports on `127.0.0.1`;
the test services cannot use it to reach external hosts. Backup-based starts
keep their existing network behavior. The override requires Docker Compose
2.36 or later for explicit gateway interface names.

Regenerate after changing `flows.json` or any numbered function source, and
whenever the copied tools or synthetic defaults change:

```powershell
node .\tools\test-gx\build-fixture.js
node .\tools\test-gx\fixture\check.js
```

The check permits only the four Tuya transformations, their MQTT nodes, the
broker endpoint and the `TEST-GX` tab marker; all other nodes and original
function bodies must match. It also accepts `--image-file <flows.json>` or
`--admin <url>` to check an extracted image or a running Node-RED flow.

For direct Compose use, first prepare the Venus image and test SSH key as
described above, then select both files:

```powershell
cd .\tools\test-gx
docker compose -f docker-compose.yml -f docker-compose.fixture.yml up -d --build
```

Use the same two Compose files for logs and shutdown. When running scenarios
from a separate shell, set `TEST_GX_COMPOSE_OVERRIDE` to the absolute path of
`docker-compose.fixture.yml` and `TEST_GX_TAG` to the image tag. This keeps
Node-RED on the isolated network when the runner recreates it.
