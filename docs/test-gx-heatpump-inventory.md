# Heat pump automation scenario inventory

This inventory covers the function nodes `Heat pump automations` (40), `Automation log` (42),
and `Heat pump alerts` (47), plus their decisions and outputs. The production flow and numbered
function sources are read-only for this Test GX task.

## Input path and units

The function nodes do not read D-Bus directly. The four Tuya MQTT proxies publish device data and
connection state; `Heat pump state` (34) merges the partial DPS readings into `flow.heatPump`.
Node 40 reads the pump, boiler valve, and bypass relay from that shared flow context. Its other
inputs are a 10-second tick, UI commands, and the persisted automation-settings JSON file.

| Device / DPS | Meaning and unit | Used for |
|---|---|---|
| Pump 1 | power, boolean | Enabled-state guard and pump on/off command |
| Pump 2 | mode enum: `mute`, `smart`, `strong` | DHW / heating / restart decisions and command verification |
| Pump 15 | fault bitmap; bit 0 is Er03 | Fault guard, alert, DHW abort, Er03 restart |
| Pump 101, 102 | return / supply, °C | Heating lag, DHW curve and recovery checks |
| Pump 103 | outdoor temperature, °C | Weather curve, defrost checks, DHW target |
| Pump 104 | discharge temperature, °C | DHW compressor protection |
| Pump 108 | DHW tank temperature, °C | DHW demand, target, progress and stop |
| Pump 112 | compressor current, A | Heating and DHW compressor protection |
| Pump 115 | compressor frequency, Hz | Defrost / compressor state and protection |
| Pump 116 | fan speed, RPM | Defrost detection and recovery |
| Pump 125 | heating set point, °C | Defrost recovery |
| Pump 132 | P22 weather-curve state, string `'0'` / `'1'` | Heating/DHW curve decisions |
| Pump 133, 134 | P23 ambient point, °C; P24 curve coefficient | Heating / DHW curve and boost |
| Valve 1, bypass 1 | relay state, boolean | DHW routing, defrost bypass and safety guards |

Each device reading must be connected and no older than five minutes. Missing and non-finite values
are guarded by the function; a missing/invalid pump DP 132 is the deliberate exception and requests
the safe P22-on value `'1'`. The emulator model's ranges are acceptance limits, not manufacturer
specifications. Writable pump limits used here are P23 0–40 °C and P24 1–30; mode is the enum
above; power and relay writes are booleans.

## Node 40: Heat pump automations

The node has seven wired outputs. Output indexes below are 1-based; command values are the
`set` field sent to the Tuya proxy.

