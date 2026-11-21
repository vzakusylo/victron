# Node-RED flows: simplification and CPU refactoring plan

Status: **plan only, nothing implemented.** Written 2026-11-21 from a static profile of `flows.json` on master
(`d#205`, 215 nodes on one tab). Implement after the PRs in flight (`hp-idle-utcp`, `testgx-faketime`) have merged,
one PR per item group below, each with unit tests and a Test GX run, measured before and after on the GX.
When a task starts, add its row to `BACKLOG.md` (tasks live there); this file holds the analysis and the design.

**Priority (owner, 2026-11-21): grid control first.** The energy controller (grid setpoint, DVCC charge current,
VE.Bus input limit, HV protection, export guard, tariff hour budget) must be the most reliable part of the GX and react
quickly to grid changes, with clear feedback that its writes took effect. Everything else (heat pump, pages, mail,
history, sensors) is less important and must never delay or break it. Section 3a turns this into the first work items
(G1–G6) and section 4a into the test plan; the CPU items NR2–NR7 follow and are subordinate to it.

## 1. What runs on the GX today (static profile)

| Kind | Count | Notes |
|---|---|---|
| function | 50 | two very large: `Heat pump automations` (1,919 lines incl. lib, 7 outputs), `Battery + Grid Controller` (1,399 lines, 7 outputs, **16 incoming wires**) |
| inject | 29 | 18 repeating / cron (table below) |
| exec | 25 | `sh -c …` or `node tools/…`: every exec **spawns a process** (expensive on the Cerbo's ARM CPU) |
| ui_template | 23 | Heat pump page 65 KB, history 24 KB, most with `storeOutMessages: true` |
| delay | 9 | 5 fixed 10 s delays on the controller inputs, 3 rate limits on its outputs, 1 in the forecast subflow |
| change | 10 | 6 "Tag …" nodes on controller inputs, 4 "topic = …" on Tuya devices |
| file | 14 | appends (logs, CSV, recorder) |
| victron-input-* | 7 | `onlyChanges: false` on all |
| tuya-smart-device | 4 | `event-both`, both outputs wired to the same node |

Repeating timers (per hour) and how much they start:

| Inject | Every | Runs / h | Starts |
|---|---|---|---|
| Automations tick | 10 s | 360 | `Heat pump automations` (1.9k lines, ~74 `context.set`, 12 `JSON.stringify` per run) |
| Poll heat pump (GET) | 30 s | 120 | 4 Tuya GETs → each answer runs `Heat pump state` (586 lines) → pushes the 65 KB page, data page, alerts |
| BMS watchdog | 30 s | 120 | `exec sh -c` (process spawn) |
| Heat pump log tick | 30 s | 120 | recorder append |
| Compressor resource | 30 s | 120 | function + file |
| Alerts tick | 60 s | 60 | function |
| Cloud sensors poll | 2 min | 30 | `exec node tools/tuya-cloud-status.js` (**a new Node.js process** every 2 min) although the battery sensors moved to local in d#151 |
| Devices refresh | 2 min | 30 | `exec sh -c` + model, also when nobody looks at the page |
| Air quality refresh | 2 min | 30 | `exec sh -c`, same |
| Local sensors listener | 10 min | 6 | `exec node tools/tuya-local-sensors.js 630` (long-running listener) |
| Solar forecast, archive mail, payback | 15 min–1 h | ≤ 4 | fine |
| DAY / NIGHT 06:00 / 22:00 ×2 | cron | — | 4 injects, two pairs that start the same chain |

Event-driven: 6 Victron D-Bus inputs feed `Battery + Grid Controller`, each `onlyChanges: false`; D-Bus values update
about every second, so the 1.4k-line controller (and its 30 downstream nodes) runs several times per second.

## 2. Findings (ranked by CPU impact)

| # | Finding | Why it costs | Evidence |
|---|---|---|---|
| F1 | **Controller runs on every D-Bus update** of 6 inputs (`onlyChanges: false`) | ~5 runs/s of a 1.4k-line function: the largest steady CPU user | 16 incoming wires on `Battery + Grid Controller`; inputs have no rate limit |
| F2 | **Fixed 10 s `delay` on 5 controller inputs** (not rate limits) | every message waits in its own timer (≈50 live timers), adds 10 s latency to the control loop, does not reduce runs; PV power has none (inconsistent) | delay nodes `fd95…`, `e84b…`, `87b4…`, `ec03…`, `dc3b…` (`pauseType: delay`, 10 s) |
| F3 | **Process spawns on timers**: BMS watchdog 30 s (`sh`), cloud sensors 2 min (`node`), devices 2 min, air quality 2 min (`sh`) | `fork+exec` of `sh` / `node` on the Cerbo costs far more than the work; a `node` start is ~0.5–1 s CPU and ~30–40 MB | exec list; cloud chain still active after d#151 |
| F4 | **Heat pump state + 65 KB page push on every Tuya answer** | 4 devices × poll 30 s + events: `Heat pump state` and three UI pushes run ~10×/min whether or not a browser is open; `storeOutMessages` keeps the last 65 KB message in memory per template | poll chain; template sizes |
| F5 | **Tuya nodes: both outputs wired to the same change node** | each data event may reach `Heat pump state` twice (data + state output) → double work; needs a check of what output 2 carries | `wires: [[topic-hp],[topic-hp]]` on all 4 |
| F6 | **Automations tick writes context ~74 times per run** | with a persistent context store each `context.set` marks the store dirty and serializes large objects; 12 `JSON.stringify` per tick | static count in 40 |
| F7 | Dead / duplicate nodes | an unused D-Bus subscription and duplicate cron injects cost a little and confuse readers | `victron-input-battery /Dc/0/Current` has no wires; DAY/NIGHT injects come in two identical pairs |
| F8 | Page refresh timers run without viewers | Devices / Air quality / Payback recompute for nobody | 2-min injects, no `ui_control` gate |
| F9 | Many single-purpose "Tag …" change nodes | 6 nodes only to set `msg.topic`; the victron input can carry the topic, or the controller can key on `msg.path` | change nodes |

## 3a. Grid control: reliability and feedback first (G1–G6, before NR2–NR7)

Today `01 Battery + Grid Controller.js` (1,399 lines embedded; `lib/grid/constants.js` + `lib/grid/helpers.js` since
#93) mixes the control loop with energy bookkeeping, tariff statistics, logging, trace and dashboard status in one
node that runs on every D-Bus update. A slow or failing part (file append, statistics, a page) shares the run with the
grid writes, and nothing checks that a written setpoint was applied.

Target shape (one control loop, everything else downstream of it):

```
Victron D-Bus inputs ──► Grid inputs (store + staleness) ──► Grid control loop (2 s cadence) ──► ESS setpoint / DVCC / VE.Bus limit
                                                                    │                                   (rate-limited writes)
                                                                    ├──► Feedback check (read-back vs written, alarms)
                                                                    └──► (async, best effort) energy bookkeeping, tariff
                                                                         stats, log / CSV, trace, dashboard status
```

### G1. Split the controller into control and bookkeeping (no behaviour change)
- Move the pure control decision into `lib/grid/control.js`: input = latest inputs + settings + small state (hour
  budget so far, export-guard state, force-charge limiter), output = setpoint W, charge current A, grid current
  limit A, flags + reasons. Pure, no `context`, no I/O: directly unit-testable.
- Keep the energy / tariff bookkeeping (`advanceHourBudget`, day / month peaks, tier view), the hourly log, the CSV
  append and the dashboard status in a **second function node** "Grid bookkeeping", fed by the control node's output
  message. A failure or slow run there cannot delay the next control decision.
- First PR is a pure move with a replay test proving identical outputs (see 4a); `flows.json` then has two nodes
  instead of one; `d#` bump, normal deploy.

### G2. Inputs and cadence (was NR2; F1, F2, F9)
- As NR2 below: inputs store values (with timestamp) only; delete the 5 fixed 10 s delays and the "Tag" change nodes;
  the control loop runs on a 2 s inject (keep last), plus **immediately** on a grid-import step above a threshold
  (e.g. |ΔP| > 1 kW against the last decision), so a sudden load is answered in < 2 s instead of 10 s + delay.
- Each input has a max age (e.g. grid CT 10 s, battery V 30 s, PV 60 s). A stale critical input switches the loop to
  a **safe mode** (setpoint to the season default / no forced charge / export guard on) and raises a status flag.

### G3. Feedback: did the write take effect?
- After each write (ESS setpoint, DVCC max charge current, VE.Bus input limit) read the value back from D-Bus
  (victron input on the same path) and compare within a tolerance and a deadline (e.g. 15 s).
- Mismatch → retry once (respecting the rate limit), then an alarm: Automation-style log line, dashboard status
  "grid write not applied: <path> wanted X got Y", GX notification / mail through the existing alert path, a counter
  per day. The control loop keeps running.
- Also watch the outcome: grid import vs the setpoint (10-s average); a sustained miss (e.g. > 500 W for 2 min while
  the battery can deliver) is reported as "grid not following setpoint" with the likely reason (battery limit, VE.Bus
  state, DVCC limit, HV protection).

### G4. Isolation and priority on the GX
- The grid loop has no `exec`, no file I/O, no large `JSON.stringify` in its path; bookkeeping, logs and pages are
  downstream and best effort.
- Throttle the heavy non-grid work (NR3 process spawns, NR4 heat pump page, NR5 automations writes) so the event loop
  lag measured in NR1 stays low (target p95 < 100 ms); the grid loop's real cadence is measured and reported in the
  dashboard ("control loop: last run 1.2 s ago, p95 interval 2.1 s").
- A heartbeat: if the grid loop has not run for 10 s, raise an alarm (dashboard + mail); the existing BMS watchdog
  stays independent.

### G5. Dashboard feedback
- One "Grid control" status block: current decision and reason, last write per output with read-back state, input
  ages, safe-mode flag, alarm counters, loop cadence. Fed from the control loop's output (small message, every 2 s,
  only when changed).

### G6. Then the rest of `01`
- After G1–G5, the remaining parts of `01` (energy history request, trace, hourly log message) move into the
  bookkeeping node or `lib/grid/*.js`; `01` keeps only the wiring of the control loop.

## 3. Refactoring plan (one PR each, in this order: NR1, G1–G6, then NR3–NR7)

### NR1. Measure first (no behaviour change)
- Add a tiny "profiler" in the test fixture **and** a GX script (`scripts/gx-cpu.ps1` / `tools/gx/cpu.js`): Node-RED
  process CPU % and RSS over 10 min (`top -b -n …` / `/proc/<pid>/stat`), number of `node` / `sh` children spawned per
  hour (`/proc` sampling), event-loop lag (a 1 s inject that logs `Date.now()` drift).
- Record the baseline in this file (section 5). Every later PR reports before/after with the same script.

### NR2. Controller input path (F1, F2, F9) — biggest win (done as part of G2)
- Victron inputs: `onlyChanges: true` where a repeat value carries no information (power and voltage are re-published
  only on change anyway; check consumed Ah). Give each input its topic directly (or key on `msg.path`), delete the 6
  "Tag …" change nodes and the 5 fixed 10 s delays.
- The controller stores each input in context (cheap) and **computes on a fixed cadence**: one inject every 2 s (or a
  `trigger`/rate-limit "1 msg / 2 s, keep last") instead of per input message. Outputs keep their existing 10 s rate
  limits (`Delay 10s`, drop) so the MultiPlus / DVCC write rate does not change.
- Safety: export guard (15 s interval), HV protection and the hour-budget roll-over must see the same values; keep the
  input staleness checks. Unit tests: same outputs for the same input sequence (replay a recorded hour), cadence
  independent of input rate. Test GX: all `charging.yml` scenarios unchanged and green.
- Expected: controller runs from ~5/s to 0.5/s (−90 % on the largest CPU user), 10 s less control latency.

### NR3. Process spawns (F3, F8)
- BMS watchdog: read the D-Bus values it needs through victron input nodes (or one long-lived `exec` in spawn mode
  that loops in shell) instead of `sh -c` every 30 s; or every 60 s if the read must stay a script.
- Cloud sensors: remove the 2-min `node tools/tuya-cloud-status.js` chain if nothing uses cloud values since d#151
  (check `Heat pump state` / Temperatures page / sensor history); otherwise run it every 15 min.
- Devices / Air quality / Payback refresh: only while a dashboard client is connected (`ui_control` connect /
  disconnect gate) and once on page open.
- Expected: from ~210 process spawns / h to < 30.

### NR4. Heat pump state and page pushes (F4, F5)
- Check what the Tuya node's second output carries (status / error). Wire it only where needed (a connection-state
  branch), so a data event runs `Heat pump state` once.
