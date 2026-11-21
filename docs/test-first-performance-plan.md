# Test first, then split and speed up: priority plan (decision 2026-11-21)

## Decision (owner, 2026-11-21)

1. **Priority of the controlled systems: grid control → heating → boiler (DHW).** Everything else (pages, mail,
   history, sensors, MCP / UTCP) comes after them and must never delay or break them.
2. **Cover first, change later.** Before any split or performance change of a module, its decisions are covered by
   Test GX scenarios (and unit tests) that are green on master. A refactoring PR names the scenarios that cover the
   lines it changes; an uncovered decision gets a scenario first.
3. **Then the safe performance work**: split heavy, slow, CPU- and memory-consuming modules without changing what they
   do (proven by the same tests), measured before and after on the GX.

Tasks are tracked in `BACKLOG.md` (section 3, "Priority plan: test first, then split"); the grid refactoring design is
`docs/node-red-refactoring-plan.md`.

## Phase A: Test GX coverage (in this order)

### A1. Grid control
| ID | Task |
|---|---|
| G0 | Gate: the charging scenarios (`charging`, `charging-force`, `-forecast`, `-guards`, `-support`) green twice on master; replay test `tests/grid-replay.test.js` from recorded, anonymized inputs (winter night, summer day with PV, force-charge hour, HV event) |
| TG1 | `grid-reaction.yml`: grid import step +3 kW → new setpoint (timing measured); export → export guard; back to normal |
| TG2 | `grid-stale-inputs.yml`: grid CT / battery voltage / PV stop updating → today's behaviour, `expected_fail` where wrong (fixed in G2) |
| TG3 | Hour budget and tariff peaks: hour roll-over, day / month peak, tier change (unit replay + one scenario) |
| TGX5 | Edges: midnight, DST, month change, tariff tier change, sensor failures (Test GX plan item 5) |
| TGX6 | BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`, mail stub (Test GX plan item 6) |

### A2. Heating
| ID | Task |
|---|---|
| TH1 | Warm-up (+N °C for T h): start, end, cancel, curve back to the owner's |
| TH2 | Band option: DP 121 written as a whole number (d#206 fix), owner hysteresis restored when the controller is Off / Test |
| TH3 | Stuck-supply kick (F40-09): Silent → Smart for kickSec → Silent; no kick in DHW / defrost |
| TH4 | Defrost start / end rules (F40-03 / 04) against a recorded sequence (test half of H8) |
| TH5 | HP-SETTINGS-1, fixed in d#207: reject out-of-range saved heating curves and guard pump writes; regression coverage in `tests/heat-automation.test.js` |

### A3. Boiler (DHW)
| ID | Task |
|---|---|
| TGX3 | DHW schedule, shower prep, forced-cycle stops, missing data, Tuya offline (Test GX plan item 3) |
| TB1 | DHW compressor protection (F40-07): Silent at the cold limit, supply cap, Hz / current steps |
| TB2 | DHW and defrost together: a defrost during a cycle, "DHW after defrost", minimum gap after a cycle |
| TGX7 | Tuya cloud / local stub where the logic reads it (Test GX plan item 7) |

## Phase B: safe split and performance (each item only after Phase A for the part it touches)

| ID | Task | Needs |
|---|---|---|
| NR1 | Measure on the GX: Node-RED CPU %, RSS, process spawns / h, event-loop lag (baseline) | — |
| G1–G6 | Grid controller: pure control loop + bookkeeping, 2 s cadence + immediate run on a grid step, read-back feedback, isolation + heartbeat, dashboard block (design: `docs/node-red-refactoring-plan.md`) | A1, NR1 |
| NR3 | Process spawns: BMS watchdog `sh` every 30 s, cloud `node` every 2 min, page refreshes only with a viewer | A1 (TGX6) |
| NR4 | Heat pump state and the 65 KB page: one run per event, at most every 5 s, page only on change and with a viewer | A2, A3 |
| NR5 | Automations tick: one context write per tick, no large `JSON.stringify` per tick | A2, A3 |
| NR8 | Memory: `storeOutMessages` on 20 templates (65 KB heat pump page), history builders reading whole day files through `sh`; measure RSS and trim | NR1 |
| NR9 | Split the next heavy nodes into `lib/` without runtime change: `26 Manage backup dashboard` (775 lines), `34 Heat pump state` (586), `29 Build device status` (523) | tests of that node |
| T1b | Test GX speed, rest: Docker image cache; check the new per-file times after #103 | — |

## Process tasks

| ID | Task |
|---|---|
| P-D1 | Automatic deploy cannot pass `allow_live_only_lines`, so every PR that rewrites lines stops it and needs a manual apply. Allow it automatically when the GX equals the commit it was last deployed from (no hand edits possible), with a test |
| P-R1 | After-the-fact review of #103 (merged before review): no weakened expectations, tick gate only in the fixture, before / after times |

## Order

A1 → A2 → A3 (TH5 as its own bug-fix PR) → NR1 → G1 … G6 → NR3 / NR4 / NR5 / NR8 / NR9 → T1b.
P-D1 and P-R1 can run at any time. One PR per task, Herdr worker per PR (`gpt-6.2-sol`, `--allow-all`), auto-merge.
