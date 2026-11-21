# Backlog: all tasks, plans and progress in one place

**The one file for tasks.** Every task, plan, open PR, deploy state, test plan (unit, Test GX, e2e) and progress note
lives here. There are no other task or plan files (the former `docs/e2e-backlog.md` is section 7). Design documents
(`docs/*.md`) explain how things work; they do not track tasks. `camera-ai/PLAN.md` is a separate project.
Updated 2026-11-21 (master `8bf1d37`, flows `d#204`, GX `d#204`).

**Rules (owner, Claude, Copilot):**
1. A new task goes into this file first (an ID, one line, notes), before any branch is made.
2. Starting: set its state to "in progress" with the branch (and the PR once open).
3. Finishing: move it to section 6 Done with the PR number and `d#`, in the same PR as the work.
4. Plans and findings for a task are written in its row (or a sub-section here), not in a separate file.
5. Instruction files for Copilot (scratch) are copies only; this file is the truth.

## How we work

- Claude plans, controls and reviews; Copilot implements (code, conflict fixes, pushes, PRs). See
  [docs/agent-workflow.md](docs/agent-workflow.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md).
- One Copilot per branch / worktree, never two on the same folder.
- Every change on its own branch from a fresh `master`, PR into `master`, auto-merge (`gh pr merge N --auto --merge`).
  `master` requires `check`, `tests`, `secret-files` and `review`. Several PRs may be open at once.
- Production `flows.json` and `NN *.js` stay in sync (`node tools/flows.js sync`, `check`); every flow change bumps `d#`.
  When `master` moves, merge it into the branch, rebuild `flows.json` with `sync` and bump again.
- Unit tests for every decision; e2e cases go to section 7 of this file.
- `master` also requires `scenarios` (Test GX). A green Test GX run on a master push deploys that commit to the live GX
  automatically (env `victron-gx-auto`); manual deploys go through **Actions → Deploy GX code** (dry run, then apply),
  each approved by the owner.

## 1. Open pull requests

| PR | Branch | Task | State / next step |
|---|---|---|---|
| #89 | `testgx-p1p2` | Test GX scenarios for P1 (curve follow) and P2 (off-curve monitor) | Open, auto-merge; Test GX on the PR decides. |

## 2. Deploy