- Coalesce: `Heat pump state` builds once per 5 s at most (keep last), and the 65 KB page payload is sent only when it
  changed (hash of the payload, RBE) and a client is connected. Split the page payload: static parts (curve tables,
  history) on change only, live values every 5 s.
- Keep `storeOutMessages` only where a late-joining browser needs the last message; send a small "live" message
  separately from the large one.

### NR5. Automations tick write load (F6)
- Batch context writes: one working object per tick (`const s = ctx(...)`), mutate it, one `context.set` at the end
  of the tick; avoid `JSON.stringify` of large objects on every tick (only on change, for the settings file and the
  view). Confirm which context store the GX uses (memory vs localfilesystem) and its flush interval first; if
  persistent, keep only the keys that must survive a restart in it.
- Unit tests stay green (they use the harness context); add one test that counts `context.set` calls per tick.

### NR6. Clean-up (F7, F9)
- Delete the unwired `/Dc/0/Current` input, merge the DAY/NIGHT cron pairs into one inject each, remove "Tag" change
  nodes left after NR2, group leftovers. `flows.js check` gains a rule: no node without wires in and out (except config,
  ui, comment, link, catch / status).

### NR7. Optional, later
- Split the single 215-node tab into tabs per area (energy, heat pump, pages, maintenance) — readability only.
- Move the remaining big functions (`Manage backup dashboard` 775, `Heat pump state` 586, `Build device status` 523)
  into `lib/` like 40 / 01 (`// #include`), no runtime change.

