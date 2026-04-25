# Project Context for Future Programming (Victron Cerbo GX / Node-RED / Elvenett)

## Purpose
This file captures the key technical context from the previous chat, in English, so it can be reused in Visual Studio Code for future programming tasks.

---

## 1. System Overview

### Hardware / Platform
- **Victron Cerbo GX**
- **Venus OS Large** installed (same firmware version retained during install when using the correct `venus-swu-large-einstein-...v3.67.swu` package)
- **Node-RED** runs on the Cerbo GX
- **MultiPlus-II** / VE.Bus based inverter-charger
- Battery is visible in Node-RED via a battery node (for example a SerialBattery / JBD / LLT service)

### Software / Environment
- Node-RED is used for automation on the Cerbo GX
- ESS-related control is performed through Victron nodes and/or ESS settings
- The user wants future code and flows to be reusable in VS Code

---

## 2. Main Business Goal

The user wants to optimize **hourly grid import** to stay within a practical cap related to **Elvenett kapasitetsledd**:

- **Day target:** keep raw hourly import close to or below **2.0 kW**
- **Night target (22:00-06:00):** allow higher raw import because Elvenett applies a **0.7 factor** for kapasitetsledd at night
- Practical night raw target discussed:
  - ideal theoretical max: about **2.857 kW** raw
  - practical safer target: about **2.5-2.7 kW** raw

The user also wants charging logic that changes dynamically by:
- time window
- battery voltage
- optional future remaining-hour budget logic

---

## 3. Important Tariff Logic (Elvenett)

### Day/Night capacity logic
- Elvenett applies a reduced capacity factor at night:
  - **22:00-06:00 => kapasitetsledd kW x 0.7**
- This means a raw night hour can be higher than 2.0 kW and still count below 2.0 kW for capacity billing.

### Important clarification
- The Elvenett app's **Usage tops / Consumption (kW)** screen shows **raw hourly consumption**, not the already adjusted value for kapasitetsledd.
- Therefore, a value like `2.34 kW` shown at night does **not** mean the adjusted capacity value is above 2.0.
- Example:
  - `2.34 kW raw x 0.7 = 1.638 kW adjusted`

### Capacity step logic
The monthly capacity step is driven by the **three highest hourly peaks on three different days**, not by one single good night.

---

## 4. Key Victron / ESS Concepts From The Chat

### ESS modes
The chat highlighted an important distinction:

- **Mode 2 style / normal ESS behavior preferred** for regular operation with some external adjustment of setpoints
- **External control / Mode 3** is a different operating mode and changes how the system behaves

### Important warning discovered in the chat
At one point the system overview showed:
- **Inverter / Charger: External control**

This means the system was not in the user's expected normal ESS optimized behavior.
That matters because:
- `DVCC Charge current limit` is only a **charge limit**, not a command to force charging
- real charging from grid depends on the actual ESS / inverter-charger mode and overall control logic

### How to verify external control
External control can be checked by:
- Cerbo menu: `Settings -> ESS -> Mode`
- D-Bus setting (discussed in the chat): `/Settings/CGwacs/Hub4Mode`

---

## 5. Node-RED Learnings From The Chat

### Important Node-RED design lesson
A **battery voltage node is a source node**.
It does **not** accept an input from `inject`.

Correct pattern:

```text
Battery voltage (source) -> Function -> ESS / VE.Bus control
```

### Wrong pattern that was corrected

```text
Inject -> Battery voltage
```

This does not work because the battery node has no input port.

### Better approaches discussed
- Let the battery source node publish updates naturally
- Use a `delay` node if rate-limiting is needed
- Use context memory in a `Function` node for stateful logic

---

## 6. Existing Charging Logic Developed In The Chat

The latest logic is based on **battery voltage + time window + hysteresis + context memory**.

### Current intended behavior

#### Night window
- **22:00-05:59**
- Use hysteresis at night instead of charging unconditionally:
  - turn ON night charging again if voltage is at or below **54.5 V**
  - turn OFF night charging if voltage is at or above **54.8 V**
- Charge current when active: **25 A**
- Charge current when inactive: **0 A**

#### Morning window
- **06:00-11:59**
- Use hysteresis based on battery voltage:
  - turn ON boost if voltage is below **53.5 V**
  - turn OFF boost if voltage is above **53.8 V**
- Charge current when active: **25 A**
- Charge current when inactive: **0 A**

#### Evening window
- **17:00 and later**
- Use hysteresis based on battery voltage:
  - turn ON boost if voltage is below **54.0 V**
  - turn OFF boost if voltage is above **54.4 V**
- Charge current when active: **25 A**
- Charge current when inactive: **0 A**

#### Outside defined windows
- Charge current is `0 A`
- Grid setpoint control can still remain active

#### Grid setpoint control
- Base grid setpoint schedule:
  - **night:** `2700 W`
  - **rest of day:** `1950 W`
- Final grid setpoint is dynamically limited by additional rules:
  - high battery voltage protection
  - hourly grid budget controller

### State handling
The logic uses `context`:
- `boostActive`
- `activeWindow`

The current implementation also stores additional controller state such as:
- last known battery voltage
- last known grid import power
- hourly energy budget state
- active high-voltage limiting state
- previous grid setpoint for smooth ramping
- previous VE.Bus Input 1 current limit for change notifications

This avoids noisy oscillation when the voltage hovers around the threshold.

At night the same remembered state is also used so the charger does not chatter around the stop threshold.

### Night priority
The night rule is checked first and returns immediately.
Night behavior therefore has priority over morning/evening logic.

---

## 7. Latest Function Node Logic (Current Working Reference)

This is the latest function logic state from the chat, conceptually:

- If time is between 22:00 and 06:00 -> apply night hysteresis using 54.5 / 54.8 and set charge current to 25 A only when night boost is active
- Else if in morning window -> apply hysteresis using 53.5 / 53.8
- Else if in evening window -> apply hysteresis using 54.0 / 54.4
- Else -> charge current stays at 0 A

In addition, the active implementation now also:
- limits grid setpoint smoothly when battery voltage rises above `55.0 V`
- releases that voltage limit only when voltage falls back to `54.8 V`
- tapers down to a minimum voltage-protection setpoint of `200 W` by `55.2 V`
- counts hourly imported energy and limits grid setpoint by the remaining hourly power budget
- emits a notification message when grid setpoint or VE.Bus Input 1 current limit changes

The final implementation also resets state when switching between windows so that a night state does not leak into morning or evening logic.

---

## 8. Dynamic Hourly Budget Controller

The controller discussed in the chat is now part of the active implementation.

### Goal
Calculate, within the current clock hour, how much grid import budget remains before reaching the hourly target.

### Concept
Inputs:
- current grid import power from grid meter
- current time in the hour
- target hourly raw power limit
  - day: 2000 W
  - night: 2700 W (safe practical target)

Derived values:
- accumulated imported energy so far in the current hour (Wh)
- remaining Wh budget in the current hour
- allowable average power for the rest of the hour

Outputs:
- dynamic **Grid setpoint**
- dynamic **Grid current limit**

### Formula from chat

```text
E_budget_Wh = P_limit * 1h
E_left_Wh   = max(0, E_budget_Wh - E_used_Wh)
P_allow_rest_W = E_left_Wh / t_left_h
```

This is intended for future Node-RED development.

### Active implementation notes
- The current implementation integrates **positive grid import only**
- The live power source for this counter should be the **GX System GRID CT sensor** reading from `System -> /Ac/Grid/L1/Power`
- It resets the budget every new clock hour
- Day budget target is **2000 Wh / hour**
- Night budget target is **2700 Wh / hour**
- The remaining-hour budget can reduce the final grid setpoint below the voltage-protection minimum of `200 W` if necessary
- VE.Bus **Input 1 current limit (A)** is also now updated dynamically from the final grid setpoint
- The VE.Bus current limit uses `flow.gridVoltage` when available, otherwise defaults to `230 V`
- Safe maximum VE.Bus Input 1 current limit is now:
  - `12.6 A` at night
  - `9.6 A` during daytime
