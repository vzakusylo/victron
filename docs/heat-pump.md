[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md) · **Heat pump**

# Heat pump (Tuya, local)

> Moving the air-to-water heat pump from Tuya cloud scenes to Node-RED on the GX — stage 1: read-only page

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

| Role | Tuya name | Device ID | Notes |
|---|---|---|---|
| Heat pump | Heating pump | `bf3f2552b6fcd2c689fzre` | product `5oc9wmac3bbidekc`, controller PW58280 (Powerworld/Michl, inverter 3-in-1) |
| 3-way valve relay | Boiler | `bf894708aa7e3ac196zjzk` | DP 1: ON = DHW tank, OFF = heating |
| Heat exchanger bypass | Off Heating exchange | `bf3ff3d877d898b531cuoq` | DP 1: ON = bypass (exchanger off) |

Local keys are **not** stored in this repository. They are typed into each Tuya node on the GX and kept in Node-RED credentials (`flows_cred.json`, not part of an export).

## Network

The GX and the Tuya devices must be in the same subnet (the node finds devices by UDP broadcast). Here both are behind the ASUS repeater `Telia-2FF703_RPT` (192.168.1.x), GX = 192.168.1.94. Pin the device IPs in the router's DHCP list.

## Setup

1. Node-RED → Manage palette → Install `node-red-contrib-tuya-smart-device` (tested against 5.4.0).
2. Import / deploy `flows.json` (tab `d#112` or later).
3. Open each of the three Tuya nodes (`Heating pump`, `Boiler valve relay`, `Off Heating exchange`), tick *Store as credentials* (already on), enter the **Device ID** and **Local Key**, optionally the IP, version `3.3` (try `3.4` if it never connects). Deploy.
4. Open the dashboard → **Heat Pump**. Node status under each Tuya node shows connecting / connected.

Get the local keys from platform.tuya.com → Cloud → project → API Explorer → *Query Device Details in Bulk*, or with `python -m tinytuya wizard`. A key changes if the device is removed and paired again in Smart Life.

Note: many Tuya devices accept only **one local connection**. Do not run tinytuya / Home Assistant locally against the same device at the same time. The Smart Life app and cloud keep working.

## Heat Pump page

Stage 1 is read-only. Flow nodes:

- `Poll heat pump (GET, read only)` — every 30 s (was 60 s before d#114) sends `{"operation":"GET","schema":true}` to the three Tuya nodes. **Always send an explicit `operation`**: the Tuya node treats a message without it as `SET`.
- three `tuya-smart-device` nodes → `topic = hp | valve | bypass` → `Heat pump state` (`34 Heat pump state.js`)
- `Heat pump page` (ui_template, source `35 Heat pump page.html`) and `Heat pump temperatures` (24 h chart: supply, return, tank, outdoor; one point per minute)

The page shows connection state of each device, supply / return / tank / outdoor, compressor Hz, fan, set points, mode, curve P22–P24, valve and bypass state, a defrost sign (fan 0 while compressor > 30 Hz), decoded faults (`Er03`…`Er70`) and a table of every DP received (unknown DPs listed separately).

State is kept in `flow.heatPump` (raw DPs per device) and `flow.heatPumpModel` (page model).

**Compressor load card (d#114, maxima d#116):**
- rated maxima: 91 Hz and 8 A (constants `COMPRESSOR_MAX_HZ` / `COMPRESSOR_MAX_A` in `34`);
- frequency % = DP 115 / 91, current % = DP 112 / 8, each clamped to 0–100;
- load % = the higher of the two. Example: 69 Hz, 3 A → 76 % / 38 % → **76 %**;
- power ≈ DP 112 (compressor current) × DP 114 (DC bus voltage; 230 V until received).

This is an estimate: power factor and drive losses are ignored, and there is no power DP.

**History log (d#114):**
- Nodes: `Heat pump log tick (30 s)` → `Format heat pump log line` (`36 Format heat pump log line.js`) → `Append heat pump log`.
- Every 30 s one line is appended to `/data/home/nodered/grid-control-logs/heatpump-YYYY-MM-DD.log` (local date of the GX).
- Format: `time | Sup | Ret | Tank | Out | Cmp Hz A % ~W | Fan | HeatSet | DhwSet | work mode + mode | Valve | Bypass | Defrost | Faults | Age`.
- No line is written while the data is older than 180 s.
- Size: about 2880 lines and ~0.4 MB per day. Log cleanup is disabled, so watch disk space on the Files page.

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

Built-in curve (P22 on): heating set point = 20 + 0.4 × (P23 − outdoor), 20…60 °C.

## Roadmap

1. **Stage 1 (now)** — read-only page; compare with the Tuya log for a day.
2. **Stage 2** — `36 Heat pump controller.js`: state machine HEATING → DHW_PREHEAT → DHW_STOP_WAIT (set point 20, 60 s) → DHW_HEAT → back; DEFROST_HEATING / DEFROST_DHW. Defrost sign must hold 60–90 s and is ignored 3–5 min after a compressor start; bypass watchdog (≤ 20 min); safe state if a device is silent > 5 min (valve → heating, bypass off, P22 on). Dry-run first (log decisions, send nothing).
3. **Cutover** — disable Tuya cloud scenes B…, DF…, HP silent, B46 mode, HP Er03 restart; enable sending from Node-RED. Rollback = disable the flow, re-enable the scenes.
4. **Stage 3** — link with the grid controller: hold DHW heating when the hourly import is close to the tier limit, prefer DHW at night (22–06); MCP tool `get_heat_pump`.

---

← [Development & deployment](development.md) | [Home](../README.md) →