| ID | Function output / decision | Condition and expected target/value (units, clamp) | Coverage |
|---|---|---|---|
| F40-01 | Device freshness and valid-input guard | Required devices must be connected and fresh; each rule checks its own inputs. Invalid P22 can request pump DP 132=`'1'`. | `tests/test-gx-scenarios.test.js`: 51 missing/stale/NaN guard cases; YAML `Er03 offline pump guard`, `Er03 stale valve guard`, `Er03 invalid valve guard`, and `Er03 positive control after deploy quiet period` |
| F40-02 | Quiet period following Node-RED deploy | The node starts with defrost history set to startup time; DHW/heating decisions wait 15 min. Later inputs are evaluated normally; the Er03 restart sequence itself is not blocked by this quiet-period check. | `tests/heat-automation.test.js`: `DHW demand waits out the 15-minute quiet period after deploy`; YAML `no heat pump commands during deploy quiet period`, `Er03 positive control after deploy quiet period` |
| F40-03 | Defrost begins (`df_exchange_off`) | Three 10-second matching ticks: compressor running, fan stopped, supply below 27 °C, outdoor below 14 °C, and DHW idle. If live/master, bypass DP 1=`true`; otherwise log a dry-run. | `tests/heat-automation.test.js`: `defrost start turns the bypass on after three matching ticks` |
| F40-04 | Defrost recovery (`df_exchange_on`) | Three matching ticks after fan recovery and supply recovery; when the pump curve is enabled and DHW is idle, bypass DP 1=`false`. | `tests/heat-automation.test.js`: `defrost recovery turns the bypass off after three matching ticks` |
| F40-05 | Er03 restart sequence | Fault bit 0 plus valve on the DHW path, held for three ticks. Sequence routes valve back to heating, stops/restarts pump, turns bypass off, and restores P22; pump power is boolean, P22 is `'1'`. The full sequence includes two intentional valve-OFF writes, 30 seconds apart. | YAML `Er03 positive control after deploy quiet period` and three Er03 guard variants; `tests/heat-automation.test.js`: `Er03 restart starts with a valve-to-heating command only after three matching ticks` |
| F40-06 | DHW cycle start / stop and guards | With controller and master live, fresh devices, stored heating curve, no fault/block/defrost restriction, and tank below target minus hysteresis for three ticks: stop the compressor with pump DP 133=`0`, mode `mute`, then switch valve DP 1 on after the stop. On target, timeout, fault, or safety abort, route valve to heating and restore the saved P22/P23/P24. P23/P24 targets are bounded by the curve calculations; see suspected settings-file issue below. | `tests/heat-automation.test.js`: `DHW controller starts a cycle after three fresh tank-demand ticks`, `a DHW cycle aborted by Er03 writes the owner heating curve back and the heating controller resumes`; input guards in `tests/test-gx-scenarios.test.js` |
| F40-07 | DHW compressor protection | During DHW, sustained frequency ≥ configured 80 Hz, current ≥ configured 85% of 9.67 A, or discharge ≥ configured limit causes one P23 reduction / Silent step; persistent protection ends the cycle and restores heating. Curve P23 remains 0–40 °C; mode uses the enum. | `tests/heat-automation.test.js`: `DHW compressor protection steps the curve down after three sustained minutes`; input guards in `tests/test-gx-scenarios.test.js` |
| F40-08 | Heating power controller | A rolling 10-minute supply-setpoint lag, supply-return gap, and compressor current determine one mode step or a P23 boost. Mode is `mute`/`smart`/`strong`; boosted P23/P24 are limited by `curveCoeffs` (P23 0–40 °C, P24 ≤30). Step interval is at least 10 min. | `tests/heat-automation.test.js`: `heating controller with the GX settings keeps Silent and writes nothing while the supply is on the curve`, `a redeployed heating controller collects a full window before its first and only step`, `heating controller holds during a DHW cycle and for 10 min after it` |
| F40-09 | Stuck-supply kick | With compressor running and supply flat below its active curve in Silent, send pump DP 2=`smart` for configured duration, then DP 2=`mute`; no kick during defrost/recovery, bypass, or an active controller decision. | `tests/heat-automation.test.js`: `with the GX kick settings a supply stuck below the curve gets Smart for about a minute, at most every 2 min` |
| F40-O1 | Output 1: Automations UI model | Returns current master, per-rule modes, DHW and heating controller state/configuration; no device write. | `tests/test-gx-scenarios.test.js`: `model, settings-save, log and settings-load outputs use their declared function ports` |
| F40-O2 | Output 2: pump Tuya commands | Queue to the pump proxy: DP 1 power boolean; DP 2 mode enum; DP 132 P22 string; DP 133 P23 °C (0–40); DP 134 P24 coefficient (1–30). | Seven-output wiring test; `tests/heat-automation.test.js` DHW, heating, and Er03 cases; YAML quiet-period and Er03 scenarios |
| F40-O3 | Output 3: settings file | `msg.filename` is `/data/home/nodered/grid-control-config/heat-pump-automations.json`; payload is serialized settings, no device write. | `tests/test-gx-scenarios.test.js`: `model, settings-save, log and settings-load outputs use their declared function ports` |
| F40-O4 | Output 4: bypass relay | Tuya SET relay DP 1, boolean; `true` bypasses the heat exchanger. | Defrost start/recovery tests |
| F40-O5 | Output 5: boiler valve relay | Tuya SET relay DP 1, boolean; `true` routes to DHW. | Er03 restart / DHW tests and Er03 YAML scenario |
| F40-O6 | Output 6: automation event | JSON line to the daily log file and `msg.event` to nodes 42 and 47. Values include run, rule, kind, live state and text; not a Tuya write. | `tests/test-gx-scenarios.test.js`: output-port test and `an offline pump is safe for the automation and raises an alert digest` |
| F40-O7 | Output 7: settings reload | Requests the settings file after a node start with empty context; output filename is the same settings path as F40-O3. | `tests/test-gx-scenarios.test.js`: `model, settings-save, log and settings-load outputs use their declared function ports` |