- If hourly remaining capacity is exhausted or still unknown, the controller falls back to that safe limit instead of reducing the VE.Bus input current limit to zero
- The controller now exposes a fourth output for notification messages intended for VRM/notification handling flows
- On systems where `victron-inject` is unavailable, the active flow uses a standard formatter `function` node plus `victron-output-custom` to write directly to `com.victronenergy.platform /Notifications/Inject`
- The flow also includes a manual `TEST notification` inject node for verifying notification delivery from Node-RED through that compatible path

---

## 8B. Solar Prediction For Hokksund, Norway

Solar prediction is now partially implemented in the active flow.

### Source
- Uses the existing `Solar forecast` subflow in `flows.json`
- Source API: `forecast.solar`
- Refresh interval: every **15 minutes**

### Current configuration assumptions
- Location: **Hokksund, Norway**
- Approximate coordinates:
  - latitude: `59.764`
  - longitude: `9.902`
- Panel declination: `35°`
- Panel azimuth: `0°` (south-facing assumption)
- Installed PV power used for forecast model: `5 kWp`

### Local correction model
Because the panels are surrounded by trees and receive heavy shade, the raw forecast is adjusted with a local shading profile derived from Solar Assistant history.

The active prediction logic now assumes:
- extended low-level production window: **05:00-21:00**
- dominant useful production window: **11:00-17:00**

Hourly shade factors now used:

```text
05:00 -> 0.02
06:00 -> 0.04
07:00 -> 0.06
08:00 -> 0.10
09:00 -> 0.18
10:00 -> 0.30
11:00 -> 0.55
12:00 -> 0.72
13:00 -> 0.78
14:00 -> 0.62
15:00 -> 0.50
16:00 -> 0.42
17:00 -> 0.32
18:00 -> 0.22
19:00 -> 0.14
20:00 -> 0.08
21:00 -> 0.03
outside this window -> 0
```

To avoid overprediction, the active implementation also applies an hourly historical cap envelope.

Hourly caps now used:

```text
05:00 -> 20 W
06:00 -> 40 W
07:00 -> 80 W
08:00 -> 150 W
09:00 -> 300 W
10:00 -> 550 W
11:00 -> 1100 W
12:00 -> 1500 W
13:00 -> 1500 W
14:00 -> 1200 W
15:00 -> 800 W
16:00 -> 700 W
17:00 -> 500 W
18:00 -> 320 W
19:00 -> 220 W
20:00 -> 140 W
21:00 -> 40 W
```

### Calibration targets from Solar Assistant statistics
- sunny day expected generation: about **3-5 kWh**
- cloudy day expected generation: about **2 kWh**
- observed sunny-day peak: about **1.4-1.5 kW**
- observed cloudy-day peak: generally **below 1.0 kW**
- observed dominant generation window: mostly **11:00-17:00** with long low-power tails before and after

### Current outputs
The new solar prediction flow stores:
- `flow.solarForecastAdjusted`
- `flow.solarForecastToday`

The stored daily summary currently includes:
- predicted energy for today in `Wh` and `kWh`
- predicted peak power in `W` and `kW`
- predicted active solar hours
- simple condition label:
  - `sunny` when adjusted peak is `>= 1.0 kW`
  - `cloudy` when adjusted peak is below `1.0 kW` but daily energy is `>= 2.0 kWh`
  - `low` otherwise

### Important note
- This solar prediction is now implemented and refreshed automatically
- it is **not yet actively used by the battery/grid controller decision logic**
- it is currently prepared as an input for future forecast-aware charging control

### Final grid setpoint logic

The final `grid setpoint` is the minimum of:

```text
base schedule
high-voltage limit
hourly budget limit
```

This means hourly budget protection has the highest practical priority.

---

## 8A. Dynamic High-Voltage Grid Setpoint Limiter

This controller was added because an external MPPT can charge the battery without Victron being fully aware of it.

### Goal
Reduce Victron-driven charging pressure when the battery voltage is already high.

### Active thresholds
- start limiting when battery voltage is above **55.0 V**
- keep the limiter active until voltage falls to **54.8 V** or lower
- taper down smoothly to **200 W** by **55.2 V**

### Smoothing
- grid setpoint reduction is smoothed between updates
- this avoids abrupt load changes on the battery

---

## 9. Important Practical Distinction: Charge Limit vs Actual Charging

One critical insight from the chat:

### `DVCC Charge current limit` is NOT a direct command to charge
It only defines the **maximum allowed charge current**.

Actual charging still depends on:
- ESS mode
- grid import strategy
- inverter/charger mode
- whether the system is in external control
- whether the charger is actually instructed to take power from grid

So if battery current is still `0 A`, that does not necessarily mean the Node-RED logic failed.
It may mean the system was not actually commanded to charge, or a different control mode was active.

---

## 10. Visual Indicators Used In Function Nodes

The Function node status indicator was used for real-time visibility.
Typical statuses:

- **Blue** for NIGHT charging active
- **Green** when boost is active in morning/evening
- **Yellow** when inside a controlled window but charge current is `0 A`
- **Grey** when outside all windows

Typical status text format:

```text
NIGHT | V=53.76V | 25A
MORNING | V=53.42V | 25A
EVENING | V=54.20V | 0A
OUTSIDE WINDOW | V=54.10V
```

---

## 11. File Logging / VRM Notification Ideas Discussed

Ideas previously discussed for later implementation:
- append state changes to a log file on Cerbo GX, e.g.
  - `/data/node-red/charge_boost.log`
- send VRM-visible alarms/notifications when boost turns ON (and optionally OFF)

These were not finalized into the final active code in the last steps, but they remain valid future enhancements.

---

## 12. Known Implementation Constraints / Caveats

1. **Battery voltage node is a source node only**
   - do not wire Inject into it

2. **External control matters**
   - if the system is in `External control`, actual charging behavior may not match normal ESS expectations

3. **Night coefficient does not change app raw values**
   - the Elvenett app still shows raw `Consumption (kW)`
   - night `0.7` is for billing/capacity calculation, not for what the app displays

4. **Hysteresis is necessary**
   - otherwise the voltage threshold logic will chatter

5. **Window transition reset is necessary**
   - otherwise `boostActive` can leak from one time window into another

6. **Night charging is no longer unconditional**
  - current active rule is night hysteresis with `54.5 V` ON and `54.8 V` OFF
  - this protects against overcharging when battery voltage is already high

7. **Keep script files synchronized**
  - `day-night.txt` is the readable source copy of the active Function node logic
  - the embedded `func` code inside `flows.json` must match `day-night.txt`
  - whenever one is changed, the other must be updated as well

8. **Hourly budget can override the voltage minimum setpoint**
  - voltage protection uses a nominal minimum of `200 W`
  - but if the hourly import budget is nearly exhausted, final grid setpoint may go below `200 W`

9. **A Solar forecast subflow already exists in `flows.json`**
  - it uses the `forecast.solar` API
  - it supports `estimate`, `history`, and `clearsky`
  - the free API is rate-limited and only updates about every 15 minutes
  - the subflow can output both raw forecast data and graph-friendly data
  - this has not yet been integrated into the active battery/grid controller logic

---

## 13. Suggested Next Development Steps

For future programming in VS Code, likely next useful tasks are:

1. **Refactor the current Function node into reusable modules / helper functions**
2. **Implement logging and structured event records**
3. **Add a real hourly budget controller based on grid power integration**
4. **Add dashboard UI in Node-RED for current active policy**
5. **Add manual override**
6. **Add SOC-based conditions in addition to voltage-based conditions**
7. **Different charge current by window**
   - e.g. night 25 A, morning/evening 20 A
