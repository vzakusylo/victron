# Test GX charging decision inventory

Source: `01 Battery + Grid Controller.js`, read without modification. The executable
fixtures are in [`charging.yml`](../tools/test-gx/scenarios/charging.yml).
Each fixture also runs against the actual function source in
[`test-gx-charging.test.js`](../tests/test-gx-charging.test.js).

## Inputs and outputs

| Input | Production path / context | Unit and scenario source |
|---|---|---|
| Battery voltage | battery instance 289, `/Dc/0/Voltage` | V; `/set batt_v` |
| Capacity deficit | battery instance 289, `/ConsumedAmphours` | Ah; `/set consumed_ah`; either sign becomes a nonnegative deficit |
| Grid CT | system instance 0, `/Ac/Grid/L1/Power` | signed W; `/set grid_w`; negative means export |
| AC load | system instance 0, `/Ac/Consumption/L1/Power` | W; `/set load_w`; controller floors negative readings at zero |
| PV charger | system instance 0, `/Dc/Pv/Power` | W; `/set pv_w`; DC system power is not PV generation |
| Protection | `flow.highVoltageSettings` | V, W, A and booleans; real Apply HV settings node |
| Constants | `flow.controllerConstantsOverrides` | snapshotted, cleared to production defaults, then restored |
| Solar summary / hourly forecast | `flow.solarForecastToday`, `flow.solarForecastAdjusted` | kWh / W; raw forecast HTTP fixture through the real fetch, JSON, parse, shade and store path |
| Manual discharge | controller `manual-discharge` topic | boolean command through a temporary inject |

| Controller output | Target | Assertion |
|---|---|---|
| 1: DVCC current | settings `/Settings/SystemSetup/MaxChargeCurrent` | Function rounds to 0.1 A and the Test GX emulator reads/writes the setting as a float. Scheduled maximum 25 A by default; force charge is not capped at that scheduled maximum |
| 2: ESS setpoint | settings `/Settings/CGwacs/AcPowerSetPoint` | W; relevant manual, season and adaptive-support cases also assert this |
| 3: AC input limit | VE.Bus instance 276, `/Ac/In/1/CurrentLimit` | A; summer day/night fixtures assert 9.5 / 13.5 A |
| 4-7 | notifications, energy records, dashboard trace, history command | Not charging actuators; file/exec/SMTP and accounting assertions remain separate work |

## Decisions and fixture names

Names below omit the common `charging ` prefix.

| Decision / condition | Expected outcome | YAML fixture |
|---|---|---|
| NIGHT deficit > 6 morning hours x 25 A | 25 A | `night deficit exceeds morning capacity` |
| NIGHT deficit equals morning capacity | 0 A | `night leaves a restorable deficit for morning` |
| MORNING deficit > 0.5 Ah | 25 A | `morning restores a deficit` |
| MORNING deficit at the deadband | 0 A | `morning respects the Ah deadband` |
| BMS reports positive instead of negative Ah | Same restoration current | `accepts a positive-sign BMS deficit` |
| Outside the restoration windows | 0 A | `stops outside restoration windows` |
| EVENING, before NIGHT takes precedence | 0 A | `evening does not restore capacity` |
| Summer day / night schedule | 25 A, 1950 / 2850 W, 9.5 / 13.5 A input limit | `summer morning keeps the current limit`; `summer night uses the night profile` |
| Valid positive forecast and V > 53.7 | Hold morning charging at 0 A; no-forecast positive is 25 A | `morning solar hold has an HTTP positive control` |
| V = 53.7, with forecast but remaining deficit | No solar-voltage hold: 25 A | `morning solar hold is off at 53.7 V` |
| Forecast Ah covers the deficit | Clamp remaining restoration Ah to zero: 0 A | `forecast can cover the entire morning deficit` |
| Forecast leaves NIGHT deficit within morning capacity | 25 -> 0 A | `night subtracts the HTTP forecast from its deficit` |
| Force enabled with positive requested power, limiter disabled | Force overrides OUTSIDE: 20 A at 50 V / 1000 W | `force mode overrides the outside window` |
| Force target exceeds scheduled maximum | 60 A at 50 V / 3000 W | `force current is not capped at scheduled 25 A` |
| Season setpoint cannot supply all force power | Proportionally reduced 23 A | `force current scales to the summer grid cap` |
| Force limiter start / full / hysteresis / release | 0, 19, 22, 25, 19, 0, 0 A | `force limiter starts tapers holds and releases` |
| Force enabled but requested power is zero | No force charging | `force mode needs a nonzero power request` |
| AC load consumes all season grid capacity | Available force power floors at zero | `force mode cannot charge above available grid power` |
| HV full voltage, no support | Grid 1000 / 4950 ratio: function 5.1 A, stored 5 A | `HV full voltage scales scheduled current` |
| HV start is exclusive | At 55.2 V no HV support cap: 25 A | `HV start threshold is exclusive` |
| HV disabled | No taper at 55.4 V: 25 A | `disabled HV protection does not taper` |
| High daytime AC load | 4850 / 4950 ratio: function 24.5 A, stored 24 A | `day high load reduces scheduled current proportionally` |
| Manual discharge overrides force; excessive load pauses it; low V stops it | Manual 0 A / 900 W; pause 18 A / 4500 W; resume; stop returns to force | `manual discharge overrides force mode and stops at low voltage` |
| Negative CT activates export absorption; boost clamps; sufficient import releases it | 0 -> 25 -> 0 A | `export guard raises and releases the DVCC limit` |
| Export absorption is below scheduled charging | Never lower scheduled 25 A | `export guard never lowers scheduled charging` |
| HV support active, held between thresholds, released at 55 V | Function 2.5, 2.5, 25 A; stored 2, 2, 25 A | `HV grid support also scales the current` |
| Restoration boost is active | Adaptive discharge must not suppress 25 A | `restoration blocks adaptive discharge support` |
| Adaptive support outside restoration | 0 A, grid cap 500 W | `adaptive support can discharge outside restoration` |
| Forecast age > 18 h, future timestamp, another day, nonfinite energy | Ignore forecast; restore 25 A | `rejects stale future previous-day and NaN forecast metadata` |
| Previous-day timestamp is still younger than 18 h | Same-day guard independently rejects it: 25 A | `rejects a previous-day forecast younger than 18 hours` |
| Valid zero-energy HTTP forecast | Do not suppress morning restoration: 25 A | `a valid zero forecast does not suppress restoration` |
| Invalid saved protection voltage ordering | Reject the file, fall back to defaults and turn force charging off: 0 -> 20 -> 0 A | `invalid protection file falls back to safe defaults` |

