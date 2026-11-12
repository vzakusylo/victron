[Home](../README.md) · **Overview** · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md)

# Overview & architecture

> Goal, signal flow, control layers

**On this page:**

- [Goal](#goal)
- [High-level architecture](#high-level-architecture)
  - [Current Node-RED flow](#current-node-red-flow)
  - [Main signal flow](#main-signal-flow)
- [Control layers](#control-layers)
  - [Priority order](#priority-order)

## Goal

The main operational goal is to keep hourly raw grid import under practical limits that fit Norwegian capacity-based network tariffs, while still charging the battery when needed.

The current design target depends on the tariff season (switched automatically by date):

- summer (from 15 Apr, tier 1 ≤ 2 kW): day `1950 W` / `9.5 A`, night `2850 W` / `13.5 A`
- winter (from 17 Oct, tier 2 ≤ 5 kW): day `4950 W` / `23.5 A`, night `6440 W` / `31 A` (+30 %)
- night is allowed to be higher because this project was tuned around an Elvenett-style reduced night weighting factor (`0.7`)

This logic is especially useful when:

- the house has a battery bank
- the inverter/charger can import from grid under ESS control
- the user wants to avoid expensive monthly capacity steps caused by a few high hourly peaks

## High-level architecture

### Current Node-RED flow

![Node-RED flow canvas — d#63](images/flows.png)

```mermaid
flowchart LR
    A[GRID CT sensor<br/>House import power] --> B[GX System service<br/>Ac Grid L1 Power]
    C[Battery service<br/>DC voltage] --> D[Node-RED controller]
    B --> D
    E[Time windows<br/>Day / Night / Morning / Evening] --> D
    X[Solar forecast summary<br/>flow.solarForecastToday] --> D

    D --> F[DVCC charge current limit]
    D --> G[ESS grid setpoint]
    D --> H[Notification message]
    D --> I[Notification message]

    G --> J[MultiPlus / ESS behavior]
    F --> J
    J --> K[Actual house import from grid]
    K --> A
```

### Main signal flow

1. Cerbo GX exposes live data from the battery and GRID CT sensor.
2. Node-RED reads:
   - battery voltage
   - grid import power measured by the house CT sensor
   - current time
3. The controller calculates:
  - how many Ah the battery still needs to restore from the BMS net consumed-Ah reading
  - whether the remaining deficit must be charged now in NIGHT, or can wait for MORNING
  - how much predicted solar energy can offset that remaining grid-charging need
   - the final grid setpoint
   - the hourly imported energy used so far
4. The outputs are written back into Victron settings and VE.Bus controls.
5. Actual import changes and the loop repeats.

## Control layers

The controller is not a single rule. It is a stack of limits.

```mermaid
flowchart TD
  A[Season plan<br/>summer 1950 / 2850 W, winter 4950 / 6440 W] --> E[Final grid setpoint]
    B[Battery deficit logic<br/>BMS Consumed Amphours] --> F[Final charge current]
  C[Solar forecast offset<br/>Predicted solar Ah] --> F
  D[High-voltage limiter<br/>55.2 V start, 55.0 V release] --> E
  G[Day high load<br/>above 4000 W AC: 100 W lower] --> E
  X[Export guard<br/>floor at the minimum grid import] --> E
    F --> H[DVCC charge current limit]
```

### Priority order

The final grid setpoint is the minimum of:

1. season plan (day / night setpoint of the active tariff season)
2. high-voltage limiter and battery grid support
3. day high-load reduction (AC loads above 4000 W outside 22–06)

and never below the export-guard floor while the guard is active.

Hourly imported energy is still tracked and shown in status text, but it is display-only and does not override the schedule.

---

← [Home](../README.md) | [Control logic](control-logic.md) →