## Node 42: Automation log

| ID | Decision / output | Expected effect | Coverage |
|---|---|---|---|
| F42-01 | `ui` open/day/refresh | Validate the day, then output 2 requests the selected JSONL file and day counts through the read exec node. | `tests/test-gx-scenarios.test.js`: `automation log requests a day file and groups its events for the UI` |
| F42-02 | Read result / live event | Parse day events, group events by run and return the page model on output 1; retain up to 400 days, deleting older files when a day is read. | `tests/test-gx-scenarios.test.js`: `automation log requests a day file and groups its events for the UI`; actual filesystem deletion is Uncovered (U2). |

## Node 47: Heat pump alerts

| ID | Decision / output | Condition and expected effect | Coverage |
|---|---|---|---|
| F47-01 | Alert selection and digest | `error`/`fail`, DHW warnings/aborts, Er03 restart, compressor protection, hard limit, lost sequence, and device-down/back events enter the digest. Wait 2 min to gather; send no more than one digest per 15 min; repeat lines are counted. | `tests/test-gx-scenarios.test.js`: `an offline pump is safe for the automation and raises an alert digest` |
| F47-02 | Offline safety and notification | Offline/stale pump prevents node 40 control writes; node 47 adds a device-down alert after 10 min and digests it after the 2-minute gather delay. Output 1 writes a mail JSON file for the existing exec sender; it does not write to `/writes`. | YAML `Er03 offline pump guard`; `tests/test-gx-scenarios.test.js`: `an offline pump is safe for the automation and raises an alert digest`, `heat pump alerts wait 10 minutes before digesting a disconnected device`. SMTP delivery is Uncovered (U3). |

## Scenario-to-inventory coverage gaps

- **U1 — API injection limits:** the emulator validates `/set` values and has no endpoint to remove one DPS or submit JavaScript `NaN`. The 51 missing/stale/NaN variants are tested against the actual function source in `tests/test-gx-scenarios.test.js`, not as API-driven YAML scenarios. `/fail invalid` only publishes the emulator's invalid sentinels.
- **U2 — filesystem / exec effects:** `/writes` records device commands, not settings/log file contents, exec shell commands, or UI rendering. Node 40 output ports and settings payloads are checked in-process; node 42 file retention and exec output are not exercised by the API runner.
- **U3 — external mail:** alert digest selection/content is unit-tested, but sending through the configured SMTP account is not part of this test.
- **U4 — deploy window:** `tools/gx/window.js` is tested directly in `tests/test-gx-scenarios.test.js` while a DHW cycle is active. The scenario runner observes emulator device writes only and cannot assert the deploy CLI's WAIT verdict.
- **U5 — persisted curve bounds:** node 40 accepts finite `settings.heatCurve.p23/p24` values from its JSON file without validating them against pump bounds, then may restore them as DP 133/134. The API runner cannot inject that file; `tests/heat-automation.test.js` reproduces this as expected_fail HP-SETTINGS-1. Do not repair production code in the Test GX scenario branch.

## Suspected bugs

- **HP-SETTINGS-1:** out-of-range but finite saved heating-curve values are not range-checked on load, and the in-process reproduction queues out-of-range DP 133/134 commands. Expected failure is tracked in the test above; uncovered by YAML for U5.