## Isolation and restoration

The HTTP source is `GET /forecast?date=YYYY-MM-DD&watts=N` on the emulator. It returns
24 raw hourly W values and forecast.solar metadata; it never contacts an upstream service.
Only the Test GX runtime HTTP-request node's URL is substituted. Its original URL and
temporary nodes are restored using revision-checked, nodes-only Admin API deployments.
The repository's production `flows.json` and numbered function sources are unchanged.

Normal forecasts are not injected. For cached-metadata fault cases only, the runner first
fetches a real HTTP fixture, then modifies the stored summary: Store solar prediction
always stamps `updatedAt` itself, so a raw HTTP response cannot supply an old/future cached
timestamp, and JSON cannot carry JavaScript NaN. This is the bounded fault-injection fallback.

The verified Node-RED context store is `default [module=memory]`. Node-RED is stopped
before each charging scenario, actuator outputs are reset to defaults and verified, inputs
are staged, then Node-RED starts. A prior DVCC value cannot satisfy the next scenario.
Every scenario restarts Node-RED, resetting node-private manual-discharge state, shade cache
and subflow rate-limit context; no runtime function restore hooks are installed. For a
localfilesystem store, a stopped-service baseline snapshot/restore would be required instead.
Each checked step also verifies the controller's received input context against the staged
values. An accepted `/set` cannot hide a stopped publication loop or stale palette input.

Before any settings injection, snapshots are written outside the repository, by default
under the system temporary directory's `test-gx-scenario-backups`. The runner restores and
checks the following resources in `finally`, including on assertion/setup failure:

- `/data/home/nodered/grid-control-config/heat-pump-automations.json` (bytes, mode, existence).
- `/data/home/nodered/grid-control-config/high-voltage-settings.json` (bytes, mode, existence).
- Node `hpa-fn-01` settings context.
- Main flow context keys `highVoltageSettings`, `controllerConstantsOverrides`,
  `solarForecastToday`, and `solarForecastAdjusted`, including originally absent keys.
- The runtime forecast HTTP URL and temporary helper nodes.

Before and after each case, all 49 production function-node definitions must hash-match
the checkout, including the two temperature functions. Four Tuya I/O adapters are compared
against the existing Test GX transformation. Production functions are never edited.
Cleanup attempts the remaining restorations even when one fails. A restoration or
temporary-flow leak is a hard failure, never `expected_fail`, and stops subsequent scenarios.
Snapshots remain outside the worktree for recovery/audit. Ordinary log/physics history is
not rolled back. The discarded volume's earlier backup is not used to seed the replacement.

## Uncovered

- **C-U1:** No supported per-input missing/JavaScript-NaN fixture is defined for the D-Bus
  controller inputs. `/fail` affects a service rather than one message. The startup-readiness
  guard is covered by `tests/controller.test.js`; exhaustive invalid inputs, dropout,
  cached-value age and palette reconnection belong to the edge scenarios.
- **C-U2:** File/exec effects, SMTP, accounting rollover and forecast rate-limit policy are
  not actuator assertions. Fetch/parse/shade/store execute, but these side effects and
  policies remain their own rows. Historical solar-log caps can influence forecast size;
  paired cases assert a positive stored forecast rather than assuming raw W equals kWh.
- **C-U3:** This is the charging inventory, not exhaustive tariff, adaptive-support tuning,
  dashboard or constants-form coverage. Existing focused tests cover constants ranges and
  tariff profiles; their remaining live decisions belong to those rows.