8. **Implement durable statistics storage and replay-safe startup logic**
   - **Current state to remember:**
     - hourly Grid and AC usage values shown on dashboard are primarily built from runtime `context` / `flow` state
     - daily logs already exist on disk under `/data/grid-control-logs/`
     - dashboard-facing state such as `dailySummary`, `dashboardLiveHour`, and controller trace is not yet treated as a canonical persisted state model
   - **Important practical conclusion:**
     - durable text logs survive Cerbo restart because they are written to `/data`
     - in-memory dashboard state will normally be lost on restart unless it is explicitly restored from disk or Node-RED persistent context is confirmed and relied on
   - **Best-practice storage architecture for Cerbo / Victron:**
     - keep fast-changing live counters in memory during normal runtime
     - persist coarse rollups and canonical dashboard state to `/data`, not only to transient context
     - avoid high-frequency disk writes for every sample; write on hourly rollover, important state transitions, and low-frequency checkpoints
     - treat `/data/grid-control-logs/` as the durable application data root for this project
   - **Detailed implementation tasks:**
     - create one canonical daily JSON state file, for example `/data/grid-control-logs/dashboard-YYYY-MM-DD.json`
     - define a stable JSON schema containing:
       - date
       - completed hourly rows
       - current live hour partial totals
       - daily totals
       - solar forecast summary used by the dashboard
       - latest controller diagnostics needed after restart
     - update the hourly rollover logic so every completed hour is appended to both:
       - the human-readable daily energy log
       - the canonical daily JSON state file
     - add low-frequency checkpoint persistence for the current open hour, for example every 5 minutes or on meaningful delta, so a reboot during an hour does not reset the current-hour dashboard completely
     - add a startup rehydration flow that runs once after Node-RED starts and:
       - loads today's JSON state file if it exists
       - restores `dailySummary`
       - restores `dashboardLiveHour`
       - restores dashboard table/chart source arrays
       - restores latest controller trace snapshot if present
     - add a safe fallback path:
       - if today's JSON state file is missing or corrupt, initialize a clean day structure
       - if yesterday's file exists and current day has rolled over, start a new clean file for today
     - keep retention cleanup aligned across all durable artifacts:
       - energy logs
       - summary logs
       - controller logs
       - new dashboard JSON files
     - document the storage contract in `README.md` so future edits know which files are authoritative for restart recovery
     - verify whether Node-RED persistent context is enabled on the Cerbo runtime before depending on it for any critical state
     - if persistent context is enabled, still keep `/data` JSON as the portable and inspectable source of truth for dashboard history
   - **Recommended division of responsibility:**
     - memory: live second-by-second counters and transient smoothing state
     - JSON day-state file: dashboard recovery and current-day structured history
     - text logs: human inspection, audit trail, debugging
   - **Expected outcome after implementation:**
     - dashboard history survives restart
     - current day statistics remain visible after reboot
     - live hour may lose at most the checkpoint interval, not the whole day
     - long-term analysis continues to use daily log files already stored under `/data`
9. **Integrate Solar forecast into the controller**
  - use the existing `Solar forecast` subflow already present in `flows.json`
  - configure location, panel azimuth, panel declination, and installed PV power
  - fetch forecast no more often than every 15 minutes
  - store forecast results in flow/global context
  - use forecast to reduce unnecessary daytime grid charging when strong solar production is expected later
  - optionally expose forecast values in a dashboard/debug view

---

## 14. Useful Terms / Labels From The Chat

- `Grid setpoint`
- `Grid current limit`
- `DVCC Charge current limit (A)`
- `External control`
- `boostActive`
- `activeWindow`
- `MORNING`
- `EVENING`
- `NIGHT`
- `OUTSIDE WINDOW`
- `kapasitetsledd`
- `0.7 night factor`
- `raw hourly import`
- `adjusted night capacity value`

---

## 15. Recommended Reminder For Any Future Coding Session

When using this context in future programming tasks, keep these assumptions explicit:

- Night charging is currently intended to be **25 A only while night hysteresis allows it**
- Current night hysteresis is **ON at 54.5 V or lower** and **OFF at 54.8 V or higher**
- Morning and evening charging are **voltage-triggered with hysteresis**
- `day-night.txt` and the embedded Function code in `flows.json` should always stay synchronized
- Grid setpoint is now controlled dynamically, not only by fixed schedule injects
- High battery voltage can reduce the grid setpoint smoothly
- Hourly import budget can reduce grid setpoint further based on the remaining energy budget of the current hour
- Actual charging behavior depends on actual Victron ESS / charger mode
- Elvenett app raw `kW` values are not the same as the adjusted nighttime capacity values
- Future automation may need both:
  - **charge current control**, and
  - **dynamic grid budget control per current hour**
- Future automation may also need:
  - **solar forecast aware charging strategy**, using the already available `forecast.solar` subflow in `flows.json`

---

## 16. Current Function Logic Snapshot (Short Form)

### Current target behavior snapshot
- **22:00-05:59** -> 25 A if night state is active, OFF at V >= 54.8, ON again at V <= 54.5
- **06:00-11:59** -> 25 A if V < 53.5, off if V > 53.8
- **17:00+** -> 25 A if V < 54.0, off if V > 54.4
- outside charge windows -> charge current 0 A
- base grid setpoint -> 2700 W at night, 1950 W otherwise
- high-voltage limiter -> taper grid setpoint down from 55.0 V to 55.2 V, release at 54.8 V
- hourly budget limiter -> dynamic setpoint based on remaining hourly energy budget

This snapshot is the most important quick reference for future coding.

#dashboard-context.md

# Dashboard Context and Implementation Plan

## Purpose

This file captures, in detailed English, what the reference dashboard screen is showing and how a similar dashboard can be implemented in this Victron Cerbo GX / Node-RED project.

It is intended as a future-programming context file for VS Code work on:

- Node-RED Dashboard design
- forecast vs actual energy analytics
- per-hour grid / AC / solar statistics
- daily KPI cards and routing breakdowns
- battery and grid energy movement visualizations

---

## 1. What Is Visible on the Reference Screen

The screen is a Node-RED Dashboard style energy-analysis page.

The title bar reads:

- `FC, Verbrauch & Solar`

This is German and roughly means:

- `Forecast, Consumption & Solar`

The dashboard is organized as a daily energy analytics page with:

- one KPI-heavy statistics panel on the left
- multiple forecast-vs-real charts on the right
- separate visualizations for solar, consumption, surplus, and battery-energy routing

The purpose of the screen is not just to show current values. It is a validation and analysis dashboard that compares:

- forecasted values versus actual values
- total daily energy versus time-distributed energy
- solar production versus site consumption
- routing of energy between PV, battery, grid, and load

---

## 2. Translation of the Main Labels

The screen contains several German labels. Their English meanings are:

- `Tagesstatistik` = Daily statistics
- `Visualisierung Forcast` = Forecast visualization
- `Prognose/Real` = Forecast / Actual
- `Solar FC / Real` = Solar forecast / actual
- `Verbrauch FC / Real` = Consumption forecast / actual
- `Überschuss FC / Real` = Surplus forecast / actual
- `Akkubewegungen in kWh` = Battery movements in kWh
- `Solarertrag` = Solar yield / solar production
- `Verbrauch` = Consumption
- `Solarüberschuss` = Solar surplus / excess solar
- `Direktverbrauch` = Direct self-consumption
- `zu Akku` = To battery
- `zu Grid` = To grid
- `heute` = Today

`FC` should be interpreted as `Forecast`.

---

## 3. Structural Analysis of the Screen

The dashboard can be divided into six logical blocks.

### Block A — Left-side daily KPI panel

This is the most information-dense panel. It contains totals, progress bars, and routing breakdowns.

It is designed to answer:

- What was forecast for today?
- What has actually happened so far today?
- How was solar energy distributed?
- How much came from grid?
- What did it cost?

### Block B — Forecast battery-movement chart

This panel visualizes how forecasted energy is expected to move between:

- PV and battery
- battery and load
- grid and battery
- battery and grid

It is intended to show expected storage behavior over time.

### Block C — Combined forecast-vs-real chart for today

