# Grid controller input freshness and cadence

## Input inventory

All six Victron nodes below have `onlyChanges: false`. They can repeat cached payloads every five seconds. Neither the repeated payload nor Node-RED arrival time proves the device sampled again.

| Input node | Venus service instance and path | Emitted GX topic (d#231) | Controller topic | Former 10 s delay | Former tag node |
|---|---|---|---|---|---|
| `07c74490cafdc55a` | battery 289 `/Dc/0/Voltage` | `<device display name> - Battery voltage (V)` | `battery-voltage` | `87b4ad2bc3ec6903` | `1d4e50f4d614e8a5` |
| `0ee582b64b26e2e7` | battery 289 `/ConsumedAmphours` | `Battery SmartShunt consumed Ah` | `battery-consumed-ah` | `fd95dc1c428330fb` | `b2064b2168543e59` |
| `751d13b6d943e5e5` | system 0 `/Ac/Grid/L1/Power` | `GRID CT import power` | `grid-power` | `e84b0d054ca0f956` | `efb076ae80adc1c5` |
| `11e303e775ec959c` | system 0 `/Ac/Consumption/L1/Power` | `AC Loads power` | `ac-load-power` | `ec0378c28791feff` | `4ae3639bc75d0d14` |
| `dc7f2a1c3e8b09c4` | system 0 `/Dc/System/Power` | `DC System Power` | `dc-power` | `dc3b8e51a09c72d4` | `dc9d4c2e7a1b83f6` |
| `pv-charger-input-01` | system 0 `/Dc/Pv/Power` | `PV Charger Power` | `pv-charger-power` | none | `pv-charger-tag-01` |

Voltage routing matches the configured `Battery voltage (V)` path label, not the device display name. If the
path label is edited in Node-RED, update the controller's suffix and regression test together.

The grid override link `704426f76aa6aa4c` enters the same grid delay as the real input. It is not a freshness source. Battery current is not a control input today. ESS and DVCC have separate **output** limits of one message per 10 s with drops (`70b033ccd4654b3e`, `c1803b5fed00bfc2`); VE.Bus current limit (`66951950bfa6d862`) is written on change or at an hour boundary.

## Source freshness contract

Keep transport arrival time separate from sample time. Use evidence from the driver that acquired the measurement: a monotonic sample counter or timestamp that advances after every valid acquisition even at an identical reading, or an explicit invalid/disconnected indication from that driver. A counter may cover multiple properties only when they were all acquired in the same sampling cycle. An unrelated change, polling a cached D-Bus value, or a watchdog in the consumer cannot certify the sample.

Victron's [`VeDbusService`](https://github.com/victronenergy/velib_python/blob/master/vedbus.py) emits `ItemsChanged` for changed values. That proves a change happened, not that no unchanged samples have arrived since. `/Connected` or loss of the D-Bus service owner can invalidate a source immediately but does not detect every frozen property. Grid energy counters can stop while idle; current can remain at zero; PV can remain at zero overnight. None is a general heartbeat.

| Input | Evidence required before enabling age-based fallback | Candidate maximum age, not validated on hardware |
|---|---|---:|
| Grid CT | Source meter acquisition counter or timestamp covering L1, with source identity carried through systemcalc or mapped to the configured meter | 10 s |
| Battery voltage, current and consumed Ah | SmartShunt frame/acquisition evidence covering each property; a current change alone does not certify voltage or Ah | 30 s |
| PV | Acquisition evidence from each producer contributing to the aggregate; also distinguish no producers/offline from valid zero generation | 60 s |
| AC load | Acquisition evidence covering the VE.Bus/load measurements that feed systemcalc, not a generic systemcalc tick | 10 s |
| DC system power | Informational only: flag unavailable independently; do not make it a prerequisite for control | none |

No source stamp or verified acquisition heartbeat for these inputs is present in the repository's production wiring. The synthetic fixture can simulate a frozen path, but it does not prove a hardware driver exposes the needed evidence. Before enabling fallback, verify the signal with steady and changing loads, idle/night values, per-path freezes, and device disconnect/reconnect. Invalidate a sample on source ownership change until the replacement publishes a valid acquisition. Derive timeouts from documented or measured acquisition intervals and expected jitter.

### Read-only live verification shortlist (Claude)

These are candidates to inspect, not paths the controller assumes exist:

| Source | Candidate D-Bus paths or signals | What to verify |
|---|---|---|
| Grid CT | `com.victronenergy.grid.*`: `/Ac/L1/Power`, `/Ac/L1/Energy/Forward`, `/Ac/L1/Energy/Reverse`, `/Connected`, driver-specific `/UpdateIndex` if present; compare system `/Ac/Grid/L1/Power` | Identify the meter that actually feeds L1. Check whether any counter advances per acquisition, including at zero power. |
| SmartShunt 289 | `com.victronenergy.battery.*`: `/Dc/0/Voltage`, `/Dc/0/Current`, `/ConsumedAmphours`, `/Connected`, driver-specific `/UpdateIndex` if present | Check whether the candidate counter covers the voltage and Ah registers, including with near-zero current. |
| DC PV | `com.victronenergy.solarcharger.*`: `/Yield/Power`, `/Dc/0/Current`, `/Yield/User`, `/Connected`, driver-specific `/UpdateIndex` if present; compare system `/Dc/Pv/Power` | Identify each contributing charger and distinguish a healthy zero overnight from an unavailable producer. |
| AC load | `com.victronenergy.vebus.*`: `/Ac/Out/L1/P`, `/Ac/ActiveIn/L1/P`, `/Ac/ActiveIn/Connected`, `/Connected`, driver-specific `/UpdateIndex` if present; compare system `/Ac/Consumption/L1/Power` | Check which source paths and operating modes feed the aggregate. A VE.Bus heartbeat alone is not evidence for a separate CT. |

For each service, record its `/DeviceInstance`, `/Mgmt/Connection`, and unique D-Bus owner, and observe root `ItemsChanged` or per-path `PropertiesChanged`. Record which candidate paths actually exist, gaps during steady/idle conditions, and whether the driver documents that a counter represents a completed sample rather than just a changed value. Read-only inspection does not require writes, disconnects, or a deploy.

The Phase A cases affected are the stale CT export-charge case, stale battery voltage force-charge case, stale PV export-boost case, and the stale CT at midnight in `grid-edges.yml`. A CT fallback must not boost from a cached negative reading; a battery fallback must inhibit force charging; unavailable PV must not contribute to charging headroom. The midnight case must still advance tariff bookkeeping. Keep the existing `expected_fail` annotations until a production-equivalent signal and fallback are exercised; do not infer freshness from the simulator's test control API.

## Cadence independent of freshness

Store valid input values and Node-RED arrival times without evaluating the decision. The Victron nodes send periodic readings using their configured names as message topics; the unnamed voltage node uses its service and path display names. Controller 01 translates the six GX topics to the controller topics in the inventory above. Evaluate on a single 2 s inject, plus a grid delta strictly greater than 1 kW against the grid value used in the last decision. Manual discharge commands still act immediately; settings and history are picked up at the next decision. ESS/DVCC output rate limits are unchanged.

Accounting uses the previous decision's power snapshot over the interval between decisions; an intermediate change inside that interval can shift a small amount of energy compared with per-message accounting. A large grid step closes the interval immediately. The frozen replay now compares each recorded sample's final decision, any VE.Bus limit sent in that sample, and all tariff totals, rather than expecting an actuator output for every input in the sample. The expected files are unchanged.

A rate-limited write can take another 10 s after the decision. The synthetic import-step scenario has a 16 s real-time write ceiling, including 4 s of fixture/transport margin. This is not a hardware readback guarantee.

The code deploy intentionally stops on removals. **Owner manual topology apply is required**: remove the five input delays and six Tag nodes listed above and the four redundant 06:00/22:00 injects (`9217554766842bb8`, `7ec26167c492e338`, `8db34d06b6591d5e`, `3e6dccae307e4561`). Add `grid-cadence-inject-01` and `grid-override-topic-01`; the latter preserves the manual override link's topic normalization, not the physical CT path. Do not remove the two output rate limits.

NR1 measured 20.54% Node-RED CPU and at least 584 child spawns/h at d#207. The plan estimates roughly 5 decisions/s before cadence and 0.5/s plus significant CT steps after it. This is a decision-count estimate, not a CPU measurement; the existing process spawn paths are unaffected.
