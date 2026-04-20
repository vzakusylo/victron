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
- Always set charge current to **25 A**
- This is a fixed forced charge-current limit at night

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
- Function returns `null`
- It does not modify charge current

### State handling
The logic uses `context`:
- `boostActive`
- `activeWindow`

This avoids noisy oscillation when the voltage hovers around the threshold.

### Night priority
The night rule is checked first and returns immediately.
Night behavior therefore has priority over morning/evening logic.

---

## 7. Latest Function Node Logic (Current Working Reference)

This is the latest function logic state from the chat, conceptually:

- If time is between 22:00 and 06:00 -> charge current = 25 A
- Else if in morning window -> apply hysteresis using 53.5 / 53.8
- Else if in evening window -> apply hysteresis using 54.0 / 54.4
- Else -> do nothing

The final implementation also resets state when switching between windows so that a night state does not leak into morning or evening logic.

---

## 8. Dynamic Hourly Budget Controller Idea (For Future Work)

A future direction discussed in the chat is a **real-time hourly grid budget controller**.

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

- **Blue** for NIGHT fixed charging
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

- Night charging is currently intended to be **fixed 25 A from 22:00 to 06:00**
- Morning and evening charging are **voltage-triggered with hysteresis**
- Actual charging behavior depends on actual Victron ESS / charger mode
- Elvenett app raw `kW` values are not the same as the adjusted nighttime capacity values
- Future automation may need both:
  - **charge current control**, and
  - **dynamic grid budget control per current hour**

---

## 16. Current Function Logic Snapshot (Short Form)

### Current target behavior snapshot
- **22:00-05:59** -> 25 A always
- **06:00-11:59** -> 25 A if V < 53.5, off if V > 53.8
- **17:00+** -> 25 A if V < 54.0, off if V > 54.4
- otherwise -> no action

This snapshot is the most important quick reference for future coding.
