[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · **Limitations**

# Assumptions, limitations & roadmap

> Operational assumptions, current limitations, recommended improvements

**On this page:**

- [Operational assumptions](#operational-assumptions)
- [Current limitations](#current-limitations)
- [Recommended future improvements](#recommended-future-improvements)

## Operational assumptions

This repository assumes:

- Cerbo GX with Venus OS Large
- Node-RED installed on the GX device
- Victron ESS capable system
- battery service visible on D-Bus / Victron nodes
- GRID CT sensor visible via `com.victronenergy.system /Ac/Grid/L1/Power`
- one-phase import measurement for the tuned logic in this repo

If the installation is three-phase, the grid measurement source and budget logic should be adapted accordingly.

## Current limitations

- the hourly counter currently uses `L1` grid power; multi-phase sites need adaptation
- the project is tuned to one specific tariff interpretation and should be validated against the actual current network tariff
- local GX notification injection may not work on all installed Victron node versions
- actual charging behavior still depends on ESS mode and total system state; a DVCC limit is not itself a direct “force charge” command
- `flows.json` may still contain legacy inject nodes or unused branches that are no longer driven by the main controller

## Recommended future improvements

Future tasks to improve the model:

- [ ] use **remaining forecast energy from now forward** instead of subtracting the full-day solar forecast from the current battery deficit
- [ ] split the BMS `Consumed Amphours` deficit across **remaining NIGHT hours and remaining MORNING hours** instead of treating MORNING as the only fallback window
- [ ] replace the current on/off `25 A` restoration with a **required average charge current** calculation, capped at `25 A`
- [ ] smooth the BMS `Consumed Amphours` signal with a short moving average or deadband so short-term noise does not cause bursty morning charging
- [ ] calibrate the Ah-restoration math using real battery data:
  - verify whether `/ConsumedAmphours` sign handling is always negative-for-deficit on this BMS
  - tune `SOLAR_TO_BATTERY_EFFICIENCY`
  - tune the fallback battery voltage used for kWh-to-Ah conversion
- [ ] use **live battery power/current** together with `Consumed Amphours` to estimate how quickly restoration is actually happening instead of assuming the commanded DVCC current becomes stored battery capacity directly
- [ ] add a small **target reserve** so the controller does not always try to restore exactly to zero deficit when forecast uncertainty is high
- [ ] distinguish between `sunny`, `cloudy`, and `low` forecast days using **remaining hourly forecast profile** instead of only the current whole-day summary
- [ ] add logging for:
  - starting consumed-Ah deficit at 22:00 and 06:00
  - forecast Ah offset used by the controller
  - actual Ah restored by end of MORNING window
  - whether the restoration target was met
- [ ] add a daily review report comparing:
  - predicted solar restoration Ah
  - actual solar/battery restoration Ah
  - grid energy imported for restoration
  - final remaining deficit at noon
- [ ] support 3-phase grid measurement for sites where `L1` is not enough
- [ ] move tariff constants, battery constants, and restoration tuning parameters into a dedicated config object or file
- [ ] add explicit handling for spot-price based charging optimization on top of the Ah-restoration model

---

← [Development & deployment](development.md) | [Home](../README.md) →
