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
8. **Add persistence and replay-safe startup logic**
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