| Item | State |
|---|---|
| GX version | `d#204` (`8bf1d37`), applied 2026-11-21 by run 44891670764; Test GX on `8bf1d37` green (run 44889488209) |
| master | `d#204`: #79–#80 simpler heating (d#201/203), #86 P1/P2 (d#204), #83/#87 auto-deploy + parallel Test GX |
| Next | Automatic: every green Test GX on a master push deploys it. |
| After deploy | Watch the Automation log for the first "step up blocked" / "not following the curve" (P1/P2). Count compressor starts per DHW cycle (startGap 7 vs gap 5, PR #62 review). Check `command -v flock` on the GX (P5g). |

## 3. Production backlog

### Priority plan: test first, then split (decision 2026-11-21, [docs/test-first-performance-plan.md](docs/test-first-performance-plan.md))

Priority: **grid control → heating → boiler**. A module is covered by green Test GX scenarios on master before it is
split or tuned; then safe splits and performance work, measured on the GX. Order: A1 → A2 → A3 → NR1 → G1…G6 →
NR3 / NR4 / NR5 / NR8 / NR9 → T1b (P-D1, P-R1 any time). The NR / G rows are in the next table.

| ID | Phase | Task | State |
|---|---|---|---|
| TGX5 | A1 grid | Edges: midnight, DST, month change, tariff tier change, sensor failures (Test GX plan 5) | open, raised |
| TGX6 | A1 grid | BMS watchdog scenarios (Test GX plan 6) | open, raised |
| TGX3 | A3 boiler | DHW schedule, shower prep, forced-cycle stops, missing data, Tuya offline (Test GX plan 3) | open, raised |
| TB1 | A3 boiler | DHW compressor protection (F40-07): cold limit Silent, supply cap, Hz / current steps | open |
| TB2 | A3 boiler | DHW with defrost: defrost during a cycle, DHW after defrost, minimum gap | open |
| TGX7 | A3 boiler | Tuya cloud / local stub (Test GX plan 7) | open |
| NR8 | B perf | Memory: `storeOutMessages` on 20 templates (65 KB heat pump page), day-file reads via `sh`; measure RSS, trim | open |
| NR9 | B perf | Split next heavy nodes into `lib/` (no runtime change): `26` backup 775 lines, `34` heat pump state 586, `29` device status 523 | open |
| T1b | B perf | Test GX speed, rest: Docker image cache; check per-file times after #103 | open |
| P-D1 | process | Auto-deploy may use `allow_live_only_lines` when the GX equals its last deployed commit (no hand edits); with a test | open |
| P-R1 | process | After-the-fact review of #103 (merged before review) | open |

| ID | Task | Size (days) | Notes |
|---|---|---|---|
| T1 | Unit-test coverage of the control logic | 1–2 | Per function node: list every decision (input → expected write), add missing tests, list uncovered decisions. After the open PRs merge. |
| B6 | Temperatures page: all sensors, day-by-day paging, motion sensor | 0–1 | Check first: a temperatures page with motion exists since `a4af86d`. |
| B8 | Battery round-trip efficiency | 0.5–1 | |
| B4 | Automation log page: main system events + audit of page usage | 1–1.5 | |
| B5 | Docs: the victron-gx MCP connector (what, how to create, how it works, how to use) | 0.5 | |
| B3 | Data Analytics: train on history to predict solar generation | 2+ | |
| C1 | Move private hosts / IDs out of `flows.json` and `NN *.js` | 1 | Only if the repository becomes public; needs a `d#` deploy. |

### Process and repo (review 2026-11-21)

| ID | Task | State | Notes |
|---|---|---|---|
| R1 | `CLAUDE.md` + `AGENTS.md`, `.claude/settings.json` (allowed commands, `flows.json` edit deny), `flows-check` hook, root cleanup (`config/`, `docs/archive/`) | Done: #91 | Phase 1, docs / config only. |
| R2 | Agent hand-off: owner decides: Claude implements in worktrees (Copilot optional reviewer), or Copilot only in one-shot mode (`copilot -p` from a brief, output to a log) | Done: #101, #102 | Decided: Copilot runs as Herdr workers (send / read / wait), `--allow-all --model gpt-6.2-sol`. |
| R3 | Real review gate for live control: CODEOWNERS + 1 approval on PRs touching `NN *`, `flows.json`, `.github/workflows`, or the review bot fails on High findings | Done: #92 | #80 / #81 / #86 merged before a human / Claude review. Needs the owner's GitHub settings. |
| R4 | Project skills: `deploy-gx` (dry run, compare, apply), `test-gx-local`, `ship-pr` (sync, bump, test, PR, auto-merge) | Done: #92 | Phase 2. |
| R5 | Split `40 Heat pump automations.js` (1.9k lines) and `01 Battery + Grid Controller.js` (1.2k): pure decisions into `lib/*.js` loaded by the node | Done: #93 | Build-time `#include`; 40 → 725 lines + 6 lib files, 01 → 900 + 2; flows.json byte-identical. |
| R6 | Merge or retire the `*-handoff*.md` docs (`docs/gx-handoff.md` is quoted by tests and scripts: update those first) | open | |

### Node-RED refactoring, grid control first (plan: [docs/node-red-refactoring-plan.md](docs/node-red-refactoring-plan.md))

Order: NR1 → G0 → G1 … G6 → NR3 … NR7. One PR each, unit tests and Test GX before each change, measured before and
after on the GX (NR1 table). Grid control (energy controller) is the top priority and must never be delayed by the rest.

| ID | Task | Depends on | State | Notes |
|---|---|---|---|---|
| NR1 | Measure Node-RED on the GX: CPU %, RSS, process spawns / h, event-loop lag (script + baseline table in the plan, section 5) | — | open | No behaviour change. |
| G0 | Test GX gate before grid refactoring: existing 33 charging scenarios green twice on master; replay test `tests/grid-replay.test.js` from synthetic inputs; new `grid-reaction.yml`, `grid-stale-inputs.yml` describing today's behaviour | NR1 | in progress: grid-testgx-a1 / #106 | Wait for two consecutive green charging runs on master. Coverage map: plan section 3a G0. |
| G1 | Split `01` into a pure control loop (`lib/grid/control.js`) and a separate "Grid bookkeeping" node (budgets, peaks, tariff, logs, CSV, status) | G0 | open | Pure move, proven by the replay test; d# bump. |
| G2 | Grid inputs and cadence: inputs only store values with age; loop every 2 s + immediate run on a grid step > 1 kW; remove the 5 fixed 10 s delays and "Tag" change nodes; safe mode on a stale critical input | G1 | open | Replaces NR2. Expected −90 % controller runs, −10 s control latency. |
| G3 | Write feedback: read back ESS setpoint / DVCC / VE.Bus limit, retry once, alarm (dashboard, log, mail); "grid not following setpoint" with reason | G2 | open | With `grid-feedback.yml`. |
| G4 | Isolation and heartbeat: no exec / file I/O in the grid path; event-loop lag p95 < 100 ms; alarm if the loop is silent 10 s | G3 | open | With `grid-isolation.yml`, `grid-heartbeat.yml`. |
| G5 | Dashboard "Grid control" block: decision + reason, writes with read-back, input ages, safe mode, alarms, loop cadence | G3 | open | |
| G6 | Move the rest of `01` into bookkeeping / `lib/grid/*`; `01` keeps only the loop wiring | G5 | open | Midnight / DST / month-change scenarios (Test GX plan item 5) before this. |
| NR3 | Process spawns: BMS watchdog without `sh` every 30 s; cloud sensors `node` every 2 min removed or 15 min; page refreshes only while a page is open | G4 | open | ~210 → < 30 spawns / h. |
| NR4 | Heat pump state + 65 KB page: one run per event (Tuya second output), at most every 5 s, page only on change and with a viewer | G4 | open | Touches the heat pump chain (#97 merged). |
| NR5 | Automations tick: one `context.set` per tick, no large `JSON.stringify` per tick; check the context store | G4 | open | |
| NR6 | Clean-up: unwired `/Dc/0/Current` input, duplicate 06:00 / 22:00 injects, left-over "Tag" nodes; `check` rule against unwired nodes | NR3 | open | |
| NR7 | Optional: tabs per area; more big nodes into `lib/` (backup 775, heat pump state 586, device status 523 lines) | NR6 | open | |

### Heat pump batch H0–H12 (one PR, branch `heat-pump-ux-batch`, not started; P1 / P2 shipped in d#204)

| ID | Task | Notes |
|---|---|---|
| H16 | Heat pump idle follow-ups (found by H0) | Not started. (1) The boiler controller retries "mode Silent" about every minute while the pump keeps reporting smart (37 unconfirmed writes on 2026-11-21): back off after ~3 failed tries. (2) The stored owner curve may be polluted (P23 27 vs 33 seen once): check the curve monitor. (3) A forced boiler cycle stopped after 7 min with "forced cycle safety stop pending". (4) Most idle time (484 of 685 min in Nov 14-21) is the pump's 3 min restart protection after a defrost, then waiting below its own restart level (set - DP 121); lowering DP 121 or raising the point would shorten it, owner decision. |
| H1 | Heating curve "now" marker shows values | Curve target now, reported heating set (DP 125), supply now. |
| H3 | Temperatures page "All sensor temperatures": rooms only | Same single room list as `50 Devices model.js` / `tools/sensor-history.js`. |
| H4 | Devices page: × hides a device block, "Hidden devices" list with + to bring it back | Saved in the settings file. |
| H6 | Heating curve chart: low and high band lines | Point − `bandDown` and point + `bandUp` along the curve. |
| H8 | Review defrost start / end detection | Check the rules (DP 116 / 115, bypass, `recentDefrost`, `defRecovering`, quiet period) against the recorded defrosts; fix wrong edges with tests from a real sequence. |
| H9 | Review that all data is stored | Every value the dashboard / controller uses must be in history (36 / 57 / 58); add what is missing, report gaps. |
| H10 | History by day: week navigation, at most 14 day chips | `39 Heat pump history page.html` / `38`. |
## 4. Review follow-ups (deferred Low / Nit)

| From | Item |
|---|---|
| #61 | Hot water drawn while DHW is heating is not counted as a draw (by design; document if needed). |
| #69 | Worst-case repacks (up to 5 per set) against the 600 s exec timeout. |
| #69 | An interrupted mail send clears the backups list on the card (trap exits without `list_backups`). |
| #69 | A signal right after `send-mail.js` succeeded is reported as a failure; an auto send could mail twice. |
| #69 | Nit: JS comment shows the literal `' + DROP_RETRIES + '`; test nit at `tests/backup-tools.test.js:90`. |
| P5g | No shell test for the short-estimate path of `drop_until_fits` (needs ~18 MiB synthetic data). |
| #65 | Low: holds (DHW cycle, pump off) delay writing / removing the warm-up, as with the boost. |
| #66 | Note: a hand edit of DP 121 while the band is on is overwritten by the band. |
| #67 | Cosmetic: inline the `staleOutdoorCycle` alias; `P23_START = 15` is a deliberate hard pin. |
| #68 | Nit: `startGap` is the only DHW input with HTML `min` / `max`. |
| #55 | 2f charging follow-ups: CHG-1 `MaxChargeCurrent` integer type check; restore race in `scenario-controller.js` `restore()`. Check whether #72 / #74 covered them. |
| #56 | 9f UI follow-ups: page inventory stores the deploy stamp; expected errors bound to `127.0.0.1:1881`. Check whether #72 covered them. |
| B1 | Remove the `flows-hp-template-parse` entry from `tools/test-gx/ui/expected-errors.json` once the UI run shows it missing. |

## 5. Test GX plan

| # | Task | State |
|---|---|---|
| 1 / 4 | Scenario engine + heat-pump scenarios | Done (#47) |
| 8a | Repo-only fixture | Done (#49, #58) |
| 8 / 8g | Scenario CI job, green | Done (#54, #72); #74 / #75 timeout cleanup |
| 2 | Charging scenarios | Done (#55); follow-ups in section 4 |
| 9 | Dashboard UI checks (Playwright) | Done (#56); follow-ups in section 4 |
| 8p / T1 | Speed up Test GX; target < 20 min | Steps 1–2: parallel matrix (#87) and faster fixture fake time (#103). Remaining: Docker cache and stack reuse. See T1 below |
| P1/P2 | Test GX scenarios for the heating step-up and the curve monitor | In progress: #89 |
| 3 | Boiler logic scenarios (DHW schedule, shower prep, forced-cycle stops, missing data, Tuya offline) | Pending |
| 5 | Edges: midnight, DST, month change, tariff tier change, sensor failures | Pending |
| 6 | BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`, `send-mail.js` stub + scenarios | Pending |
| 7 | Tuya cloud / local API stub where the logic reads it | Pending |
| — | Compare the Test GX with the live GX over SSH | Pending (needs GX access) |

### T1. Speed up Test GX (merges 8p)

Measure first: write per-step timings (image build, stack up, each scenario) to the job summary. Then, in order of
expected gain:

1. Matrix: one job per scenario file (charging, heating-review, heat-pump-deploy, trivial) in parallel; a final job named
   `scenarios` that needs all of them, so the required check name stays `scenarios`.
2. Fake time: scenarios wait real minutes for the quiet period, `stepMin` and the 15-min defrost recovery. Use faketime
   (`tools/test-gx/test-faketime.ps1` exists) or a test-only time scale read from the fixture, so 15 min runs in ~1 min.
   Real code paths stay unchanged; the scale exists only in the synthetic fixture.
3. Docker layer cache: buildx with `cache-from` / `cache-to: type=gha` for the Venus image (pinned `VENUS_DOCKER_REV`).
4. Reuse one stack per scenario file; reset state between scenarios instead of restarting containers.
5. Lower `timeout-minutes` back to 60 once runs are under 30 min.

Target: whole Test GX < 20 min.

Rule for logic branches: inventory every decision per function node first; done = every decision has a scenario;
production code unchanged; a found bug is marked `expected_fail` and fixed in its own PR. Every Test GX branch adds its
scenarios to the CI job.

## 6. Done (for reference)

#109 TH1–TH4 (d#207, no bump): Test GX coverage for warm-up, band hysteresis, stuck-supply kick and defrost/recovery (test half of H8). Expected failures to fix separately: the Off view omits the warm-up note (TH1); the kick logic still runs during DHW (TH3).

#108 TH5 (d#207): Reject invalid saved heating curves, recapture valid pump values on heating, and refuse out-of-range DP 133/134 writes. Covered by the node 40 regression tests (inventory U5).

#107 D1: manual opt-in for reviewed GX node additions, with dry-run reporting and readback verification. Tested the six UTCP additions from d#205 to d#206 in isolated Node-RED; no d# bump.

#106 TG1–TG3: d#206 test-only grid coverage. The +3 kW import step moved the HV-limited ESS target from 1,000 W to
1,100 W in 21.55 s locally (14.11 s on return). The export guard raised and released the DVCC limit. Three G2 safe-mode
expected failures: stale CT held export charging at 25 A, stale battery voltage held force charging at 20 A, and
stale PV held the export-charge limit at 25 A. Unit coverage includes four replay baselines, hour rollover, billable
day and top-3 month peaks, the tier crossing and the night billing factor; Test GX crosses the 06:00 profile boundary.

#103 T1 step 2: faster synthetic Test GX clocks and balanced CI shards (no d# bump; based on d#206).

2026-11-20/21: #79 simpler heating and boiler (d#201) · #80 review fixes (d#203) · #81 / #83 auto-deploy after Test GX
(gate tests, visible skips) · #82 / #84 Test GX scenario fixes · #85 / #88 backlog · #86 P1 step up when the pump leaves
the mode + blocked-step log, P2 curve monitor (d#204) · #87 T1 step 1: parallel Test GX jobs · #65 P3 warm-up · #66 P6
band · #73 B1 SVG guard · #75 Test GX timeout cleanup · H2 + H7 hold the outdoor value in a defrost (d#205, #94) · H5 mail after every GX deploy (#95, no d# bump).

2026-11-21: H0 idle investigation + H11 idle / gap lane + H13 gaps + H14 UTCP + H15 idle tests (d#206, PR #97). Idle Nov 14-21 (101 periods, 685 min): defrost restart protection 83 / 484 min, below restart level 7 / 121, DHW end 10 / 48, hysteresis 1 / 32. Gaps of 21 Nov were compressor-off periods, not missing data; skipped gate runs never touch the GX. Review fixes (included in d#206): UTCP control needs its own switch (default OFF, Agent (MCP) page), audit IP from req.ip, `utcpLog` only with the UTCP marker, token comparison without an early exit, and network documentation in `docs/utcp.md`. Startup no longer reports a defrost that did not happen.

#59 deploy input `allow_live_only_lines` · #60 several open PRs · #61 P4 motion and hot-water stats · #62 DHW start from
the pump's live outdoor value · #63 P2 Force boiler run · #64 / #67 DHW start replay tests · #68 `startGap` on the
dashboard · #69 backup mail polish · #71 automations never save before load · #72 Test GX green in CI · #74 Test GX
timeout cleanup · #76 pump's own outdoor value for the curve · #77 Copilot no-permission rules. Earlier: P1 version in
the top-right corner (#51), P5 backup sensors (#53), P5f backup mail fixes (#57), #48 boiler emulation recovery.

## 7. End-to-end test cases (from the former docs/e2e-backlog.md)

Live or full-stack checks that no unit test or Test GX scenario covers yet. Mark `done` with the PR or run.

| Item | Scenario | Inputs | Expected write | Status |
| --- | --- | --- | --- | --- |
| P1 | Version badge appears in the top-right header on every page | Open every page after a stamped deployment | None; all pages show the same `d#<n> · <sha7>` badge | todo |
| P1 | Menu names stay plain | Open the dashboard menu after migrating from a legacy stamped deployment | None; names contain neither `d#<n>` nor a Git source suffix | todo |
| P1 | Open dashboard updates after a deploy that bumps `d#` | Leave a dashboard page open and deploy a build with the next flow version and a new dashboard commit | Deployment updates the version tab; the header shows the new `d#` and dashboard SHA without a manual page reload | todo |
| P5 | Dated archives include sensor logs | Send manual 7-day and 31-day archives and trigger a weekly send using synthetic logs spanning UTC/Oslo midnight | One e-mail per send; UTC dates for core and air, Oslo dates for temperatures and events, one catalogue, no config | todo |
| P5 | Dated archive trims optional logs to 18 MiB | Use synthetic incompressible files across all three optional sets | E-mail attachment fits; omissions are largest-first within events, then temperatures, then air; e-mail lists omitted paths and retains core | todo |
| P5 | Oversized core is refused; all-history and full backup keep their existing behavior | Try dated mail with core alone over 18 MiB, then exercise all-history mail and full backup against synthetic data | No e-mail for oversized core; all-history mail keeps whole log tree or refuses it, full backup retains its normal paths | todo |
| P5f | Dated archive near UTC midnight | Manually send at 23:30 UTC with synthetic sensor events at the UTC and Oslo day boundaries | Attachment includes the first UTC day's sensor-event file and excludes the next day's file | todo |
| P5f | Mail staging cleanup and bounded repacks | Seed stale mail files, interrupt a send, then retry with oversized optional sets | Stale files are removed, the next send succeeds, final attachment stays within 18 MiB, and omitted paths are listed | todo |
| P3 | Warm-up raises the house heating for a set time | Heating controller On, supply on the owner curve; press "Warm up" +2 °C for 1 h | Raised P23/P24 written within a minute (not after a 10-min step); followed point = curve + 2; after 1 h P23/P24 back to the owner curve; `heatCurve` unchanged | todo |
| P3 | Warm-up ends safely | Cancel mid-way; switch the heating controller Off; restart Node-RED during a warm-up; start a DHW cycle during it | Owner curve back after cancel / Off; warm-up resumes after restart until its end time; after the DHW cycle the raised curve is written again | todo |
| P6 | Heating follows the curve point with a band | Heating controller On; enable band down 0 / up 2; let the supply cycle | DP 121 = 2 (owner value saved), pump curve = point + 2; compressor stops near point + 2 and restarts below the point; no mode / boost step while the supply is inside the band | todo |
| P6 | Band off restores the owner settings | Turn the band off; switch the controller Off; restart Node-RED with the band on | Owner DP 121 and P23/P24 written back; saved value survives the restart | todo |
| P2 | Forced boiler run waits for a defrost and then starts first | Press "Force boiler run" during a defrost, with the cycle interval not elapsed and heating lagging its curve | No DHW writes during the defrost; after quiet time and supply recovery the cycle starts (curve P23 0, then valve to the tank) before house heating | todo |
| P2 | Forced boiler run keeps safety gates | Request with Er fault / DHW block / tank within 1 °C of target; cancel queued and running requests; restart Node-RED while queued | No start while a gate holds; request expires after 3 h; cancel returns to heating; the queued request survives the restart | todo |
| P4 | Toilet visits are counted once per visit | Local PIR reports at t, t+30 s and t+7 min; restart Node-RED between reports | `dhwUsage.<day>.visits` = 2 in `heat-pump-automations.json`; no extra visit after the restart | todo |
| P2 | Pump outdoor value is latched from its set point | Heating, P22 on, P24 4; read `DP 125`; compare `flow.dhwView.pumpOut` with P23 − (set − 20) / 0.4 across a defrost and the 15 min after it | Value stays at the steady ambient figure (e.g. −1 °C) although DP 103 swings −8 … +50 °C; no update during defrost, bypass, valve on DHW, or within 2 min of a P23 / P24 change; Heat Pump page says "pump outdoor … (from its set point)" | todo |
| P2 | Heating lag is measured against the pump's own set point | Heating with the supply at the pump's reported set; DP 103 reads 4–6 °C below the pump outdoor value | Lag stays near 0 °C, no Silent → Smart kick or curve boost; after 3 h without a valid value the status says "fallback" and the sensor average is used | todo |
| P2 | DHW boiler ramp stays put while DP 103 drops | Start a boiler cycle from heating with a latched pump outdoor value; the compressor starts and DP 103 falls ~6 °C | Boiler P23 follows water + gap only; it does not drop by ~7 °C because of the sensor; the cycle status shows "pump outdoor … (from its set point)" | todo |
| P4 | Hot-water draws are linked to motion | Local motion, then the tank falls 2.5 °C within 3 min; later a 2 °C drop with no motion in the last 15 min | One draw with motion and one without; `dropC` and the hourly bucket updated; Heat Pump page shows the 7-day summary | todo |
| P5g | Archive mail reports why it stopped | Start a second mail while one runs; stop Node-RED / let the exec time out mid-pack | Second send: "Another data archive mail is running"; interrupted send: "@@ERROR Data archive interrupted", no staging files left in /tmp | todo |
| B1 | Heat Pump + history pages render with no console errors (null curve point, no plan) | open pages with missing values | no `cy=""` / $parse errors | todo |
| P7 | Silent follows the curve point | Heating On, Silent; supply stays below point − down for one step interval; then reaches the point | Silent → Smart written; back to Silent once supply ≥ point; no write inside the band | todo |
| P7 | Band sliders drive the limits | Set down 0.5 / up 2 and Save; supply above point + 2 | Step down (boost first, then mode); live values on the sliders survive a reload | todo |
| P7 | Boiler gap | A cycle ends at target; demand again 30 min later; then press Force boiler run | No start, log "waits: last cycle ended hh:mm, gap 1 h"; Force run starts at once | todo |
| P7 | Start DHW after defrost | Option On, tank below target, gap elapsed; a defrost ends | DHW starts at once (valve to the tank), log "start DHW after defrost"; option Off: no start | todo |
| P7 | Status line | Watch the Heat Pump page through heating, DHW, defrost, idle | One line at the top with the right text and since-time | todo |
| P7 | Temperatures page lists room sensors only | Open Temperatures | No pump, water, outdoor, tank, supply, return values; day paging and motion still work | todo |
