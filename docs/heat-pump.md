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

## Roadmap

1. **Stage 1 (now)** — monitoring page, 30 s history with statistics by day, SA1 power meter; manual controls only (curve shift P23, bypass on/off, d#121). Compare with the Tuya log for a day.
2. **Stage 2** — a new controller node (e.g. `40 Heat pump controller.js`; 36–39 are taken): state machine HEATING → DHW_PREHEAT → DHW_STOP_WAIT (set point 20, 60 s) → DHW_HEAT → back; DEFROST_HEATING / DEFROST_DHW. Defrost sign must hold 60–90 s and is ignored 3–5 min after a compressor start; bypass watchdog (≤ 20 min); safe state if a device is silent > 5 min (valve → heating, bypass off, P22 on). Dry-run first (log decisions, send nothing).
3. **Cutover** — disable Tuya cloud scenes B…, DF…, HP silent, B46 mode, HP Er03 restart; enable sending from Node-RED. Rollback = disable the flow, re-enable the scenes.
4. **Stage 3** — link with the grid controller: hold DHW heating when the hourly import is close to the tier limit, prefer DHW at night (22–06); MCP tool `get_heat_pump`.

---

← [Development & deployment](development.md) | [Home](../README.md) →
