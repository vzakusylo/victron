[Home](../README.md) · [Overview](overview.md) · **Control logic** · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md)

# Control logic

> Charging windows, grid setpoint & tariff seasons, HV protection, heavy load, solar forecast, energy counter & history files, force charging, output pacing

**On this page:**

- [Charging windows](#charging-windows)
  - [Night window](#night-window)
  - [Morning window](#morning-window)
  - [Evening window](#evening-window)
  - [Outside windows](#outside-windows)
- [Grid setpoint schedule](#grid-setpoint-schedule)
  - [Tariff seasons (summer / winter)](#tariff-seasons-summer--winter)
- [High-voltage protection](#high-voltage-protection)
- [Heavy-load setpoint suppression](#heavy-load-setpoint-suppression)
- [Solar forecast effect](#solar-forecast-effect)
- [Hourly consumed-energy counter](#hourly-consumed-energy-counter)
  - [Energy history files](#energy-history-files)
- [AC Force Charging with voltage limiter](#ac-force-charging-with-voltage-limiter)
- [Solar generation tracking](#solar-generation-tracking)
- [Output update pacing](#output-update-pacing)

## Charging windows

The battery charging logic now uses the BMS `Consumed Amphours` value as the net deficit that needs to be restored toward zero.

### Night window

- active time: `22:00–05:59`
- charge current is `25 A` only when the remaining deficit is too large to be fully restored during the remaining MORNING window
- if the remaining MORNING window alone can still restore the deficit, night charging stays off

### Morning window

- active time: `06:00–11:59`
- charge current is `25 A` whenever any grid-restoration deficit still remains after subtracting predicted solar contribution
- charging is suppressed when solar forecast is valid, `forecastRestoreAh > 0`, and battery voltage > `53.7 V`

### Evening window

- active time: `17:00–23:59` with night taking priority from `22:00`
- no grid-restoration charging is scheduled in this window

### Outside windows

- charge current limit goes to `0 A`
- grid control still remains active

## Grid setpoint schedule

Base target (derived from the active tariff season, see below):

- summer: day `1950 W`, night `2850 W`
- winter: day `4950 W`, night `6440 W`

### Tariff seasons (summer / winter)

In winter the house load is too high to stay in tier 1 (≤ 2 kW), so the controller switches to a winter profile that targets tier 2 (≤ 5 kW).

- winter starts on `WINTER_START_MMDD` (default `1017` = 17 Oct), summer on `SUMMER_START_MMDD` (default `415` = 15 Apr)
- each season has its own tier (`SUMMER_TARIFF_TIER` = 1, `WINTER_TARIFF_TIER` = 2); `TARIFF_SEASON_FORCE` = 1/2 pins summer/winter
- day setpoint = tier limit − `TARIFF_TIER_MARGIN_W` (50 W); night setpoint = day setpoint + season night extra (summer 46 %, winter 30 %)
- night hours are billed at `TARIFF_NIGHT_BILLING_PCT` (70 %), so the winter night `6440 W` bills as `4508 W`, under the 5 kW limit
- the hourly budget equals the season setpoint
- VE.Bus input current limit (controller output 3, replaces the fixed 06:00/22:00 inject values) = setpoint × (1 + `GRID_CURRENT_HEADROOM_PCT` 10 %) / `GRID_NOMINAL_VOLTAGE` 230 V, rounded to 0.5 A and capped at `GRID_CURRENT_MAX_A` (32 A, set this to your main fuse)
  - summer: `9.5 A` day / `13.5 A` night (same as before); winter: `23.5 A` day / `31 A` night
  - sent when the value changes and re-asserted every hour
- all of these are editable on the Constants page and apply live, without redeploy

Daily and monthly tracking (node status, trace `tariff`, Analytics "Capacity tariff" card):

- grid import today (kWh) and how much is still left today if every remaining hour stays at the season plan
- today's highest billable hour (night × 0.7) and the headroom to the tier limit
- the month's top-3 day peaks and their average = the tier the month is heading for (green = fits the season tier)
- `tariffDay` / `tariffMonth` live in the controller context, so the month history restarts after a Node-RED restart unless a persistent context store is configured

This is only the starting point. The controller may lower it further if:

- the battery voltage is already too high
- AC loads exceed the heavy-load threshold

## High-voltage protection

This layer exists because an external charger or MPPT may increase battery voltage even when the Victron charger is not the only charging source.

Default thresholds (configurable from the Protection dashboard):

- limiter starts when battery voltage rises above `55.4 V`
- limiter remains active until battery voltage falls back to `55.2 V` or below
- the grid setpoint tapers down smoothly
- by `55.6 V`, the voltage limiter can push the setpoint down toward `200 W`
- voltage range accepted: `50–60 V`
- maximum smoothing step per cycle: `100 W`

Smoothing is used so the grid setpoint does not jump too aggressively.

## Heavy-load setpoint suppression

Protects the Norwegian hourly tariff threshold (~2 kWh/h) during high-demand events.

Behavior:

- activates when AC loads reach or exceed `4000 W`
- while active: grid setpoint is capped to `1700 W` and charge current is forced to `0 A`
- the battery covers the gap; the grid CT stays safely below 2 kW
- releases with hysteresis when AC loads fall below `2500 W`
- state persists across message cycles in context as `heavyLoadActive`
- shown in node status as `HL:<load>W`

## Solar forecast effect

The controller reads `flow.solarForecastToday` and uses the predicted energy amount to reduce the grid Ah that must be restored overnight and in the morning.

Behavior:

- forecast is accepted only when it is for the current day and not older than `18` hours
- forecast energy is converted to estimated battery Ah using battery voltage and a fixed efficiency factor
- that estimated solar Ah is subtracted from the BMS consumed-Ah deficit
- grid setpoint is not changed by the forecast

Current conversion constants:

- nominal battery voltage fallback: `52 V`
- solar-to-battery efficiency factor: `0.9`
- forecast accepted only when same day and age ≤ `18 h`

Practical correlation with charging:

- the BMS provides the net consumed capacity in Ah
- predicted solar energy is converted to an estimated restoration amount in Ah
- the remaining grid-restoration target is:

$$
	ext{gridRestoreAhNeeded} = \max(0, \text{consumedAhDeficit} - \text{forecastRestoreAh})
$$

- if NIGHT is active, charging starts only when the remaining MORNING capacity at `25 A` is no longer enough to cover `gridRestoreAhNeeded`
- if MORNING is active, charging runs at `25 A` while `gridRestoreAhNeeded` is still above a small deadband
- high-voltage tapering can still reduce the final charge current below `25 A` when the grid setpoint is being limited

## Hourly consumed-energy counter

The controller keeps an hourly counter of imported energy in `Wh`.

Important details:

- source = `GX System -> /Ac/Grid/L1/Power`
- this is the GRID CT sensor that measures house import power
- only positive import is accumulated
- the counter resets every new clock hour
- the status text shows:
  - the exact start time when accumulation began in the current hour
  - the end of the current hour
  - accumulated `Wh`

Example status:

- `13:07-14:00 606Wh`

Meaning:

- import accumulation began at `13:07`
- the current hour ends at `14:00`
- `606 Wh` has been counted so far in that hour window

If tracking started exactly at the top of the hour, the status also shows the remaining average watts left in the hour. This is informational only and does not change any outputs.

### Energy history files

Every closed hour is appended to one CSV per month, `/data/home/nodered/grid-control-logs/energy-YYYY-MM.csv`:

```
hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min
2026-10-17 22,2450,2432,0,1715,2610,6440,W,60
```

- `bill_wh` = grid Wh as counted for the capacity tier (night hours × night billing %)
- `peak_w` = highest grid import W in the hour
- `setpoint_w` / `season` (`S`/`W`) = the season plan for that hour
- `min` = minutes actually integrated (60 = full hour, less after a restart or redeploy)

Notes:

- nothing is deleted any more: the 45-day cleanup (`Daily cleanup midnight` → `Delete logs older than 45 days`) is disabled so the full history is kept
- legacy daily files (`energy-YYYY-MM-DD.log`, `summary-YYYY-MM-DD.log`) stay on disk and are still read by the Energy tab and by the controller; new hours are only written to the CSV
- after every start/redeploy the controller reads the month's CSV + legacy logs (output 7 → `Read month energy history`) and restores today's grid kWh and the month's top-3 day peaks

## AC Force Charging with voltage limiter

The controller supports direct AC-assisted battery charging (`FORCE-CHARGE` window).

Default limiter thresholds (configurable from the Protection dashboard):

- activate force charging when battery voltage drops to `53 V` or below
- charge at maximum DVCC (`25 A`) when voltage is at or below `52 V`
- deactivate when voltage rises back to `54 V`
- taper from `forceChargeGridW` up to max DVCC power between `Full` and `Start` voltages
- all limiter thresholds validated in range `50–60 V`; required: `release > start > full`

## Solar generation tracking

Solar generation is the sum of two sources:

- **DC System Power** (`/Dc/System/Power`): negative values indicate a DC source (e.g. AC-coupled solar) pushing power onto the DC bus. Solar contribution = `max(0, −dcPowerW)`.
- **PV Charger Power** (`/Dc/Pv/Power`): direct output of the MPPT charger in watts (always positive).

The combined formula: `solarGenerationW = max(0, −dcPowerW) + pvChargerPowerW`

- `solarBudget` integrates `solarGenerationW` per clock hour using the same logic as grid and AC budgets
- `solarWh` is included in every hourly rollover message alongside `gridWh` and `acWh`
- visible in node status as `DC <n>W | PV <n>W | Sol <n>Wh`
- shown in the Hourly Grid and AC Detail dashboard table and in analytics

## Output update pacing

To avoid excessive control chatter, the live flow adds output delays:

- charge current limit changes are rate-limited to every `10 seconds`
- grid setpoint changes are rate-limited to every `10 seconds`

This prevents rewriting Victron settings every second.

---

← [Overview & architecture](overview.md) | [Grid tariffs in Norway](tariffs-norway.md) →