## 4. Risks and rules
- NR2 changes the timing of the energy controller: it is live control of the inverter, grid setpoint and DVCC. It
  needs the replay test, all charging scenarios, a dry run, and a watched first hour after the deploy.
- Every item bumps `d#` and deploys through the normal path (Test GX green on master → automatic deploy). No hand
  edits on the GX.
- Do the PRs one at a time on top of each other's merges: NR2 and NR5 both touch large nodes, NR4 touches the
  heat pump chain that `hp-idle-utcp` changes now.

## 4a. Test plan for the refactoring (unit + Test GX, written before each change)

Rule: every G / NR PR adds its tests **before** it changes behaviour; a pure move (G1) must keep every existing test
green and add a replay test that would catch a difference.

### Unit (node:test, `tests/`)
| Test | Covers |
|---|---|
| **Replay test** `tests/grid-replay.test.js`: feed recorded input sequences (one winter night, one summer day with PV, one force-charge hour, one HV event; recorded from the GX logs, anonymized, stored under `tests/fixtures/grid/`) through the old node and the new control + bookkeeping pair | identical setpoint / current / limit outputs and identical hour budget, day / month peaks (G1, G2) |
| `lib/grid/control.js` decision table | every branch: night / morning / evening windows, season, restoration deficit, forecast cover, force charge + limiter, HV taper, grid support modes, export guard raise / release, manual discharge stop, day high-load reduction, clamps (G1) |
| Cadence | control output independent of the input message rate (1 msg/s vs 10 msg/s), immediate run on a large grid step, no run on unchanged inputs inside the cadence (G2) |
| Staleness / safe mode | each critical input stale → safe mode with its reason; fresh again → normal (G2) |
| Feedback | read-back equal → ok; mismatch → one retry then alarm; deadline; "grid not following setpoint" detection and reason (G3) |
| Heartbeat | loop silent 10 s → alarm once, cleared on the next run (G4) |
| Bookkeeping isolation | a throwing / slow bookkeeping input does not change the control output (G1, G4) |
| Process / write budgets | counts of `exec` starts and `context.set` per tick stay under a set budget (NR3, NR5) |

