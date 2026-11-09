# Heat pump work log and instructions

What was done to move the Tuya heat pump control from Smart Life to the Cerbo GX, in order, with the owner's requests, the decisions and the results. Then the instructions for running and changing it. Details of each part are in [heat-pump.md](heat-pump.md) and [heat-pump-dhw-controller.md](heat-pump-dhw-controller.md).

Language rule: everything in the repository (code, comments, docs, commit messages) is in English.

## History

### Before this log (d#112–d#122)

| Version | What |
|---|---|
| d#112 | Read-only Heat Pump page from the local Tuya connection (DP map of product `5oc9wmac3bbidekc`). |
| d#114–d#118 | Compressor load estimate, heating curve chart (P22 / P23 / P24). |
| d#121 | SA1 power meter role, history by day, warmer / colder slider (P23), bypass switch. |
| d#122 | Boiler valve relay on Tuya 3.5 with a fixed IP (it sends no UDP beacons). |

### 2026-11-08 – 2026-11-09: local automations (d#123–d#139)

| Version | Owner request | What was built | Result |
|---|---|---|---|
| d#123–d#125 | Run the Smart Life heat pump scenes locally. | Automations page, master switch, per-rule mode, internal defrost flag instead of the cloud-only *Voksen heating* device, sequences with delays. | Rules evaluated next to the cloud scenes. |
| d#126 | "All heat pump scenes in Node-RED, switch them on / off globally and one by one, a log page with all events saved to files, navigable by day like Smart Life." | All 28 scenes as rules with Off / Test / On, all-rules buttons, day files `grid-control-logs/automations/YYYY-MM-DD.jsonl`, write check (ok / fail), Automation log page. | — |
| — | "Compare the dry run with Smart Life." | Comparison of 9 Nov: step sequences matched; the local rule needs 3 ticks of 10 s, the cloud acts in seconds. | Documented as a known limit. |
| d#127 | Review of PR #11 (Auto-fix). | Shell quoting in the log reader, sequences dropped after a deploy, On → Test stops writes, 400-day log retention. | Fixed. |
| — | "Switch off the cloud automations that ran in the last 2 days and run them locally", then by groups. | Migration log in heat-pump.md: DF and B46 scenes off in Smart Life, rules On on the GX. | First local runs 12:11 (B50 off) and 12:30 / 12:39 (DF exchange off / on), all writes confirmed. |
| d#128 | "Move B50" after the cloud B50 started a DHW cycle during a defrost (outdoor sensor reads 30–47 °C then). | B50 on / preheat wait 15 min after a defrost. | B50 scenes moved. |
| d#129 | "Move HP Er03 reset, HP silent >0, B40, B42." | B42 off includes the steps of *Slowly cool down*. | Moved; B recovery off moved too. |
| — | "The boiler heating is on but it does not heat." | Diagnosis on the GX (sequence and set point check). | Led to the DHW controller. |
| d#130–d#131 | Long requirements list: heat the tank by an editable outdoor curve; staged switch (compressor stop, valve, set point); switch only when it does not cool the tank; Silent / Smart / Powerful automatically; protect the compressor; smooth ramps; supply − return gap 5–6 °C; frost and efficiency limits (electric heater at the top of the tank); heating first in hard frost; at most one cycle per 2 h. | DHW controller (one state machine, R1–R16 in heat-pump-dhw-controller.md), settings on the Automations page, event lane on the history chart; settings file read again after a deploy wiped the context. | Controller On at 13:48. |
| d#132 | "Use the Smart Life sensors *accumulator tank temp* and *exchange plate*, record them like the heat pump, add them to the charts." | Read from the Tuya cloud OpenAPI every 2 min (`tools/tuya-cloud-status.js`, function 44); tiles, chart series, recorder columns. | Working (acc 25.5 °C, plate 28 °C at first read). |
| d#133 | "Find the compressor model, calculate the load accurately, count and save the compressor resource (bought 2022-01-01); where does *Power (24 h), W* come from?" | Nameplate PW030-DKZLRS-A: power ≈ current × 220 W/A, load = power / 2130 W; resource counters saved to `compressor-resource.json` (estimate before 2026-11-08, measured after). | ~36.7 % of an assumed 60 000 h. |
| d#134 | "Check why the boiler does not start." | It started at 20:49: the tank fell below target − 3 (42 °C) at ~20:43, during the 15-min wait after a defrost. Then preheat did not reach the tank temperature in 25 min. | — |
| d#134 | "Delete the automations the boiler curve covers." | 23 rules deleted from `40`: B40 / B42 / B46 / B50 on / switch / off and their mode rules, DF switch to heating, B recovery off, HP silent >0. Left: DF exchange off / on, HP Er03 restart and the two never-true HP mode rules. | The tank is heated only by the DHW controller now. |
| d#134 | "Put the boiler curve right of the heating curve; heating on the left, boiler on the right." | Heat Pump page in two columns; boiler curve chart from `flow.dhwView` (written by `40`, built by `34`). | Checked with mock data in a browser. |
| d#134 | "Remove the boiler preheat; switch straight to the boiler: stop the compressor by lowering the set point, switch to the boiler, heat." | Cycle start: P22 off, Silent, bypass OFF, set point 20 → compressor stops → valve ON → set point ≤ return + 5. Same after a defrost during DHW. | Deployed 21:12; 21:14 valve to the tank, all writes confirmed; supply 43 / return 37, tank 41 → 45 °C. |
| — | "Read the accumulator and exchange plate sensors from the local network, not the cloud." | Test (not yet in the flow): the sensors sleep, but on wake they send a UDP beacon. *Exchange plate* is at 192.168.1.116 (protocol 3.4); 21:21 a local connection took 0.4 s and the sensor pushed DP 1 = 296 (29.6 °C) and DP 2 = 30 (%). The `get` request itself is answered with "json obj data unvalid" — the data comes as a push right after the connect. *Accumulator tank temp* is probably 192.168.1.160 (a beacon was seen, not decoded yet). Local keys of both are on the GX in `grid-control-config/tuya-local-sensors.json` (mode 600). | Built in d#135 (next row). |
| d#135 | "Build it" (local reader for both sensors). | `tools/tuya-local-sensors.js` listens for the beacons (630 s per run, restarted every 10 min, 30 s overlap), connects on each wake and prints the pushed DPs; function `46` passes them to `34` with the reading time; `44` asks the cloud only for a sensor without a local reading for 24 h; sensors count as fresh for 24 h (they report only on change). | Deployed 21:33; listener running. |
| d#134 / d#135 | "Remove the power chart at the bottom under the events." Then: "Remove *Temperatures (24 h)*, it duplicates the day navigation; add a nice legend there with day switching; move *Power (24 h), W* to the day view too; power = DC bus voltage × compressor current; add colour legends." | Power panel under the event lane removed; the 24 h ui_charts *Temperatures* and *Power* removed; history page: day switcher (‹ ›, day chips), temperature chart with event lane, separate power chart (DC bus × current, meter W), legends that hide / show a series on click. The ≈kWh estimate also uses DC bus × current (about 1.7× the nameplate-based A × 220 W/A of d#133; the Compressor load card stays on the nameplate). | 9 Nov: 23.4 kWh by DC bus × current. |
| d#136 | "Put the legend (supply, return, tank …) above the chart; show the values when the mouse points at it, as before." | Legends above the temperature and power charts; pointing at (or tapping) a chart shows a cursor line, a dot per series and a tooltip with the time, the event and every visible value (the builder sends a value per 2-min bucket). | Checked in a browser with the data of 9 Nov; deployed 21:41. |
| d#137 | (found while moving the DHW panel) | **Fix:** the new nodes of d#135 had the ids `hpl-fn-01` / `hpl-exec-01` of the Automation log (42) and replaced its function and exec node, so the Automation log page did not work from 21:33 to 21:48 (the day files were still written by their own node). The Automation log nodes are restored; the sensor nodes have their own ids `hpls-*`. | Deployed 21:48. |
| d#138 | "Move the DHW controller (tank by outdoor curve) from Automations to the heat pump." | DHW controller panel (Off / Test / On, reason, editable curve and settings) in the Boiler column of the Heat Pump page; requests go `35 → 37 (output 4) → 40`; the Automations tab keeps a status line. Also: 46 does not send DPs missing in a wake (battery state), so the last value stays. **Fix:** since d#135, `34` took `data.t` as the reading time for every device, but the Tuya nodes send `t` in seconds, so the heat pump, valve and bypass looked stale to `40` ("device not connected / stale"): the ramp-down after the 21:13 cycle stood at set point 49 °C with P22 off from 21:43 to 22:03, and no rule ran then. `34` now uses `data.t` only for the battery sensors (hot-fixed 22:03). | First cycle without preheat: 21:13–21:43, tank 41 → 46 °C. First local sensor reading 21:50 (Exchange plate 27.1 °C). |
| d#139 | "Delete it from the local automations." | The DHW controller status line is removed from the Automations tab; the controller is shown and set only on the Heat Pump page. | — |

