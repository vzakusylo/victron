# Victron Cerbo GX hourly grid control for Norway

This repository contains a Node-RED based controller for a Victron ESS system running on Cerbo GX.

The project is designed to reduce hourly grid peaks in Norway while still allowing useful battery charging during selected time windows. The control logic combines:

- battery-voltage driven charging windows
- dynamic grid setpoint control
- dynamic VE.Bus Input 1 current limit control
- hourly imported-energy tracking from the house GRID CT sensor
- high-voltage protection when an external charger or MPPT raises battery voltage

The repository keeps a readable controller source in `day-night.txt` and a live Node-RED export in `flows.json`.

---

## Repository contents

- `day-night.txt`  
  Human-readable source-of-truth for the main Node-RED function.

- `flows.json`  
  Exported Node-RED flow used on Cerbo GX.

- `victron_elvenett_context.md`  
  Detailed design notes, tariff assumptions, and implementation history.

---

## Goal

The main operational goal is to keep hourly raw grid import under practical limits that fit Norwegian capacity-based network tariffs, while still charging the battery when needed.

The current design target is:

- daytime raw import target around `1950-2000 W`
- night raw import target around `2700 W`
- night is allowed to be higher because this project was tuned around an Elvenett-style reduced night weighting factor

This logic is especially useful when:

- the house has a battery bank
- the inverter/charger can import from grid under ESS control
- the user wants to avoid expensive monthly capacity steps caused by a few high hourly peaks

---

## High-level architecture

```mermaid
flowchart LR
    A[GRID CT sensor<br/>House import power] --> B[GX System service<br/>Ac Grid L1 Power]
    C[Battery service<br/>DC voltage] --> D[Node-RED controller]
    B --> D
    E[Time windows<br/>Day / Night / Morning / Evening] --> D

    D --> F[DVCC charge current limit]
    D --> G[ESS grid setpoint]
    D --> H[VE.Bus Input 1 current limit]
    D --> I[Notification message]

    G --> J[MultiPlus / ESS behavior]
    H --> J
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
   - whether charging boost should be active
   - the final grid setpoint
   - the final VE.Bus Input 1 current limit
   - the hourly imported energy used so far
4. The outputs are written back into Victron settings and VE.Bus controls.
5. Actual import changes and the loop repeats.

---

## Control layers

The controller is not a single rule. It is a stack of limits.

```mermaid
flowchart TD
    A[Base schedule<br/>Day 1950 W / Night 2700 W] --> E[Final grid setpoint]
    B[Battery window logic<br/>Night / Morning / Evening hysteresis] --> F[Final charge current]
    C[High-voltage limiter<br/>55.0 V start, 54.8 V release] --> E
    D[Hourly import budget limiter<br/>Wh used this hour] --> E
    E --> G[Derived Input 1 current limit]
    F --> H[DVCC charge current limit]
```

### Priority order

The final grid setpoint is the minimum of:

1. base schedule
2. high-voltage limiter
3. hourly budget limiter

That means the hourly budget limiter can override the normal schedule when the hour is already too “full”.

---

## Functional behavior

## 1. Charging windows

The battery charging logic uses hysteresis, so it does not rapidly chatter on small voltage changes.

### Night window

- active time: `22:00-05:59`
- turn boost on again at `<= 54.5 V`
- turn boost off at `>= 54.8 V`
- target charge current when active: `25 A`

### Morning window

- active time: `06:00-11:59`
- turn boost on at `< 53.5 V`
- turn boost off at `> 53.8 V`
- target charge current when active: `25 A`

### Evening window

- active time: `17:00-23:59` with night taking priority from `22:00`
- turn boost on at `< 54.0 V`
- turn boost off at `> 54.4 V`
- target charge current when active: `25 A`

### Outside windows

- charge current limit goes to `0 A`
- grid control still remains active

---

## 2. Grid setpoint schedule

Base target:

- day: `1950 W`
- night: `2700 W`

This is only the starting point. The controller may lower it further if:

- the battery voltage is already too high
- the allowed hourly energy budget is being exhausted

---

## 3. High-voltage protection

This layer exists because an external charger or MPPT may increase battery voltage even when the Victron charger is not the only charging source.

Behavior:

- limiter starts when battery voltage rises above `55.0 V`
- limiter remains active until battery voltage falls back to `54.8 V` or below
- the grid setpoint tapers down smoothly
- by `55.2 V`, the voltage limiter can push the setpoint down toward `200 W`

Smoothing is used so the grid setpoint does not jump too aggressively.

---

## 4. Hourly consumed-energy counter

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

---

## 5. Dynamic Input 1 current limit

The VE.Bus Input 1 current limit is derived from the final grid setpoint.

Approximate logic:

- current limit = `grid setpoint / grid voltage`
- grid voltage defaults to `230 V` if no better value is available
- safe caps:
  - day: `9.6 A`
  - night: `12.6 A`

If the hourly budget is already exhausted, or grid-power data is unavailable, the controller falls back to these safe caps instead of pushing the limit to zero.

---

## 6. Output update pacing

To avoid excessive control chatter, the live flow adds output delays:

- grid setpoint changes are rate-limited to every `10 seconds`
- Input 1 current limit changes are rate-limited to every `10 seconds`

This prevents rewriting Victron settings every second.

---

## Node-RED architecture

```mermaid
flowchart LR
    A[Battery voltage source] --> B[Delay]
    B --> C[Tag battery-voltage]
    C --> H[Battery + Grid Controller]

    D[GRID CT import power] --> E[Delay 30s]
    E --> F[Tag grid-power]
    F --> H

    G[Optional grid import override] --> E

    H --> I[DVCC charge current limit]
    H --> J[Delay grid setpoint 10s]
    J --> K[ESS grid setpoint output]
    H --> L[Delay input limit 10s]
    L --> M[VE.Bus Input 1 current limit output]
    H --> N[Notification formatter]
    N --> O[GX notification output]