This panel overlays forecast and actual values for the current day.

It helps answer:

- Was the forecast shape correct?
- Was actual demand lower or higher than expected?
- Was solar delivered when expected?

### Block D — Solar-only forecast-vs-real chart

This isolates the solar component.

It helps distinguish:

- forecast total-energy accuracy
- forecast timing-shape accuracy

### Block E — Consumption-only forecast-vs-real chart

This isolates load behavior.

It helps verify whether consumption forecasting is too smooth, too high, or too low.

### Block F — Surplus-only forecast-vs-real chart

This shows how much excess solar was expected compared with what actually happened.

This is one of the most important operational charts because surplus is strongly influenced by both:

- solar forecast accuracy
- load forecast accuracy

---

## 4. Detailed Meaning of the Daily Statistics Panel

The left panel in the screenshot contains these values.

### `FC Solarertrag 44.58 kWh`

Meaning:

- Forecasted total solar energy for the day.

Interpretation:

- The forecast model expects about 44.58 kWh of PV production.

### `FC Verbrauch 152.34 kWh`

Meaning:

- Forecasted total energy consumption for the day.

Interpretation:

- Daily load is expected to be much larger than daily solar production.

### `FC Solarüberschuss 6.79 kWh`

Meaning:

- Forecasted solar surplus for the day.

Interpretation:

- The model expects only a small amount of true excess solar after local use and charging.

### `Solarertrag heute 38.10 kWh`

Meaning:

- Actual solar energy produced today so far.

Interpretation:

- Actual solar is already close to the forecast total.

### `Verbrauch heute 64.44 kWh`

Meaning:

- Actual site consumption today so far.

Interpretation:

- Actual demand is much lower than the forecasted daily total at the time of capture.

### `Solarüberschuss heute 32.30`

Meaning:

- Actual solar surplus today.

Interpretation:

- Actual surplus is far larger than forecast surplus, which implies that reality was more export-prone or less consumption-heavy than the forecast expected.

### `Solar Direktverbrauch 4.70`

Meaning:

- Solar energy consumed directly by loads without first going through storage.

### `Solar zu Akku 20.55`

Meaning:

- Solar energy routed into battery charging.

### `Solar zu Grid 12.85`

Meaning:

- Solar energy exported to grid.

### `Grid Direktverbrauch 59.34`

Meaning:

- Grid energy consumed directly by the loads.

### `Grid zu Akku 1.06`

Meaning:

- Grid energy used to charge the battery.

### `Tageskosten Einkauf&Akkuladen 0.22 CHF (0.2075 CHF/kWh)`

Meaning:

- Daily purchase cost for imported energy and battery charging.

Interpretation:

- The dashboard includes tariff/cost-aware reporting, not just power and energy quantities.

---

## 5. Internal Consistency That Can Be Inferred From the Screen

The screenshot values strongly suggest that the dashboard is calculating real energy-flow balances.

Example solar-side balance:

- Solar direct use = 4.70 kWh
- Solar to battery = 20.55 kWh
- Solar to grid = 12.85 kWh

Sum:

$$
4.70 + 20.55 + 12.85 = 38.10\ \text{kWh}
$$

That matches:

- `Solarertrag heute = 38.10 kWh`

This implies the dashboard is not just showing unrelated indicators. It is decomposing solar yield into destination categories.

It likely uses energy-balance logic such as:

- PV direct to load
- PV to battery
- PV export
- grid direct to load
- grid to battery
- battery to load
- possibly battery to grid

This is important because a similar dashboard in this repo will need explicit energy-routing calculations, not just raw power charts.

---

## 6. What the Charts Are Telling the Operator

### Battery movement chart

The `Akkubewegungen in kWh` chart appears to describe forecasted energy transfer between battery, PV, grid, and load.

Operational role:

- shows when storage is expected to charge or discharge
- reveals whether the battery is used mainly for self-consumption or for export shaping

### Combined forecast-vs-real chart

The `Prognose/Real heute` panel compares forecast and actual series together.

Operational role:

- validates the overall planning model
- shows whether total daily forecast is correct
- shows whether the hourly shape is wrong even if daily total is acceptable

### Solar-only chart

The `Solarertrag FC / Real` chart reveals if solar forecast timing differs from reality.

Operational role:

- useful for charge scheduling
- useful for deciding when forecast should reduce night or morning grid charging

### Consumption-only chart

The `Verbrauch FC / Real` chart isolates load forecast quality.

Operational role:

- shows whether the demand forecast is too flat, too high, or shifted in time

### Surplus-only chart

The `Überschuss FC / Real` chart shows the most economically relevant error.

Operational role:

- tells whether export/self-consumption assumptions were correct
- exposes combined forecast mismatch from both solar and load models

---

## 7. What This Reference Dashboard Would Mean for This Victron Project

The current repo already has a basic dashboard slice in `flows.json`.

Current dashboard scope already implemented:

- per-hour Grid `Wh`
- per-hour AC load `Wh`
- live current-hour Grid and AC partial totals
- table of hourly Grid / AC values
- simple duplicated dashboard tabs for overview and detail

Current flow data already available:

- `dailySummary`
  - stores completed hourly Grid `Wh` and AC `Wh`
- `dashboardLiveHour`
  - stores partial current-hour Grid `Wh`, AC `Wh`, Grid `W`, AC `W`
- `solarForecastToday`
  - adjusted solar forecast summary for today
- `solarForecastAdjusted`
  - richer solar forecast detail object
- `controller-trace`
  - live controller state with hourly budget values and forecast fields

Current flow data not yet implemented for a reference-style energy-routing dashboard:

- PV direct to load energy
- PV to battery energy
- PV to grid/export energy
- grid to load energy as a day-total series
- grid to battery energy as a day-total series
- battery to load energy
- battery to grid energy
- forecasted per-hour load series for the whole day
- forecasted per-hour solar series for the whole day in dashboard-ready form
- per-hour actual solar production series from Victron services
- daily cost model based on actual import windows and tariff rules

This means the current project can already support a simpler hourly Grid/AC dashboard, but it cannot yet reproduce the full reference screen.

---

## 8. Gap Analysis: Reference Screen vs Current Repo

### Already possible with current data

- hourly Grid bar chart
- hourly AC load bar chart
- live current-hour Grid/AC widgets
- daily hourly table
- simple solar forecast total KPI

### Partially possible with current data

- forecast vs actual comparison for solar totals
- controller diagnostics panel
- current-hour efficiency indicators

### Not possible yet without new data model work

- full left-side KPI card set from the screenshot
- battery movement chart in kWh
- PV routing breakdown
- full forecast vs actual charts for load, solar, and surplus across the day
- cost panel with tariff-aware daily economics

---

## 9. Recommended Dashboard Design for This Repo

To build a dashboard similar to the reference screen, but grounded in the actual data available in this repo, the dashboard should eventually have these sections.

### Section A — Daily KPI cards

Suggested cards:

- Forecast solar today (kWh)
- Actual solar today (kWh)
- Forecast load today (kWh)
- Actual load today (kWh)
- Grid import today (kWh)
- AC consumption today (kWh)
- Surplus today (kWh)
- Grid-charged battery today (kWh)
- Solar-charged battery today (kWh)
- Daily import cost

### Section B — Forecast vs actual charts

Suggested charts:

- Solar forecast vs actual
- Load forecast vs actual
- Surplus forecast vs actual
- Combined forecast vs actual

### Section C — Energy-routing charts

Suggested charts:

- PV to load / battery / grid
- Grid to load / battery
- Battery to load / grid

### Section D — Hourly operations table

Suggested columns:

- Hour
- Grid Wh
- AC Wh
- Solar Wh
- Battery charge Wh
- Battery discharge Wh
- Surplus Wh
- Forecast solar Wh
- Forecast load Wh
- State (`done` or `live`)

### Section E — Controller diagnostics

Suggested widgets:

- active window
- grid setpoint
- charge current limit
- battery consumed Ah deficit
- forecast solar Ah offset
- voltage-limit active flag