### Test GX (`tools/test-gx/scenarios/`, one new file per area, added to the `files` matrix)
| File | Scenarios |
|---|---|
| `charging.yml` (existing, 33) | must stay green unchanged through G1–G6; any scenario that needs a change is a behaviour change and is reviewed as such |
| `grid-feedback.yml` (new) | write not applied (emulator ignores the ESS setpoint) → retry → alarm; DVCC limit read-back mismatch; grid import does not follow the setpoint for 2 min → report with reason |
| `grid-reaction.yml` (new) | grid import step +3 kW → new setpoint within 2 s (+ the output rate limit); export (negative grid) → export guard reacts; return to normal |
| `grid-stale-inputs.yml` (new) | grid CT stops updating → safe mode within its max age; battery voltage missing → safe mode; inputs back → normal |
| `grid-isolation.yml` (new) | heat pump page / automations / mail busy (emulated load, failing exec) → grid loop cadence and outputs unchanged |
| `grid-heartbeat.yml` (new) | control loop disabled → heartbeat alarm |

Live checks after each grid PR (owner, first hour): dashboard "Grid control" block shows read-back ok and loop
cadence ~2 s; no "not applied" alarms; grid import follows the setpoint; NR1 CPU / lag table filled in.

## 5. Measurements (fill in)

| When | d# | Node-RED CPU % (10-min avg) | RSS MB | spawns / h | event-loop lag p95 | Notes |
|---|---|---|---|---|---|---|
| baseline | 205 | | | | | NR1 |