```

### Notes

- `day-night.txt` should remain the readable master logic.
- `flows.json` should be synchronized after each controller update.
- Notification transport exists in the flow, but the local GX notification output may depend on service availability on the target Cerbo GX.

---

## Pricing model in Norway

This section explains the pricing model relevant to why this controller exists.

Exact tariffs vary by:

- network company
- electricity supplier
- municipality
- taxes and government changes over time

This README therefore focuses on the structure of Norwegian pricing and on the project assumptions used in the controller.

## 1. Typical electricity bill structure in Norway

A Norwegian electricity bill usually has two major commercial parts:

### A. Power supplier cost

This is what you pay the electricity supplier for the energy itself.

Typical components:

- Nord Pool spot price by hour
- supplier markup
- fixed monthly fee, if applicable
- VAT, where applicable

This part is energy-based, so it depends on `kWh` consumed in each hour.

### B. Network tariff (`nettleie`)

This is what you pay the local grid company.

Typical components:

- energy charge (`øre/kWh`)
- capacity charge (`kapasitetsledd`)
- public fees and taxes
- fixed elements, depending on tariff design

For many households, the network tariff is strongly affected by the highest hourly peaks during the month.

---

## 2. Why hourly power matters

In Norway, the network tariff for households increasingly depends on hourly peak behavior.

That means:

- a short period of high power can be more expensive than the same energy spread over time
- the bill is influenced not only by total `kWh`, but also by the shape of consumption
- battery charging is a common cause of artificial hourly peaks

This repository therefore aims to flatten imported power by controlling charging intensity.

---

## 3. Project assumption: Elvenett-style capacity logic

This project was tuned around an Elvenett interpretation discussed during development:

- daytime practical raw target around `2.0 kW`
- night hours may be weighted lower for capacity purposes
- the user specifically optimized around a night factor of `0.7`

That implies the following reasoning:

- daytime raw `2.0 kW` stays close to the desired practical cap
- night raw import can be somewhat higher without causing the same effective capacity burden
- a practical night target of `2.5-2.7 kW` is acceptable for this system design

Example project math:

- `2.7 kW raw * 0.7 = 1.89 kW effective`

This is why the repository uses:

- day base setpoint: `1950 W`
- night base setpoint: `2700 W`

---

## 4. Capacity-step risk

A key operational idea is that the bill is often driven by a few bad hours, not by average behavior.

Risk pattern:

- battery charging starts too hard
- total house load is already elevated
- the hour ends with a high raw import peak
- the month is pushed into a higher capacity step

The controller reduces that risk by:

- lowering charging when the battery is already sufficiently charged
- limiting import if too much has already been used earlier in the same hour
- allowing more relaxed behavior at night

---

## 5. Hourly budget model used by this controller

The controller internally uses an hourly energy budget approximation.

For each clock hour:

- `E_budget_Wh = target_power_W * 1h`
- `E_used_Wh` is accumulated from live GRID CT power
- `E_left_Wh = max(0, E_budget_Wh - E_used_Wh)`
- allowed average power for the rest of the hour is recalculated from the remaining time

Conceptually:

```text
E_budget_Wh = P_limit * 1h
E_left_Wh   = max(0, E_budget_Wh - E_used_Wh)
P_allow_W   = E_left_Wh / t_left_h
```

This allows the controller to be stricter near the end of an hour if too much energy has already been imported earlier in that same hour.

---

## 6. Practical Norwegian interpretation

This project should be understood as a control strategy for Norwegian household electricity economics, not just a charging script.

It tries to optimize three things at once:

1. maintain usable battery state-of-charge
2. avoid unnecessary raw hourly peaks during the day
3. exploit more favorable night conditions when available

In practice, that means the system behaves like a soft peak-shaving battery charger.

---

## Operational assumptions

This repository assumes:

- Cerbo GX with Venus OS Large
- Node-RED installed on the GX device
- Victron ESS capable system
- battery service visible on D-Bus / Victron nodes
- GRID CT sensor visible via `com.victronenergy.system /Ac/Grid/L1/Power`
- one-phase import measurement for the tuned logic in this repo

If the installation is three-phase, the grid measurement source and budget logic should be adapted accordingly.

---

## Deployment workflow

Recommended workflow when editing the logic:

1. edit `day-night.txt`
2. synchronize the function content into `flows.json`
3. import or deploy the updated flow to the Cerbo GX
4. verify:
   - battery voltage input is updating
   - GRID CT import power is updating
   - status text shows correct hour range and `Wh`
   - grid setpoint and Input 1 current limit change no faster than every 10 seconds

---

## Current limitations

- the hourly counter currently uses `L1` grid power; multi-phase sites need adaptation
- the project is tuned to one specific tariff interpretation and should be validated against the actual current network tariff
- local GX notification injection may not work on all installed Victron node versions
- actual charging behavior still depends on ESS mode and total system state; a DVCC limit is not itself a direct “force charge” command

---

## Recommended future improvements

Possible next steps:

- support 3-phase grid measurement
- use live grid voltage instead of a default `230 V`
- add a dashboard showing current hour budget remaining
- add logging of hourly imported energy for analysis
- separate tariff configuration into a dedicated config object or file
- add explicit handling for spot-price based charging optimization

---

## Summary

This repository is a practical Victron + Node-RED implementation for Norwegian hourly peak control.

It combines:

- time-window charging
- voltage hysteresis
- hourly imported-energy counting
- dynamic power limiting
- Norway-oriented tariff thinking

The result is a controller that is intended to be understandable, editable, and directly useful on a Cerbo GX based ESS installation.