---

## 10. Detailed Implementation Tasks

The tasks below are organized in the order that will produce a usable dashboard fastest while keeping the data model coherent.

### Phase 1 — Stabilize the current hourly dashboard

- [ ] **D1. Verify the existing dashboard tab works on the Cerbo runtime**
  - Confirm the Dashboard package is installed and active.
  - Open `/ui` and verify the `Energy` and `Energy Detail` tabs render.
  - Confirm the chart, table, summary text, and live text all update.

- [ ] **D2. Confirm `dashboardLiveHour` refreshes continuously**
  - Watch `DBG controller trace`.
  - Confirm `hourBudget.usedWh`, `acLoadBudget.usedWh`, `storedGridPowerW`, and `storedAcLoadPowerW` change over time.
  - Confirm the live dashboard row changes without waiting for an hour rollover.

- [ ] **D3. Confirm `dailySummary` persists completed hours correctly**
  - Trigger at least one real hour rollover.
  - Verify the row moves from live to completed.
  - Verify no duplicate completed rows for the same hour.

- [ ] **D4. Improve dashboard labels from internal naming to user-facing wording**
  - Rename widgets to clear operator language.
  - Standardize on English or bilingual labels.
  - Remove debug-style wording from end-user widgets.

### Phase 2 — Build a richer daily energy model

- [ ] **D5. Define a daily analytics state object in flow context**
  - Create a new `flow.dailyEnergyModel` or similar.
  - Store a single structured object per day.
  - Include hourly buckets and daily totals.

- [ ] **D6. Extend hourly aggregation beyond Grid and AC**
  - Add hourly series for any available solar production source from Victron.
  - Add hourly series for battery charge/discharge if available from Victron services.
  - Store these alongside existing Grid and AC hourly buckets.

- [ ] **D7. Add solar actuals capture from Victron inputs**
  - Identify the correct D-Bus paths for PV production or inverter AC output.
  - Create source nodes for those paths.
  - Integrate them with the hourly aggregation pattern already used for Grid and AC.

- [ ] **D8. Add battery charge/discharge actuals capture**
  - Identify a robust battery power source or battery current/voltage pair.
  - Distinguish charging vs discharging.
  - Integrate positive and negative energy separately into hourly totals.

### Phase 3 — Add forecast series, not only forecast totals

- [ ] **D9. Create a normalized per-hour solar forecast series**
  - Reuse `solarForecastAdjusted`.
  - Convert it into hourly buckets for the current day.
  - Store a dashboard-ready series in flow context.

- [ ] **D10. Define a load forecast model**
  - Decide whether load forecast is:
    - static schedule-based,
    - rolling average,
    - manual target profile,
    - or imported from an external source.
  - Store it as a 24-hour series.

- [ ] **D11. Add forecast surplus calculation**
  - For each hour compute:

$$
\text{forecastSurplusWh} = \max(0, \text{forecastSolarWh} - \text{forecastLoadWh})
$$

  - Store daily total and per-hour values.

- [ ] **D12. Add actual surplus calculation**
  - For each hour compute actual surplus using measured series.
  - Keep the same bucket boundaries as forecast series so comparison charts line up.

### Phase 4 — Implement the reference-style KPI panel

- [ ] **D13. Create a dashboard data-preparation function for left-column KPI cards**
  - This function should emit all top-level KPIs in one structured message.
  - Include daily totals, forecasts, and routing categories.

- [ ] **D14. Decide widget strategy for KPI cards**
  - Option A: `ui_text` widgets plus custom HTML formatting.
  - Option B: `ui_template` for a full card-column layout.
  - Option C: progress bars if a stable dashboard widget exists on the device.

- [ ] **D15. Implement cards for the metrics already available**
  - Forecast solar today
  - Actual solar today
  - Actual Grid today
  - Actual AC today
  - Current live-hour Grid and AC

- [ ] **D16. Implement placeholder cards for metrics not yet computed**
  - PV direct use
  - PV to battery
  - PV to grid
  - grid to battery
  - battery to load
  - battery to grid
  - daily cost
  - Render them as `N/A` or `pending metric` until real calculations exist.

### Phase 5 — Implement the forecast-vs-real charts

- [ ] **D17. Create a unified chart-model builder node**
  - Build all dashboard chart payloads from one function.
  - Use one internal daily model to avoid divergent calculations.

- [ ] **D18. Implement `Solar FC / Real` chart**
  - Series 1: forecast solar by hour
  - Series 2: actual solar by hour

- [ ] **D19. Implement `Consumption FC / Real` chart**
  - Series 1: forecast load by hour
  - Series 2: actual load by hour

- [ ] **D20. Implement `Surplus FC / Real` chart**
  - Series 1: forecast surplus by hour
  - Series 2: actual surplus by hour

- [ ] **D21. Implement `Forecast / Real today` combined overlay chart**
  - Include all major forecast and actual series in a single comparison view.
  - Keep labels readable and limit series count if rendering becomes noisy.

### Phase 6 — Implement energy-routing analytics

- [ ] **D22. Define routing equations carefully**
  - Avoid double-counting.
  - Write down exact formulas for:
    - PV direct to load
    - PV to battery
    - PV to grid
    - grid direct to load
    - grid to battery
    - battery to load
    - battery to grid

- [ ] **D23. Choose data sources for routing calculations**
  - Verify which Victron measurements are available and trustworthy.
  - Prefer directly measured D-Bus paths over inferred values when possible.

- [ ] **D24. Create a daily routing accumulator**
  - Store both hourly and total routing values.
  - Reset daily at midnight.
  - Preserve enough data to rebuild charts after refresh.

- [ ] **D25. Implement the battery movement chart**
  - Reproduce the reference idea using hourly kWh series.
  - Include only series that are actually measurable and useful.

### Phase 7 — Add tariff and cost analytics

- [ ] **D26. Define the tariff model explicitly**
  - Clarify import tariff source and units.
  - Decide whether night reduction is shown as billing metric only or also as daily energy cost logic.

- [ ] **D27. Compute daily import cost from hourly buckets**
  - Multiply hourly import energy by the tariff valid in that hour.
  - Sum daily total.

- [ ] **D28. If relevant, separate cost of direct load import vs battery charging import**
  - Show grid direct consumption cost separately from grid-to-battery cost.

### Phase 8 — Make the dashboard robust and operator-friendly

- [ ] **D29. Ensure all dashboard widgets repopulate on refresh**
  - Keep using `ui_ui_control` connect events.
  - Rebuild all widgets from flow context on browser connect.

- [ ] **D30. Add explicit `data freshness` indicators**
  - Show last update time for:
    - solar forecast
    - hourly stats
    - controller trace
    - daily totals

- [ ] **D31. Add empty-state handling**
  - If there is no data yet today, show meaningful placeholders instead of blank widgets.

- [ ] **D32. Keep the overview tab compact and detail tab analytical**
  - `Energy` tab: operator summary
  - `Energy Detail` tab: full charts and tables

- [ ] **D33. Add documentation for every derived metric**
  - Update README or a dedicated dashboard doc.
  - Define each metric, formula, unit, and data source.

---

## 11. Suggested File and Node Organization

To keep future work maintainable, the dashboard should be implemented with a clear separation of concerns.

Recommended pattern:

- raw measurement inputs
- hourly aggregators
- daily model builder
- forecast model builder
- routing model builder
- dashboard view-model builder
- dashboard widgets

Suggested new context/state names:

- `flow.dailyEnergyModel`
- `flow.dailyRoutingModel`
- `flow.dashboardViewModel`
- `flow.hourlyForecastSolar`
- `flow.hourlyForecastLoad`
- `flow.hourlyActualSolar`
- `flow.hourlyActualLoad`

This is cleaner than encoding every dashboard calculation inside widget-specific function nodes.

---

## 12. Recommended First Practical Implementation Order

If only the highest-value next steps are chosen, the order should be:

