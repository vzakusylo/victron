# Node-RED flows: simplification and CPU refactoring plan

Status: **plan only, nothing implemented.** Written 2026-11-21 from a static profile of `flows.json` on master
(`d#205`, 215 nodes on one tab). Implement after the PRs in flight (`hp-idle-utcp`, `testgx-faketime`) have merged,
one PR per item group below, each with unit tests and a Test GX run, measured before and after on the GX.
When a task starts, add its row to `BACKLOG.md` (tasks live there); this file holds the analysis and the design.

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

## 3. Refactoring plan (one PR each, in this order)

### NR1. Measure first (no behaviour change)
- Add a tiny "profiler" in the test fixture **and** a GX script (`scripts/gx-cpu.ps1` / `tools/gx/cpu.js`): Node-RED
  process CPU % and RSS over 10 min (`top -b -n …` / `/proc/<pid>/stat`), number of `node` / `sh` children spawned per
  hour (`/proc` sampling), event-loop lag (a 1 s inject that logs `Date.now()` drift).
- Record the baseline in this file (section 5). Every later PR reports before/after with the same script.

### NR2. Controller input path (F1, F2, F9) — biggest win
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

## 5. Measurements (fill in)

| When | d# | Node-RED CPU % (10-min avg) | RSS MB | spawns / h | event-loop lag p95 | Notes |
|---|---|---|---|---|---|---|
| baseline | 205 | | | | | NR1 |
