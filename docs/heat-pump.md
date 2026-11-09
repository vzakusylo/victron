[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md) · **Heat pump**

# Heat pump (Tuya, local)

> Moving the air-to-water heat pump from Tuya cloud scenes to Node-RED on the GX — stage 1: monitoring page with power meter, history by day and two manual controls (curve shift, bypass)

**On this page:**

- [Why](#why)
- [Devices](#devices)
- [Network](#network)
- [Setup](#setup)
- [Heat Pump page](#heat-pump-page)
- [Data points](#data-points)
- [Roadmap](#roadmap)

## Why

The heat pump is today controlled by Tuya cloud scenes (DHW ladder, defrost/bypass handling, weather curve). Cloud scenes re-fire on every sensor report, react with delay and race each other (false defrost on compressor start, stuck bypass). Running the same logic locally on the GX removes those problems and lets the heat pump work together with the capacity-tariff control (block DHW heating near the hourly limit, heat the tank at night) — without Home Assistant.

## Devices

| Role | Tuya name | Device ID | IP / protocol | Notes |
|---|---|---|---|---|
| Heat pump | Heating pump | `bf3f2552b6fcd2c689fzre` | 192.168.1.31 / 3.3 | product `5oc9wmac3bbidekc`, controller PW58280 (Powerworld/Michl, inverter 3-in-1) |
| 3-way valve relay | Boiler | `bf894708aa7e3ac196zjzk` | 192.168.1.53 / **3.5** | DP 1: ON = DHW tank, OFF = heating. Sends **no** UDP beacons → the IP must be set in the node |
| Heat exchanger bypass | Off Heating exchange | `bf3ff3d877d898b531cuoq` | 192.168.1.139 / 3.4 | DP 1: ON = bypass (exchanger off); plug with metering (DP 18 mA, 19 W × 10, 20 V × 10) |
| Heat pump power meter | SA1 Wi-Fi Smart Power Transformer | `bff533964da65dd78dlha6` | not reachable yet | measures the whole heat pump; decoded from DPs 18 / 19 / 20 or DP 6 `phase_a`. It is on the other (D-Link) Wi-Fi, which the GX cannot reach — move it to the ASUS Wi-Fi, then set its IP |
| (defrost flag for cloud scenes) | Voksen heating | `bf2e8c592bd8d22486nwux` | 192.168.1.148 / 3.5 | not used by the flow |

State on 2026-11-08 (d#122): heat pump, valve and bypass **CONNECTED**; the SA1 meter shows *ERROR / DISCONNECTED* until it is on the ASUS network, so the Power tile shows "—" and the Power chart has only the compressor estimate.

Local keys are **not** stored in this repository. They are typed into each Tuya node on the GX and kept in Node-RED credentials (`flows_cred.json`, not part of an export).

## Network

The GX and the Tuya devices must be in the same subnet (without an IP the node finds devices by UDP broadcast). Here both are on the ASUS network 192.168.1.x (`Telia-2FF703` and its repeater `Telia-2FF703_RPT` are one network with one DHCP), GX eth0 = 192.168.1.94. The device IPs are pinned in the ASUS DHCP list (LAN → DHCP Server → Manual Assignment; Apply restarts the router's Wi-Fi for ~30 s, the Tuya nodes reconnect by themselves). The main D-Link network (192.168.0.x) seems to isolate Wi-Fi clients, so Tuya devices there are not reachable from the GX.

## Setup

1. Node-RED → Manage palette → Install `node-red-contrib-tuya-smart-device` (tested against 5.4.0).
2. Import / deploy `flows.json` (tab `d#112` or later).
3. Open each of the four Tuya nodes (`Heating pump`, `Boiler valve relay`, `Off Heating exchange`, `SA1 power meter (heat pump)`), tick *Store as credentials* (already on), enter the **Device ID** and **Local Key**, optionally the IP, version `3.3` (try `3.4` or `3.5` if it never connects). Deploy.
   The `Boiler valve relay` speaks **3.5** and sends no UDP discovery beacons, so it needs its IP set (`192.168.1.53`, behind the ASUS router); without it the node stays DISCONNECTED (`find() timed out`). To find a device that does not broadcast: take its MAC from Smart Life Web → Device Details and look it up in the GX ARP table (`ip neigh`).
4. Open the dashboard → **Heat Pump**. Node status under each Tuya node shows connecting / connected.

Get the local keys from platform.tuya.com → Cloud → project → API Explorer → *Query Device Details in Bulk*, or with `python -m tinytuya wizard`. A key changes if the device is removed and paired again in Smart Life.

Note: many Tuya devices accept only **one local connection**. Do not run tinytuya / Home Assistant locally against the same device at the same time. The Smart Life app and cloud keep working.

## Heat Pump page

Flow nodes:

- `Poll heat pump (GET, read only)` — every 30 s (was 60 s before d#114) sends `{"operation":"GET","schema":true}` to the four Tuya nodes. **Always send an explicit `operation`**: the Tuya node treats a message without it as `SET`.
- four `tuya-smart-device` nodes → `topic = hp | valve | bypass | meter` → `Heat pump state` (`34 Heat pump state.js`)
- `Heat pump page` (ui_template, source `35 Heat pump page.html`), `Heat pump temperatures` (24 h chart: supply, return, tank, outdoor; one point per minute) and `Heat pump power` (24 h chart, W: meter and compressor estimate)
- `Heat pump command` (`37 Heat pump command.js`): the only node that writes to the devices; also starts the history reads
- `Read heat pump history` (exec) → `Build heat pump history` (`38`) → `Heat pump history` (ui_template, `39 Heat pump history page.html`)

The page shows connection state of each device, supply / return / tank / outdoor, compressor Hz, fan, set points, mode, curve P22–P24, valve and bypass state, a defrost sign (fan 0 while compressor > 30 Hz), decoded faults (`Er03`…`Er70`) and a table of every DP received (unknown DPs listed separately).

State is kept in `flow.heatPump` (raw DPs per device) and `flow.heatPumpModel` (page model).

**Compressor load card (d#114, maxima d#116):**
- rated maxima: 91 Hz and 8 A (constants `COMPRESSOR_MAX_HZ` / `COMPRESSOR_MAX_A` in `34`);
- frequency % = DP 115 / 91, current % = DP 112 / 8, each clamped to 0–100;
- load % = the higher of the two. Example: 69 Hz, 3 A → 76 % / 38 % → **76 %**;
- power ≈ DP 112 (compressor current) × DP 114 (DC bus voltage; 230 V until received).

This is an estimate: power factor and drive losses are ignored, and there is no power DP.

**Power meter SA1 (d#121):**

`meterReading()` in `34` decodes the meter into `flow.heatPump.meter.reading` (`powerW`, `voltageV`, `currentA`, `energyKwh`, `source`). It understands two common Tuya layouts:

| Layout | DPs |
|---|---|
| Plug / breaker | 18 = mA, 19 = W × 10, 20 = V × 10 |
| Energy meter | 6 `phase_a` = base64 of voltage (2 bytes, 0.1 V), current (3 bytes, mA) and power (3 bytes, W); 1 = total energy in 0.01 kWh |

If the meter uses other DPs, the Power tile shows "—". The page then lists the raw meter DPs, so the map in `meterReading()` can be extended. The value counts as fresh for 5 min.

**Controls (d#121).** Both are sent through `Heat pump command` (`37`) and only after a confirm dialog in the browser:

| Control | Page | Sent | Checks in 37 |
|---|---|---|---|
| Curve shift, *colder ← → warmer* | slider under the heating curve, with a dashed preview line and the set point at the current outdoor temperature before → after | `{"operation":"SET","dps":133,"set":<P23>}` to `Heating pump` | integer 20…40 |
| Bypass | *Turn bypass ON / OFF* button | `{"operation":"SET","dps":1,"set":true/false}` to `Off Heating exchange` | boolean |

Each +1 °C of P23 raises the curve by P24 / 10 °C (0.4 °C with P24 = 4) at every outdoor temperature. P22 and P24 are not changed.

Every write also requires the target device to be CONNECTED with data ≤ 5 min old, and allows at most one write per device every 5 s. A same-value P23 is ignored. Writes are logged with `node.log`.

A Tuya cloud scene that also switches the bypass (the DF… scenes) can switch it back. Disable those scenes to keep manual control.

**History by day (d#121):**

On open, the `Heat pump history` template sends `{topic:'summary'}`. `37` then builds an `sh -c` script for the exec node `Read heat pump history`. The script prints `#day <date>` and runs `gzip -dc` / `cat` over the hour files of the last 14 day folders. Days already in `flow.hpDayCache` are only marked `cached`.

`38` parses the hp1 sections. It uses only rows where the heat pump letter is `C`, and weights each row by the time to the next row (max 120 s). Per day it gives:

| Group | Values |
|---|---|
| Temperatures | outdoor, supply, return and tank: min / average / max |
| Compressor | run hours and %, starts, average Hz while running, defrost signs |
| Relays | bypass hours and DHW (valve) hours |
| Measured energy | kWh, average and max W from the meter (`pw`) |
| Estimate | compressor ≈kWh from A × V |
| Data | hours with data |

Clicking a day sends `{topic:'day', payload:{day}}`. The answer adds an hourly table and an SVG chart: temperatures on top and W below, as 2-minute averages.

Finished days are cached in `flow.hpDayCache` (memory, last 60 days, lost on restart). Day names are checked against `YYYY-MM-DD` before they go into the shell script. Reading 1 day of files takes ~70 KB and the parsing takes ~20 ms.

**History recorder (d#120; replaces the d#114 text log):**
- Nodes: `Heat pump log tick (30 s)` → `Record heat pump data` (`36 Record heat pump data.js`) → `Append heat pump data` (file) + `Compress heat pump hours` (exec `sh -c`, gzip).
- What is stored: every DP of the heat pump, the valve relay (`v…`), the bypass relay (`b…`) and the SA1 power meter (`m…`, d#121), the decoded heat pump power `pw` in W (d#121, only while the meter is fresh), plus the connection state, every 30 s.
- Files: `/data/home/nodered/grid-control-logs/heatpump/YYYY-MM-DD/HH.csv`, one per hour (local time of the GX). Finished hours are gzipped when a new hour starts and after a restart. The current hour stays plain.
- Format `hp1`, a delta CSV:
  - a `#hp1 <date> <hour> cols=t,st,<dp>,…` header, then a keyframe row with every column;
  - then rows `t,st,changed values…` with empty = unchanged and trailing empties dropped;
  - `t` = second of the hour;
  - `st` = one letter each for hp / valve / bypass / meter (3 letters before d#121): C connected, N connecting, D disconnected, E error, U unknown, S stale > 180 s;
  - booleans are 1 / 0, text is as is (`,` → `;`);
  - a new section (header + keyframe) starts every hour, after a restart / deploy and when a new DP appears.
- Size (simulated 40 DPs with realistic changes): ~4 KB per hour plain, ~1.1 KB gzipped, so about 26 KB per day and ~10 MB per year.
- Decode: `node tools/heatpump-decode.js [--names] HH.csv[.gz] …` prints one full CSV row per sample with a timestamp; `--names` gives readable column names.
- The old `heatpump-YYYY-MM-DD.log` text files written by d#114–d#119 are left as they are.

## Data points

From the Tuya cloud thing model of the heat pump (product `5oc9wmac3bbidekc`):

| DP | Code | Meaning | Access | Range |
|---|---|---|---|---|
| 1 | switch | power | rw | bool |
| 2 | mode | smart / strong / mute (Smart / Powerful / Silent) | rw | enum |
| 5 | work_mode | wth / heat / cool / wth_heat / wth_cool | rw | enum |
| 15 | fault | faults bitmap Er03…Er70 | ro | bitmap |
| 101 | intemp | water in (return) | ro | °C |
| 102 | outtemp | water out (supply) | ro | °C |
| 103 | whjtemp | ambient / outdoor | ro | °C |
| 104 | cmptemp | discharge | ro | °C |
| 105 | hqtemp | suction | ro | °C |
| 106 | ptemp | outdoor coil | ro | °C |
| 107 | cptemp | cooling coil | ro | °C |
| 108 | wttemp | DHW tank | ro | °C |
| 109 / 111 | step_run / stepb_run | main / EVI expansion valve | ro | 0–500 P |
| 112 | cmp_cur | compressor current | ro | A |
| 113 | sink_temp | heatsink | ro | °C |
| 114 | dc_bus_voltage | DC bus | ro | V |
| 115 | cmp_act_frep | compressor frequency | ro | Hz |
| 116 / 117 | dc_fan_speed / dc_fan2_speed | fans | ro | 0–1500 |
| 121 / 122 | aircond_temp_diff / wth_temp_diff | heating / DHW hysteresis | rw | 2–18 °C |
| 123 | wth_stemp | DHW set point | rw | 28–60 °C |
| 124 | acc_stemp | cooling set point | rw | 7–30 °C |
| 125 | ach_stemp | heating set point | rw | 15–55 °C |
| 126 | water_temp_compenst | water temp compensation | rw | −5–15 °C |
| 132 | heat_target_temp_auto_adj | P22 weather curve on/off | rw | 0/1 |
| 133 | heat_compst_temp_point_hj | P23 ambient point | rw | 0–40 °C |
| 134 | target_temp_compst_xs | P24 coefficient | rw | 1–30 |
| 135 | hwh_freq_run_mode | frequency mode at set point | rw | 0/1 |
| 136 | eheat_start_hj_temp | electric heater start ambient | rw | −20–20 °C |
| 137 | wt_eheat_enter_tm | tank e-heater delay | rw | 0–60 min |
| 138 | hw_waterp_mode | water pump mode | rw | 0/1 |
| 139 / 140 / 141 | defr_enter_temp / defr_exit_temp / defr_hj_coil_temp_diff1 | defrost thresholds | rw | °C |
| 142 / 143 | hw_run_freq_min / hw_run_freq_max | frequency limits | rw | 30–120 Hz |
| 144 | wth_compenst_freq | DHW frequency compensation | rw | −50–20 Hz |

Built-in curve (P22 on): heating set point = 20 + (P24 / 10) × (P23 − outdoor), 20…60 °C (P24 = 4 → 0.4).

The Heat Pump page draws this curve (d#118), for outdoor −25…+25 °C. It marks the current point: the curve target at the current outdoor temperature, the reported heating set point (DP 125) and the supply temperature. A table lists −20…+15 °C. With P23 = 37 and P24 = 4 (P23 raised from 32 on 8 Nov 2026 = +2 °C at every outdoor temperature; roll back = P23 32):

| Outdoor °C | −20 | −15 | −10 | −5 | 0 | 5 | 10 | 15 |
|---|---|---|---|---|---|---|---|---|
| Set point °C | 42.8 | 40.8 | 38.8 | 36.8 | 34.8 | 32.8 | 30.8 | 28.8 |

Check of the formula: with P23 = 32 at −3 °C outdoor the curve gave 34 °C and the pump reported 35 °C (DP 125); with P23 = 37 at −1 °C the curve gives 35.2 °C and the pump reports 35 °C. So the formula is close but not confirmed exactly. If the two keep differing, the controller rounds or offsets differently.

## Automations page (d#123–d#126)

All Smart Life scenes of the heat pump (**B\*** DHW cycles and modes, **DF\*** defrost handling, **HP\*** scenes) run as local rules on the GX. Node `Heat pump automations` ([`40`](../40%20Heat%20pump%20automations.js)) and the **Automations** dashboard tab ([`41`](../41%20Automations%20page.html)):

- **Master switch** "Local control ON / OFF" for all local automations. **OFF is the default**: no local rule writes to a device, but rules set to On or Test are still evaluated and every step is logged as "would …". Turning it OFF also stops running live sequences.
- **Per rule: Off / Test / On** (stored as `off` / `dry` / `live`). Off = not evaluated; Test = evaluated, steps only logged; On = writes, only while the master is ON. Default: Test for the 19 rules of d#125, Off for the 9 rules added in d#126. **All rules at once:** buttons *all Off / all Test / all On*. Before a rule goes On, switch the matching Smart Life scene off, otherwise both act. Switching a rule Off also stops its running sequence.
- **Write check:** 15 s after each write the rule compares the value the device reports with the value it sent and logs `ok` or `fail` (like *Executed* / *Failed* in the Smart Life log).
- **Sequences:** each rule runs the same steps and delays as its cloud scene (e.g. *B46 off* lowers the set point in 1-min steps over ~6 min). A rule does not start again while its own sequence runs. All device writes go through one queue, 1.5 s apart.
- **Internal defrost flag** instead of the cloud-only *Voksen heating* device: set and cleared exactly where the cloud scenes set it (DF exchange off / DF switch to heating / B* switch → ON; DF exchange on 31 after 7 min → OFF) and cleared after 10 min at the latest (*DF safe 10min*). It is internal state, not a device, so it also moves in `dry`. The page shows it and has a *reset flag* button.
- **Safety:** every device a rule reads must be CONNECTED with data ≤ 5 min old; the conditions must hold on 3 ticks in a row (tick 10 s); then the rule rests (10–30 min).
- **Settings** (master, modes) are kept in `/data/home/nodered/grid-control-config/heat-pump-automations.json` and read on start. A missing or broken file means master OFF, every rule at its default.

**Local rules (28)** — DPs: 2 mode, 5 work mode, 15 faults (bit 0 = Er03), 102 supply, 103 outdoor, 108 tank, 115 Hz, 116 fan, 125 set point, 132 P22; valve ON = DHW, bypass ON = exchanger bypassed. Default Test, except the rules marked *(Off)*:

| Rule | Smart Life scene (runs 7–8 Nov) | If | Then (steps) |
|---|---|---|---|
| `df_exchange_off` | DF exchange off (45) | fan 0, > 30 Hz, bypass OFF, supply < 27, outdoor < 14 | bypass ON, flag ON |
| `df_exchange_on` | DF exchange on 31 (49) | bypass ON, fan > 300, supply > 27, set < 45, P22 on | bypass OFF, wait 7 min, flag OFF |
| `df_switch_to_heating` | DF switch to heating (6) | fan 0, > 30 Hz, valve ON, outdoor < 14, flag OFF, set 40/42/46/50 | flag ON, valve OFF, bypass ON |
| (built in) | DF safe 10min (59) | flag ON ≥ 10 min | flag OFF |
| `b40_on` | B40 on <36 -20..-11 | tank < 36, valve OFF, supply > 35, outdoor −20…−11, bypass OFF, set < 40 | P22 off, Powerful, set 40, bypass ON |
| `b40_switch` | B40 switch >37 | valve OFF, fan > 250, set 40, supply > 37, flag OFF | flag ON, set 20, wait 1 min, valve ON, set 40, bypass OFF |
| `b40_off` | B40 off >39 | outdoor −20…−11, tank > 39, fan > 300, supply > 38, set 40, valve ON | set 37, valve OFF, wait 4 s, set 37, valve OFF, P22 on |
| `b42_on` | B42 on <41 -10..-5 | outdoor −10…−5, tank < 41, fan > 400, supply > 35, valve + bypass OFF, set < 40 | P22 off, Powerful, set 42, bypass ON |
| `b42_switch` | B42 switch >39 | supply > 39, set 42, valve OFF, fan > 300, flag OFF | flag ON, set 20, wait 1 min, valve ON, set 42, bypass OFF |
| `b42_off` | B42 off >42 | tank > 42, supply > 41, valve ON, set 42 | set 41, wait 10 s, valve OFF, set 41, wait 1 min, set 39, wait 1 min, valve OFF, Silent, wait 3 min, then the steps of the scene *Slowly cool down*: set 39, P22 on, wait 2 min, set 38, wait 3 min, set 37 (d#129; the cloud starts the scene and sets P22 on at the same moment) |
| `b46_on` | B46 on <44 -4..1 (6) | tank < 44, outdoor −4…1, fan > 300, supply > 30, valve + bypass OFF, set < 40 | P22 off, Smart, set 46, bypass ON |
| `b46_switch` | B46 switch >38 (15, 4 failed) | supply > 38, fan > 40, valve OFF, set 46, flag OFF | flag ON, set 20, wait 1 min, valve ON, set 46, bypass OFF |
| `b46_off` | B46 off >46 -4..1 (8, 3 failed) | tank > 46, fan > 400, supply > 46, valve ON, outdoor −4…1, flag OFF, set 46 | set 45, bypass OFF, 10 s, set 45, 3 s, valve OFF, 2 s, valve OFF, then set 43 → 41 → 39 → 38 → 35 one per minute, Silent, P22 on |
| `b50_on` | B50 on <47 >1 | tank < 47, outdoor > 1, valve OFF, flag OFF, bypass OFF, heat pump on | P22 off, set 50, bypass ON |
| `b50_switch_warm` | B50 switch >47 >0 | valve OFF, set 50, outdoor > 0, tank < 49, flag OFF, supply > 47 | flag ON, set 20, wait 1 min, valve ON, set 50, bypass OFF |
| `b50_switch_cold` | B50 switch >45 <1 | supply > 45, set 50, valve OFF, outdoor < 1, flag OFF, tank < 49 | same as above |
| `b50_off` | B50 off >49 | tank > 49, valve ON | Silent, set 25, valve OFF (×3 over 30 s), flag ON 10 s, P22 on |
| `b50_preheat_bypass` | B50 preheat exchange off | set 50, valve OFF, bypass OFF, tank < 50 | bypass ON |
| `b42_mode_smart` | B42 mode silent-smart <44 | Silent, set 42, supply < 44 | Smart |
| `b42_mode_smart45` *(Off)* | B42 mode silent-smart <45 | Silent, supply < 45, fan > 300, set 42 | Smart |
| `b42_mode_silent_valve` *(Off)* | B42 mode smart-silent >6a | set 42, supply > 44, Smart, valve ON | Silent |
| `b42_mode_powerful_silent` *(Off)* | B42 mode powerful-silent >45 | supply > 45, fan > 300, set 42, Smart or Powerful | Silent |
| `b46_mode_silent` *(Off)* | B46 mode smart-silent >48 | Smart, set 46, supply > 48 | Silent |
| `b50_force_heating` *(Off)* | B50 force heating mode | set 50, work mode Cooling | work mode Heating |
| `hp_silent_0` *(Off)* | HP silent >0 | outdoor > 0, flag OFF, set < 40, valve OFF, not already Silent | Silent |
| `hp_er03_restart` *(Off)* | HP Er03 restart | fault Er03 (water flow), valve ON | valve OFF, 30 s, valve OFF, pump OFF, 1 min, pump ON, bypass OFF, set 31, P22 on (cloud also disables the scene *zz boiler 50 on <47 >1*, already off — not included) |
| `hp_power_m16` *(Off)* | HP power <-16 (dead) | outdoor < −16, fan > 250, set < 37 **and** > 37, Smart or Silent — never true, as in the cloud | Powerful, notify |
| `hp_smart_m15` *(Off)* | HP smart -15..-7 (dead) | outdoor −15…−7, fan > 250, set < 35 **and** > 35, supply > 30, Powerful or Silent — never true | Smart, 15 min, notify |
| `b_recovery_valve_off` | B recovery off | valve ON, set 33/35/36/37 | valve OFF |

**Deploy / restart (d#127):** a new instance of the node drops running sequences and queued writes of the old one (their timers are gone) and logs it. This is the node's On Start code (`initialize` in `flows.json`, also quoted in the header of `40`; `Sync-40` only syncs `func`). A watchdog also drops a sequence whose next step is more than 1 min overdue and releases a stuck write gap. A running sequence stops as soon as its rule is no longer On (On → Test or Off), and its queued writes are dropped.

**Overlapping rules (as in the cloud):** `b50_switch_warm` and `b50_switch_cold` both match at 0 < outdoor < 1 °C, and `b50_on` / `b50_preheat_bypass` both switch the bypass ON. Both scenes act in the cloud too; check this before setting them On.

**No device is missing any more:** the defrost flag is internal. (The SA1 power meter is not used by any rule.) Smart Life scenes of other devices (*HOME dehum*, *HOME charger*) and the *LOG …* scenes (replaced by the Automation log) are not moved.

**Known limit (comparison of 9 Nov):** the cloud acts within seconds of a device report, the local rule needs its conditions on 3 ticks of 10 s. While a cloud scene is still on, it changes the state first (e.g. bypass ON at supply < 27), so the local rule in Test usually never sees its conditions for 30 s. The step sequences themselves matched the cloud (B46 on / switch / off on 9 Nov, 08:14–08:46).

**Next:** rule by rule: Smart Life scene off → rule On → master ON; check the run on the Automation log page. Rollback = master OFF and the scenes on again.

## Automation log page (d#126)

Every event of the local automations is one JSON line in `/data/home/nodered/grid-control-logs/automations/YYYY-MM-DD.jsonl` (local date of the GX, file node *Append automation log*): `{ t, kind, text, rule, cloud, run, live }`. Kinds: `test` / `start` (a rule run begins), `dry` / `write` / `step` (steps), `ok` / `fail` (write checked against the device), `done` / `stop` (run ends), `flag`, `setting`, `warn`. Events of one run share `run`.

The **Automation log** dashboard tab (function `Automation log` [`42`](../42%20Automation%20log.js), exec node *Read automation log*, ui_template [`43`](../43%20Automation%20log%20page.html)) shows one day like the Smart Life log:

- **Navigation by day:** previous / next day, *today*, a date picker, and chips for the last 21 days that have a file, with the number of events.
- **One entry per rule run:** time, scene name, status (*executed*, *failed*, *stopped*, *test*, *running*), number of confirmed / failed writes; tap to see every step with its time. Settings, flag and warning events are listed between the runs.
- **Filters:** All, Runs, On (writes), Failed / stopped, Test, Settings / flag. While the page shows today, new events appear at once.
- Files are small (about 100–200 bytes per event). Day files older than 400 days are deleted when the page reads a day (d#127).

## Migration log (Smart Life → GX)

Which Smart Life scenes are switched off and run on the GX instead. Settings file on the GX: `/data/home/nodered/grid-control-config/heat-pump-automations.json`. **Rollback** for any step: *Turn OFF all local automations* on the Automations page and switch the listed scenes on again in Smart Life.

| Date | Smart Life scenes switched OFF | Runs in 2 days before (Smart Life log, 7 Nov evening – 9 Nov) | GX rules set On | Local control | Result |
|---|---|---|---|---|---|
| 2026-11-09 10:53 | DF safe 10min, DF exchange on 31, DF exchange off, DF switch to heating | 46, 41, 39, 1 | `df_exchange_off`, `df_exchange_on`, `df_switch_to_heating` (DF safe 10min is built into the node) | ON | first local defrost expected ~11:29, check on the Automation log page |
| 2026-11-09 10:53 | B46 on <44 -4..1, B46 switch >38, B46 off >46 -4..1, B46 mode smart-silent >48 | 4, 6 (1 failed), 8 (3 failed), 5 | `b46_on`, `b46_switch`, `b46_off`, `b46_mode_silent` | ON | first local B46 cycle when the tank drops below 44 °C at −4…1 °C outdoor |

| 2026-11-09 11:58 | B50 on <47 >1, B50 switch >47 >0, B50 switch >45 <1, B50 off >49, B50 preheat exchange off, B50 force heating mode | 0 in the log above; 1 false start at 11:29 (see below) | `b50_on`, `b50_switch_warm`, `b50_switch_cold`, `b50_off`, `b50_preheat_bypass`, `b50_force_heating` (d#128: B50 on / preheat blocked during and 15 min after a defrost) | ON | the DHW cycle the cloud started at 11:29 is ended by the local `b50_off` (tank > 49 °C) |

| 2026-11-09 12:47 | HP Er03 restart, HP silent >0, B40 on <36 -20..-11, B40 switch >37, B40 off >39, B42 on <41 -10..-5, B42 switch >39, B42 off >42, B42 mode silent-smart <44, B42 mode smart-silent >6a, B42 mode powerful-silent >45, B42 mode silent-smart <45 | 0 (outdoor −5…+1 °C) | `hp_er03_restart`, `hp_silent_0`, `b40_on`, `b40_switch`, `b40_off`, `b42_on`, `b42_switch`, `b42_off`, `b42_mode_smart`, `b42_mode_smart45`, `b42_mode_silent_valve`, `b42_mode_powerful_silent` (d#129: B42 off now includes the steps of *Slowly cool down*) | ON | B40 runs at −20…−11 °C and B42 at −10…−5 °C, so they are first checked on a colder day |

| 2026-11-09 13:00 | B recovery off (it was already off in Smart Life when checked; when it was switched off is not known) | 0 | `b_recovery_valve_off` | ON | — |

**First local runs (2026-11-09):** 12:11 `b50_off` ended the DHW cycle (8 writes, all confirmed); 12:30 `df_exchange_off` set bypass ON and the flag; 12:39 `df_exchange_on` set bypass OFF (both writes confirmed); 12:46 it ended.

Still in Smart Life (2026-11-09 13:00): HP power <-16 and HP smart -15..-7 (their conditions can never be true; their GX rules stay Off), the HOME and LOG scenes. 26 of the 28 GX rules are On, so all heat pump, valve and bypass control runs on the GX. If Node-RED or the GX stops, no scene switches the valve or the bypass; the pump keeps heating on its own curve (P22).

The cloud log (Smart Life → Scene Automation → Log) no longer lists the moved scenes: local rules write to the devices over the LAN and start no cloud scene. Their runs are on the Automation log page. The LOG scenes that are still on react to the device state, so they can still appear after a local action (e.g. *LOG 50* when the set point becomes 50).

**Incident 2026-11-09 11:29 (why B50 was moved too):** with the DF scenes off in the cloud, nothing set the cloud flag *Voksen heating* any more. During the defrost at 11:28 the outdoor sensor (DP 103) heated up to 3 °C and then 36 °C, so the cloud *B50 on* ("outdoor > 1") started a DHW cycle at an outdoor temperature of −1 °C (set 50, bypass ON, P22 off). The cloud flag used to block it. It also beat the local *DF exchange off* to the bypass, so no local rule ran. At 11:48 *B50 switch* moved the valve to the tank; the compressor stood still until 11:52, the normal pause after set point 20. The B50 scenes now run on the GX, where *B50 on* and *B50 preheat* do not start during a defrost or for 15 min after it.

Since 12:47 every scene that reads the cloud flag *Voksen heating* runs on the GX with the internal flag, so the cloud flag is no longer used.

## Roadmap

1. **Stage 1** — monitoring page, 30 s history with statistics by day, SA1 power meter; manual controls only (curve shift P23, bypass on/off, d#121). Compare with the Tuya log for a day.
2. **Stage 1b (now, d#123–d#126)** — Automations page: master switch, per-rule Off / Test / On and all at once, internal defrost flag, all heat pump scenes as timed sequences, write check, Automation log by day; switch rule by rule On and the scene off (see above).
3. **Stage 2** — a controller state machine in `40 Heat pump automations.js`: HEATING → DHW_PREHEAT → DHW_STOP_WAIT (set point 20, 60 s) → DHW_HEAT → back; DEFROST_HEATING / DEFROST_DHW. Defrost sign must hold 60–90 s and is ignored 3–5 min after a compressor start; bypass watchdog (≤ 20 min); safe state if a device is silent > 5 min (valve → heating, bypass off, P22 on). Dry-run first (log decisions, send nothing).
4. **Cutover** — disable Tuya cloud scenes B…, DF…, HP silent, B46 mode, HP Er03 restart; enable sending from Node-RED. Rollback = master switch OFF on the Automations page, re-enable the scenes. Started 2026-11-09 with the DF and B46 scenes, see [Migration log](#migration-log-smart-life--gx).
5. **Stage 3** — link with the grid controller: hold DHW heating when the hourly import is close to the tier limit, prefer DHW at night (22–06); MCP tool `get_heat_pump`.

---

← [Development & deployment](development.md) | [Home](../README.md) →