1. Make the existing hourly Grid/AC dashboard stable.
2. Add hourly actual solar series.
3. Build hourly forecast solar series from `solarForecastAdjusted`.
4. Add a left KPI panel with the metrics already available.
5. Add `Solar FC / Real` chart.
6. Add `Consumption FC / Real` chart once a load forecast exists.
7. Add surplus and routing analytics only after the data model is trustworthy.

---

## 13. Important Implementation Warning

The reference screenshot is a much richer analytics dashboard than the current repo data model supports.

It should **not** be copied visually first and filled with invented numbers.

Correct approach:

- first define the energy model
- then define the formulas
- then store the derived values in flow context
- then render the widgets

If the UI is built before the calculations are stable, the dashboard will look complete but will be misleading.

---

## 14. Summary

The reference dashboard is best understood as a daily energy-analysis board that combines:

- forecast totals
- actual totals
- forecast vs actual time-series comparisons
- battery movement visualization
- solar/load/surplus comparison charts
- routing breakdowns between PV, battery, grid, and load
- cost reporting

The current Victron project already has enough data for a basic hourly Grid/AC dashboard, but it does not yet have enough routing and forecast-series data to fully reproduce the reference dashboard.

The task list in this file is therefore focused on building the underlying data model first, then using that model to implement a trustworthy dashboard.


high-voltage-dashboard-context.md
# High-Voltage Protection Dashboard Context

## Purpose

This file is a focused implementation handoff for adding a new Node-RED Dashboard tab that configures high-voltage protection settings, persists them to a file, and reloads them on startup and dashboard connect.

It is intended for future implementation work in:

- `day-night.txt`
- `flows.json`
- Node-RED Dashboard nodes
- file-backed runtime configuration

This file does not implement the feature. It captures the current state, the required corrections, the proposed UI, the runtime data flow, and the implementation task list.

---

## 1. Feature Goal

Add a new dashboard tab that lets the user configure the high-voltage protection thresholds used by the controller:

- `HIGH_VOLTAGE_LIMIT_START`
- `HIGH_VOLTAGE_LIMIT_RELEASE`
- `HIGH_VOLTAGE_LIMIT_FULL`

The dashboard must:

- show the current saved settings
- allow the user to modify them with UI controls
- save them to a persistent file
- reload them from that file on startup
- reload them when the dashboard connects or refreshes
- make the controller use the persisted values instead of fixed hard-coded constants

---

## 2. Current State

### 2.1 Current high-voltage logic

The controller currently uses hard-coded constants in the main function source.

Current values in `day-night.txt`:

- `HIGH_VOLTAGE_LIMIT_START = 55.4`
- `HIGH_VOLTAGE_LIMIT_RELEASE = 55.2`
- `HIGH_VOLTAGE_LIMIT_FULL = 55.6`

These values currently control the grid-setpoint limiter behavior:

- limiter starts above `55.4 V`
- limiter releases at `55.2 V` or lower
- taper reaches the minimum grid setpoint by `55.6 V`

The relevant logic is in the high-voltage limiter section of the controller.

### 2.2 Current morning-solar rule

The controller now also contains a separate morning rule:

- `morningSolarChargeHold = solarForecast.valid && forecastRestoreAh > 0 && batteryVoltage > 54.5`

That rule is not the same thing as the high-voltage protection thresholds.

Important design distinction:

- the dashboard requested here is for high-voltage protection settings
- the morning solar hold threshold is currently a separate operational rule

Recommendation:

- do not mix the morning solar hold threshold into the first version of this dashboard
- keep it as a separate future setting unless the user explicitly wants a fourth configurable value

### 2.3 Current dashboard structure

The current `flows.json` already contains dashboard tabs:

- `Energy`
- `Energy Detail`
- `Analytics`

There are already `ui_tab`, `ui_group`, `ui_template`, and dashboard refresh/connect patterns in the flow.

This means the new feature should extend the existing dashboard rather than create a parallel design style.

### 2.4 Current file-write patterns in the flow

The current flow already writes files under:

- `/data/home/nodered/grid-control-logs/...`

It uses Node-RED `file` nodes with:

- `msg.filename`
- `createDir: true`
- `encoding: utf8`

This is a good existing pattern to reuse for configuration persistence.

### 2.5 Current mismatch risk

The repository keeps two controller representations:

- `day-night.txt` as the readable controller source
- `flows.json` as the deployed Node-RED export

The project has already experienced drift between these two files.

This feature must be implemented in a way that minimizes future drift. Runtime settings should come from a dedicated config file, not from repeatedly editing threshold constants in two different code copies.

---

## 3. Main Correction Required

The current controller treats high-voltage settings as code constants.

That is the root design problem for dashboard configurability.

To support a dashboard settings tab correctly, the high-voltage thresholds must move from:

- hard-coded source constants

to:

- runtime-loaded configuration values with fallback defaults

### Required correction

The controller should:

1. define code defaults for safety
2. load persisted settings from a JSON file into flow context
3. validate them before use
4. use runtime values from flow context in the limiter logic
5. fall back to defaults if the file is missing or invalid

This is a safer and more maintainable architecture than trying to edit code constants from the dashboard.

---

## 4. Recommended Runtime Configuration Design

### 4.1 File path

Recommended config path:

- `/data/home/nodered/grid-control-config/high-voltage-settings.json`

Reasons:

- separate from logs
- clearly owned by Node-RED
- stable and explicit
- easy to back up and inspect

### 4.2 File format

Recommended JSON structure:

```json
{
  "start": 55.4,
  "release": 55.2,
  "full": 55.6,
  "updatedAt": "2026-04-24T12:00:00.000Z",
  "source": "dashboard"
}
```

Recommended behavior:

- only `start`, `release`, and `full` are used by the controller
- `updatedAt` and `source` are for observability and debugging

### 4.3 Flow context object

Recommended in-memory structure:

```js
flow.set("highVoltageSettings", {
    start: 55.4,
    release: 55.2,
    full: 55.6,
    updatedAt: "...",
    source: "file"
});
```

### 4.4 Fallback defaults

The controller should still contain fallback defaults in code.

Recommended fallback object:

```js
const DEFAULT_HIGH_VOLTAGE_SETTINGS = {
    start: 55.4,
    release: 55.2,
    full: 55.6
};
```

The live limiter should then read something like:

```js
const hvSettings = flow.get("highVoltageSettings") || DEFAULT_HIGH_VOLTAGE_SETTINGS;
```

This keeps the controller safe if the file fails to load.

---

## 5. Startup and Load Behavior

### 5.1 On Node-RED startup or deploy

Add a startup path:

1. `inject` node configured with `once: true`
2. `file in` node reading the JSON file
3. function node to parse and validate settings
4. function node to store validated settings into `flow.highVoltageSettings`
5. optional status notification

### 5.2 If the file does not exist

The startup flow should:

- use fallback defaults
- store them in flow context
- optionally create the JSON file automatically

Recommended behavior for first version:

- load defaults into flow context
- write the default file once if missing

This avoids a state where the dashboard shows nothing.

### 5.3 On dashboard connect

When the dashboard opens, current saved values must populate the UI controls.

Use one of these patterns:

- `ui_control` connect event
- a refresh inject wired to the dashboard state builder

Recommended behavior:

- read `flow.highVoltageSettings`
- emit the current values to the widgets
- display source and last updated time

---

## 6. Save Behavior

When the user changes settings and presses save:

1. collect the UI values
2. validate them
3. write them into `flow.highVoltageSettings`
4. serialize them as JSON
5. write the JSON file
6. emit a notification or status message
7. optionally push the saved values back into the UI

Recommended save semantics:

- do not auto-save on every slider move
- require an explicit `Save` button

Reason:

- prevents accidental writes while dragging
- makes validation and confirmation easier
- reduces unnecessary file churn

---

## 7. Validation Rules

These rules should be enforced before saving and before using file data.

### Required validation

1. all values must be finite numbers
2. `full > start`
3. `start >= release`
4. values must remain inside a safe range