## Instructions

### Access and deploy

- SSH: `ssh -i ~/.ssh/id_ed25519_cerbo root@192.168.0.110` (GX eth0 192.168.1.94 is on the Tuya network).
- Node-RED admin API on the GX: `http://127.0.0.1:1880` (use it over SSH). Deploy type `nodes`, with a copy of `flows.json` / `flows_cred.json` to `.node-red/backup-<date>-pre-d<N>` first.
- Every change: edit the numbered source file, sync it into `flows.json` (`sync-commands.ps1`), raise the tab label `d#N` by one, deploy only the changed nodes, check the tab label on the GX.
- New nodes: check that every id is new in `flows.json` **before** the deploy (`hpl-` was taken by the Automation log; d#137). Let the update script stop on a duplicate id (as the d#137 one does).
- Do not deploy `40` while a DHW cycle or its ramp-down runs: the node comes back with an empty context and would leave P22 off / the set point high.
- Send non-ASCII text (°, ≥, −) to the GX base64-encoded or from a foreground shell; a background PowerShell pipe corrupted it once.
- A deploy of a function node can come back with an **empty node context**. `40` reads its settings file again (On Start `needLoad`); the DHW controller then starts again from HEATING. Prefer to deploy `40` when no DHW cycle runs.

### Check the boiler

1. Automations tab: master *Local control* ON, DHW controller **On**. With the controller Off or Test, the heat pump does not heat the tank.
2. Heat Pump tab, right column: tank, target, *start below*, controller state and the reason why it waits (e.g. "tank 45 °C ≥ 42 °C", "defrost now or < 15 min ago", "last cycle … min ago").
3. Automation log tab: one entry per cycle with every step; each write is checked 15 s later (*confirmed* / *failed*).
4. Expected cycle: set point 20 → about 1 min later valve ON (DHW) → set point ≈ return + 5 °C, ramping 1 °C per minute → tank at target or max duration → valve OFF, set point down 1 °C per minute → P22 on.

### Change the boiler curve

Automations tab → DHW controller → edit the outdoor / tank points and the settings → Save. Values out of range are ignored (the log says "settings unchanged"). The Heat Pump page shows the new curve within 10 s.

### Rollback

- Whole local control: Automations tab → *Local control OFF*; then switch the needed Smart Life scenes on again. The B\* rules no longer exist on the GX; restoring them means reverting d#134 in git.
- One deploy: copy the files from `.node-red/backup-<date>-pre-d<N>` back and restart Node-RED.

### Tuya cloud and keys

- Cloud project *Home local* (Central Europe). Credentials only on the GX: `grid-control-config/tuya-cloud.json` (mode 600) and on the PC in `.secrets/` (git-ignored). Never put keys in the repository or in chat.
- Local keys: Node-RED credentials for the Tuya nodes; `grid-control-config/tuya-local-sensors.json` for the two battery sensors. A key changes when a device is paired again.
- Run tools that write caches in `/tmp` as the `nodered` user, not root.

### Open items

- Battery sensors: confirm that both sensors arrive locally (device chips show *(local)*); the accumulator sensor reports only on a change, so its first local reading can take hours.
- SA1 power meter: move it to the Telia / ASUS network, set its IP and key, then calibrate 220 W/A against the meter.
- Compressor run hours from the pump panel, if available, replace the weather estimate in `45`.