Recommended safe range:

- minimum `50.0`
- maximum `60.0`

### Recommended user-facing validation messages

- `Full voltage must be greater than start voltage`
- `Release voltage must not be higher than start voltage`
- `Value outside allowed range`
- `Invalid config file, defaults loaded`

### Invalid file behavior

If the file is invalid:

- do not apply invalid values
- use defaults
- show source as `fallback`
- raise a visible status message

---

## 8. Proposed Dashboard UI

### 8.1 New tab name

Recommended new tab:

- `Protection`

Alternative:

- `Battery Protection`

`Protection` is shorter and fits well with current tab naming.

### 8.2 Groups

Recommended groups:

1. `High Voltage Protection`
2. `Actions`
3. `Status`

### 8.3 Controls

Recommended controls for first version:

1. slider for `Start Voltage`
2. slider for `Release Voltage`
3. slider for `Full Limit Voltage`
4. live numeric text beside each slider
5. `Save` button
6. `Reload from File` button
7. `Reset to Defaults` button
8. status text card

### 8.4 Recommended slider ranges

#### Start Voltage

- range: `53.0` to `56.5`
- step: `0.1`

#### Release Voltage

- range: `52.5` to `56.0`
- step: `0.1`

#### Full Limit Voltage

- range: `53.5` to `57.0`
- step: `0.1`

These ranges are narrow enough to discourage bad input but broad enough for tuning.

### 8.5 Recommended status card fields

Display:

- active start voltage
- active release voltage
- active full voltage
- source: `file`, `fallback`, or `dashboard`
- last saved timestamp
- validation result
- config file path

---

## 9. Proposed UX Behavior

### 9.1 On first open

The tab should show:

- the saved file values if present
- otherwise the fallback defaults

### 9.2 While adjusting sliders

The user should see live values, but the controller should not change yet.

### 9.3 On save

The user should see:

- `Settings saved`
- timestamp
- maybe a short notification message

### 9.4 On invalid input

The save should be blocked.

The UI should keep the entered values visible, plus an error message.

### 9.5 On reload from file

The widgets should snap back to the persisted values.

### 9.6 On reset to defaults

The UI should restore default values locally.

Recommended behavior:

- reset does not persist automatically
- user must press `Save`

---

## 10. Controller Changes Required

The main controller must be refactored so the limiter does not depend on the hard-coded constants directly.

### Current limiter logic shape

The limiter currently references:

- `HIGH_VOLTAGE_LIMIT_START`
- `HIGH_VOLTAGE_LIMIT_RELEASE`
- `HIGH_VOLTAGE_LIMIT_FULL`

### Required refactor

Replace that direct dependency with runtime settings:

```js
const hvSettings = flow.get("highVoltageSettings") || DEFAULT_HIGH_VOLTAGE_SETTINGS;
const highVoltageLimitStart = Number(hvSettings.start);
const highVoltageLimitRelease = Number(hvSettings.release);
const highVoltageLimitFull = Number(hvSettings.full);
```

Then use those runtime values throughout the limiter and trace output.

### Also update trace payload

The `controller-trace` payload should include the active high-voltage settings so diagnostics show which values are live.

Recommended extra trace fields:

```js
highVoltageSettings: {
    start: highVoltageLimitStart,
    release: highVoltageLimitRelease,
    full: highVoltageLimitFull,
    source: hvSettings.source || "unknown"
}
```

---

## 11. Proposed Node-RED Flow Pieces

This is the recommended building-block list, not exact JSON yet.

### A. Startup load flow

- inject once on start
- function `Build HV config filename`
- file in `Read HV config`
- function `Parse and validate HV config`
- function `Store HV settings`
- optional debug/status output

### B. Dashboard input flow

- new `ui_tab`
- new `ui_group`
- three `ui_slider` nodes
- three `ui_text` or `ui_template` value displays
- `ui_button` save
- `ui_button` reload
- `ui_button` reset

### C. Save flow

- function `Collect and validate dashboard HV settings`
- function `Serialize HV config JSON`
- file node `Write HV config`
- function `Store HV settings in flow`
- notification/status output

### D. Dashboard state refresh flow

- `ui_control` connect event or inject refresh
- function `Build HV dashboard state`
- outputs to sliders/text widgets

---

## 12. Detailed Task List

### Phase 1 - File-backed runtime settings

1. Add a config file path constant for high-voltage settings.
2. Add startup flow nodes to read the JSON file.
3. Add parser/validator logic for persisted settings.
4. Store validated settings in `flow.highVoltageSettings`.
5. Auto-fallback to defaults when file is missing or invalid.
6. Optionally write the default file when no file exists.

### Phase 2 - Controller refactor

7. Refactor `day-night.txt` to use runtime high-voltage settings instead of fixed constants.
8. Mirror the same change into the embedded function in `flows.json`.
9. Update trace payload to expose active settings and source.
10. Keep fallback defaults in code for safe startup behavior.

### Phase 3 - Dashboard UI

11. Add a new dashboard tab named `Protection`.
12. Add groups for settings, actions, and status.
13. Add three sliders with live displayed numeric values.
14. Add save, reload, and reset buttons.
15. Add a status panel showing source, last saved time, and active values.

### Phase 4 - Save and reload flows

16. Build save validation logic.
17. Serialize settings to JSON.
18. Write settings to `/data/home/nodered/grid-control-config/high-voltage-settings.json`.
19. Reload and repopulate dashboard values on connect.
20. Show save success or error notifications.

### Phase 5 - Validation and tests

21. Test startup with no config file.
22. Test startup with valid config file.
23. Test startup with corrupted config file.
24. Test save and immediate controller use of new values.
25. Test browser reconnect and slider repopulation.
26. Test invalid ordering such as `release > start`.

---

## 13. Risks and Edge Cases

### Risk 1 - Drift between code and deployed flow

Any controller logic change must be applied to both `day-night.txt` and `flows.json`.

Mitigation:

- treat `day-night.txt` as the readable source while editing
- immediately mirror the exact logic into `flows.json`
- validate after each change

### Risk 2 - Corrupted or missing config file

If the JSON file is malformed, the controller must not break.

Mitigation:

- strict validation
- safe defaults
- visible fallback status

### Risk 3 - Slider-only input can be imprecise

Sliders are good operationally but can be awkward for exact values.

Mitigation:

- keep `0.1 V` step size
- show the exact numeric value beside each slider

Optional future enhancement:

- add numeric input fields next to sliders

### Risk 4 - Confusing high-voltage settings with morning solar hold

These are separate behaviors.

Mitigation:

- keep the first version limited to the three high-voltage thresholds
- consider a separate dashboard section later for morning charging rules

### Risk 5 - Invalid threshold ordering causing unstable limiter behavior

Mitigation:

- block save if `start < release`
- block save if `full <= start`

---

## 14. Recommended First Implementation Scope

The safest first scope is:

- add one new dashboard tab
- configure only `start`, `release`, and `full`
- persist to one JSON file
- load on startup
- repopulate on dashboard connect
- keep the morning solar hold rule unchanged

This keeps the work bounded and avoids mixing multiple policy settings into one first pass.

---

## 15. Recommended Future Enhancements

After the first version is stable, consider:

1. adding numeric input boxes beside sliders
2. adding a fourth setting for the morning solar hold threshold
3. adding a small preview card showing when the limiter would become active
4. logging threshold changes to a dedicated config-change log
5. exposing active high-voltage settings in the analytics dashboard diagnostics panel

---

## 16. Implementation Notes for the Next Coding Session

When implementing this feature, start in this order:

1. add file-backed startup load flow
2. refactor controller to use runtime settings
3. add the new dashboard tab and controls
4. add save/reload/reset flows
5. validate startup, save, and reconnect behavior

Do not start with the dashboard widgets first. Without runtime file-backed settings, the UI would only edit temporary values and would not solve persistence correctly.

notification-research.md
# Victron Cerbo GX — D-Bus Notification Research
_Investigated: April 23, 2026 — firmware: Venus OS Large on Cerbo GX (einstein)_

---

## D-Bus services confirmed running

```
com.victronenergy.platform
com.victronenergy.hub4
com.victronenergy.system
com.victronenergy.vebus.ttyS4
com.victronenergy.battery.ttyACM0
com.victronenergy.settings
com.victronenergy.fronius
com.victronenergy.logger
com.victronenergy.vecan.vecan0
com.victronenergy.digitalinputs
com.victronenergy.modbusclient.tcp
com.victronenergy.modbustcp
com.victronenergy.ble
com.victronenergy.adc
debug.victronenergy.gui
```

---

## /Notifications paths on com.victronenergy.platform

```
/Notifications/0                       — existing notification (dict, read-only, device-created)
/Notifications/1                       — existing notification (dict, read-only, device-created)
/Notifications/AcknowledgeAll          — writable
/Notifications/Alarm                   — boolean aggregate (read-only result: False)
/Notifications/Alert                   — writable boolean, accepts SetValue int/string (retval=0)
/Notifications/NumberOfActiveAlarms
/Notifications/NumberOfActiveInformations
/Notifications/NumberOfActiveNotifications
/Notifications/NumberOfActiveWarnings
/Notifications/NumberOfNotifications
/Notifications/NumberOfUnAcknowledgedAlarms
/Notifications/NumberOfUnAcknowledgedInformations
/Notifications/NumberOfUnAcknowledgedWarnings
```

### /Notifications/Inject — DOES NOT EXIST
The path used by the Victron Node-RED `victron-output-custom` node configured with
`com.victronenergy.platform / /Notifications/Inject` does **not** exist on this firmware.
This is why the node showed "An unknown error occurred".

---

## Structure of an existing notification (/Notifications/0)

```python
{
  'Acknowledged': True,
  'Active': False,
  'AlarmValue': 2,
  'DateTime': 1776546506,          # Unix timestamp
  'Description': 'Low SOC',        # Human-readable text shown in GX
  'DeviceName': 'SerialBattery(LLT/JBD)',
  'Service': 'com.victronenergy.battery.ttyACM0',
  'Silenced': True,
  'Trigger': '/Alarms/LowSoc',     # The D-Bus path that triggered this
  'Type': 1,                        # 0=info, 1=warning, 2=alarm
  'Value': '40.79'
}
```

---

## How real notifications are created

1. A device service (e.g. `com.victronenergy.battery.ttyACM0`) exposes `/Alarms/<Name>` paths.
2. The platform service (`venus-platform`) monitors all registered D-Bus services.
3. When an `/Alarms/*` path becomes non-zero, `venus-platform` creates a new numbered
   entry under `/Notifications/<n>` automatically.
4. There is **no public text-injection API** — you cannot push arbitrary text notifications
   via D-Bus from Node-RED without registering a full custom D-Bus service.

---

## What /Notifications/Alert actually does

```bash
dbus -y com.victronenergy.platform /Notifications/Alert SetValue 1
# retval = 0  (accepted)
# Result: increments /Notifications/NumberOfActiveAlerts counter only
# Does NOT create a visible GX screen notification with a description
```

---

## Options to send custom notifications

| Method | Description | Complexity |
|---|---|---|
| **Log files** (implemented) | Write to `/data/grid-control-logs/grid-control-YYYY-MM-DD.log` | Done |
| **Custom D-Bus service** | Python daemon registers `com.victronenergy.gridcontrol`, exposes `/Alarms/GridSetpoint`. Platform picks it up and shows it on GX screen with description. | High — requires persistent daemon + sv/runit service |
| **MQTT to local broker** | `mqtt out` node → `localhost:1883` → topic `N/903245/gridcontrol/0/Alarms/GridSetpoint` → forwarded to VRM | Medium — `dbus-mqtt` is running |
| **Node-RED notification node** | Built-in `notification` node in Node-RED (if installed) | Not installed on this device |

---

## Recommended next step: MQTT route

`dbus-mqtt` is confirmed running (`com.victronenergy.logger` + `dbus-mqtt` service).
Local MQTT broker on Cerbo GX listens on **port 1883**.

VRM portal ID: `903245`

MQTT topic pattern for custom data:
```
W/903245/gridcontrol/0/CustomName
```

Node-RED flow addition needed:
- `mqtt-broker` config node: `localhost:1883`, no auth
- `mqtt out` node: topic `W/903245/gridcontrol/0/Alarms/GridSetpoint`, QoS 0, retain false
- Format: `msg.payload = JSON.stringify({ value: <number_or_string> })`

---

## Implementation Tasks

### Option A — MQTT (recommended, medium effort)

- [ ] **A1. Verify local MQTT broker is accessible**
  - SSH: `mosquitto_pub -h localhost -p 1883 -t "test/ping" -m "hello" && echo OK`
  - If fails: check `svstat /service/dbus-mqtt`

- [ ] **A2. Discover correct MQTT topic prefix**
  - SSH: `mosquitto_sub -h localhost -p 1883 -t "N/903245/#" -v 2>/dev/null | head -n 20`
  - Confirm VRM portal ID is `903245` (already seen in VRM proxy URL)

- [ ] **A3. Add `mqtt-broker` config node to flows.json**
  - id: `mqtt-broker-local-01`
  - host: `localhost`, port: `1883`, no credentials, no TLS

- [ ] **A4. Add notification formatter function node**
  - id: `notif-mqtt-fmt-01`
  - Receives controller output 3 (notification msg)
  - Builds: `msg.topic = "W/903245/gridcontrol/0/GridSetpoint"`
  - Builds: `msg.payload = JSON.stringify({ value: msg.notification.message })`

- [ ] **A5. Add `mqtt out` node**
  - id: `notif-mqtt-out-01`
  - broker: `mqtt-broker-local-01`
  - topic: from `msg.topic`
  - QoS: 0, retain: false

- [ ] **A6. Wire controller output 3 → notif-mqtt-fmt-01 → notif-mqtt-out-01**
  - Also keep existing wire to `notif-log-fmt-01`
  - wires[3] = `["notif-log-fmt-01", "notif-mqtt-fmt-01"]`

- [ ] **A7. Bump tab version to d#14, sync day-night.txt → flows.json**

- [ ] **A8. Test: deploy and check VRM portal custom widget**
  - VRM → Advanced → Custom widgets → look for `gridcontrol` data

---

### Option B — Custom D-Bus service (full GX screen notification, high effort)

- [ ] **B1. Write Python daemon**
  - Registers `com.victronenergy.gridcontrol` on D-Bus
  - Exposes `/Alarms/GridSetpoint` path (type: int, 0=ok, 1=warning, 2=alarm)
  - Exposes `/CustomName` = `"Grid Controller"`
  - Exposes `/DeviceInstance` = `100`
  - Uses `vedbus.py` from `/opt/victronenergy/dbus-systemcalc-py/ext/velib_python/`

- [ ] **B2. Create runit service**
  - Write `/data/etc/services/gridcontrol-dbus/run` shell script
  - `chmod +x run`
  - `ln -s /data/etc/services/gridcontrol-dbus /service/`

- [ ] **B3. Connect Node-RED to daemon via MQTT or file**
  - Daemon watches a file `/data/grid-control-logs/alarm-state.json`
  - Node-RED writes `{"active": true, "message": "..."}` to that file on setpoint change
  - Daemon reads file and updates `/Alarms/GridSetpoint` on D-Bus
  - Platform service sees the alarm and creates a `/Notifications/<n>` entry with description

- [ ] **B4. Test GX screen shows notification bell with description text**

---

### Prerequisite checks (run before starting either option)

```bash
# Check MQTT broker is running
svstat /service/dbus-mqtt

# Check mosquitto tools are available
which mosquitto_pub mosquitto_sub

# Check velib_python is accessible
ls /opt/victronenergy/dbus-systemcalc-py/ext/velib_python/vedbus.py
```

