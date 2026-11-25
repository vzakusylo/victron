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
| #191 | `hp-l1-curve-change-log` | HP-L1, HP-P1, HP-R1, HP-G1, T1 heating/boiler, B1 | Await review and required checks; keep auto-merge paused until feedback is addressed. |

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
NR3 / NR4 / NR5 / NR8 / NR9 → T1b. I1, P-D1 and P-R1 are done; P-A1, P-H1 and T-R1a..c can run any time. The NR / G rows are in the next table.

| ID | Phase | Task | State |
|---|---|---|---|
| NR8 | B perf | Memory: `storeOutMessages` on 20 templates (65 KB heat pump page), day-file reads via `sh`; measure RSS, trim | open |
| P-R1 | process | After-the-fact review of #103: done 22 Nov, OK with Low findings (no weakened expectations, tick gate only in the fixture, wall time ~67 → ~14 min). Follow-ups T-R1a..c | done |
| P-A1 | process | Owner approval page on the GX: a dashboard page (owner login) with expiring, per-action approvals Claude/CI can read but not set: e.g. "run NR1 baseline (read-only, 15 min)", "deploy d#N", "UTCP control writes". Each approval: one action, scope, expiry (default 1 h), audit log + mail; default off; no secrets on the page; never grants shell / key access. Design first (threat model), then build with tests | open |
| P-H1 | process | "Herdr server" scheduled task fails at start (0xC000013A, 21 + 22 Nov); Herdr now runs only in a Claude Code terminal tab. Make the task start the server reliably (hidden, no console to close), test after a logoff / reboot | open |

| ID | Task | Size (days) | Notes |
|---|---|---|---|
| T1 | Unit-test coverage of the control logic | 1–2 | Grid slice covered in #188. Heating and boiler slices done in #191 (`d#247`); decision inventory and remaining gaps below. |

| T1 slice | Curve decisions and coverage |
|---|---|
| Heating: reference and holds | Validate and retain owner P23/P24; use the defrost-held DP 103 average, never DP 125, for the clamped point; hold on missing data, defrost and DHW, and restore only the owning writer's settings. See `heat-owner-curve`, `heat-sensor-curve`, `heat-defrost-outdoor`, and `heat-pump-arbiter` unit tests. |
| Heating: follow and restore | Compare supply against the asymmetric band; step Silent/Smart/Powerful (if allowed), then boost; respect step spacing, capacity/current limits and the combined curve cap. Suppress false off-curve alarms and kicks at capacity. Apply, persist, defer and unwind warm-up, band (including DP 121), standby and gentle-heating offsets. See `heat-curve-follow`, `heat-simplify`, `heat-sensor-curve`, `heat-warmup`, `heat-band`, and `heat-automation`. |
| Boiler: target and start | Base tank and supply targets on the outdoor curve, including the cold cap and frost cutoff. Gate starts on demand, hysteresis, interval, heating priority, defrost and fault/device readiness; force runs may bypass the interval but not safety. Stop the compressor via P23, then wait for the valve before applying the boiler curve. See `dhw-automation`, `dhw-force-run`, `heat-automation`, and Test GX `dhw-schedule` and `dhw-protection`. |
| Boiler: ramp and finish | Use the held outdoor average to choose P23/P24; increase slope only as needed and cap the ramp with the start/running gaps and rate limits. Cold operation stays Silent; frequency/current/discharge protection cuts the curve or ends the cycle. End or hold for defrost, wait for the fan and sensor on recovery, and restore the owner curve on completion, fault, timeout or cancellation. See `dhw-automation`, `heat-automation`, `heat-pump-arbiter`, and Test GX `dhw-defrost` and `dhw-protection`. |

Remaining gaps: software tests verify commanded limits, not the physical compressor stop/restart temperatures,
post-defrost water/tank response, or pump firmware's rounding and response to relay/DP timing. Synthetic protection
scenarios cover frequency/current separately; combined and actual field protection behavior are not proven.
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

### Node-RED refactoring, grid control first (plan: [docs/node-red-refactoring-plan.md](docs/node-red-refactoring-plan.md))

Order: NR1 → G0 → G1 … G6 → NR3 … NR7. One PR each, unit tests and Test GX before each change, measured before and
after on the GX (NR1 table). Grid control (energy controller) is the top priority and must never be delayed by the rest.

| ID | Task | Depends on | State | Notes |
|---|---|---|---|---|
| G2-SAFE | Safe mode on stale critical inputs (Phase A expected_fails: grid-stale-inputs.yml ×3, grid-edges.yml midnight case). **Blocked 22 Nov:** the Victron input nodes repeat cached values every 5 s with no source timestamp, so "frozen" cannot be told from "healthy and constant". Design first: a real freshness signal per input (D-Bus `ItemsChanged` / value-change time, a device heartbeat path such as CT `/Ac/Energy/Forward` or a counter that always moves, battery `/Dc/0/Current` noise), then per-input limits and reactions | G2 design | blocked: needs freshness design | expected_fails stay until fixed; do not time the 5 s re-emits |
| G3-DAILY | Reset the feedback notice count at the Oslo day boundary | G3 | open | The dashboard currently shows a cumulative context count, not the daily count in the G3 plan. |
| G3-TRACKING | Detect sustained physical import divergence separately from command read-back | G3 | open | The current read-back confirms the command paths, not sustained physical tracking; define the detection threshold before enabling alarms. |
| T1-GRID-LEAP | Correct the next-season preview for a Feb 29 switch | T1 | open | A valid Feb 29 setting can display March 1 before the leap year even though control switches February 29. |
| T1-GRID-FLAGS | Align fixed HV support and force-charge flags with the selected decision | T1 | open | Without CT, `GS` can show an unapplied cap; when manual discharge wins, `FC` can still show a force charge. Targets are unchanged by these flags. |
| NR7 | Optional: tabs per area; more big nodes into `lib/` (backup 775, heat pump state 586, device status 523 lines) | NR6 | open | |

### Heat pump batch H0–H12 (one PR, branch `heat-pump-ux-batch`, not started; P1 / P2 shipped in d#204)

| ID | Task | Notes |
|---|---|---|
| H9 | Review that all data is stored | Every value the dashboard / controller uses must be in history (36 / 57 / 58); add what is missing, report gaps. |

### Approved follow-up queue after HP-C1 (2026-11-24, in priority order)

| ID | Task | State / notes |
|---|---|---|
| H16 | Heat pump idle follow-ups (found by H0) | (1) Done in #165. (2) Done in #187. (3) Blocked: the seven-minute stop warning does not identify the failing input; see below. (4) Most idle time (484 of 685 min in Nov 14–21) followed the pump's 3-min restart protection after defrost and waiting for the restart level (set − DP 121). Lowering DP 121 or raising the point would shorten the wait; owner decision. |
| AI1 | Monitoring and curve control split by job: no AI model on the GX (owner question, 2026-11-25) | Open. The Cerbo GX (2-core Cortex-A7, ~1 GB RAM shared with Venus OS and Node-RED) cannot run even a ~0.5B model without starving the controller. **Spot problems:** GX, no AI; fixed rules in Node-RED (D-R14 health checks, #190). **Send email:** GX, no AI; existing deploy mail and alerts. **Control the curve:** GX, no AI; owner curve plus the heating controller within fixed limits (HP-B1 caps the uplift); an AI never writes P23/P24. **Explain issues / suggest changes:** off the GX; a scheduled job (PC, Pi or cloud) reads the D-R14 health results and the Node-RED log, mails a plain-language summary daily and after each deploy, and proposes curve changes for the owner to approve. Next: brief for that off-GX job once #190 is merged. |

**H16(3), forced boiler stop:** `lib/heat-pump/dhw-tick.js` (`showerMeasurementsOk` and `showerSafetyStopRequested`) latches on one tick with an unavailable/stale HP, valve or bypass, or an invalid tank, cycle DP or relay reading. It cancels old-run writes immediately and waits for devices to become available before restoring heating. `lib/heat-pump/kick.js` yields to pending or active DHW and writes only DP 2, which this guard does not validate. A reported fan speed of zero is valid and does not by itself cause this stop. To identify the seven-minute incident, obtain the timestamped device connection states and `lastData`, raw HP DPs 15, 101–104, 108, 112, 115–116, 132–134, and valve/bypass DP 1 at the first warning tick. If that snapshot was not retained, add first-trigger diagnostics before changing the safety policy. No stop behavior was changed.

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
| 3 | Boiler logic scenarios (DHW schedule, shower prep, forced-cycle stops, missing data, Tuya offline) | Done: #114 |
| 5 | Edges: midnight, DST, month change, tariff tier change, sensor failures | Pending |
| 6 | BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`, `send-mail.js` stub + scenarios | Pending |
| 7 | Tuya cloud / local API stub where the logic reads it | Done: #115 |
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

#191 HP-L1 (`hp-l1-curve-change-log`, d#247 · i#61): persistent, rotating P23/P24 and owner curve change history,
with writer attribution and heating details. The Heat Pump page shows the latest 50 rows and 24-hour writer counts;
D-R14 and the deploy mail carry the latest five. AI1 remains open for off-GX explanations only.

#191 HP-P1 (d#247 · i#61): timed standby and Resume now, persisted across restart. Active DHW cycles finish normally.
Freezing or unknown outdoor temperatures and low or unknown tank temperatures override the pause. The tank floor is the
lowest configured tank target minus hysteresis.

#191 HP-R1 (d#247 · i#61): opt-in Er03 retry, default two attempts after a 30-minute delay and clear fault.
The attempt count survives restart; an exhausted block still uses the existing alert.

#191 review follow-up: local control cannot switch Off while a pause is active or while its owner curve restore is pending.

#191 HP-G1 (d#247 · i#61): opt-in compressor frequency, curve rise, P23 step and spacing limits and Silent preference.
Sustained high Hz lowers P23 after three minutes. The synthetic Test GX pause and gentle heating scenarios passed.

#190 Copilot worker model tiers (`d-r14-post-deploy-monitor`, d#246 · i#60): checked in the launcher and
tier definitions; documented low reasoning effort by default, overrides, and the status-bar model check.

#190 HP-B1 Heating curve cap (`d-r14-post-deploy-monitor`, d#246 · i#60): the old limit capped only the
power boost, not the combined warm-up and band offset. The DHW coefficient solver could round up P23 and
steepen P24 beyond P23 40. The old calculation used the owner baseline, so a restart did not directly add
on top of the pump curve, but it could lose track of an offset the pump retained. Heating now reconciles
the reported coefficients, caps the combined rise (4 °C by default), and never raises P24. D-R14 checks
the observed pump target against the owner target. Test mode or local control OFF is explained before
the curve limit. No live GX access.

#190 D-R15 GX notification output (`d-r14-post-deploy-monitor`, d#244 · i#60): restore the custom output's
missing string `pathObj`; palette v1.6.31 dereferenced `pathObj.disabled` on every incoming alert. The grid
feedback alarm is consistent with the 15-minute cadence but the log excerpt does not identify the sender.
D-R14 now reports new notification-output errors as their own check. No live GX access.

#190 D-R14 Post-deploy health (`d-r14-post-deploy-monitor`, d#243 · i#60): configurable checks every five
minutes for one hour after a Deploy GX code apply; saved health history and a read-only Health page. A final
failure turns the deploy job red and is included in its mail. Verified with fake GX readings and a simulated
clock; live GX and local dashboard rendering were not checked.

#189 G3-COOLDOWN (`g3-cooldown`, d#242 · i#59): use elapsed time for the 15-minute grid feedback notice cooldown. Forward and backward clock changes no longer alter it; legacy persisted notices start a conservative cooldown.

#188 T1 grid slice (`t1-grid-coverage`, d#241 unchanged · i#58): inventory node `01` decisions and add 49 mutation-checked unit tests. Findings are tracked separately; no production changes.

#187 H16(2) (`h16-owner-curve-boiler-stop`, d#241 · i#57): a partial DHW restore readback (P23/P24 27/5) can no longer overwrite the saved owner curve (33/5). Pump readings initialize a missing baseline; only a confirmed owner Apply replaces a saved one.

#186 HP-M2 stage 3 (`hp-m2-curve-owner`, d#240 · i#56): enforce a shared P22–P24 lease and an independent DP 121 lease. Keep automatic curve SETs paced and ordered under one generation, compose warm-up / band / boost against the owner's curve, and confirm both owner Apply coefficients under the same live lease before saving them. Automatic curve leases use elapsed time so a wall-clock jump cannot split a queued curve group.

#185 HP-M2 stage 2 (`hp-m2-mode-writer`, d#239 · i#55): enforce DP 2 writer priority (protection > DHW > recovery > kick > heat > owner) with bounded leases and generation checks at dequeue and verification. Rejected requests are not replayed; a kick that never sent Smart cannot restore Silent. Curve and hysteresis enforcement remain stage 3.

#184 HP-M3 Heat pump write attribution (`hp-m3-attribution`, d#238 · i#54). Tag dispatched DP 2, DP 121 and P22–P24 writes with HP-M2 writer labels. Log and digest unexplained read-back changes with old/new values and observation time; mismatch mail names the requester and last observed writer. No SET behavior change.

#183 D-R12 follow-up: heat-pump restart settle (`deploy-restart-settle`, d#237 · i#53). With fresh, clear telemetry and no recent defrost, seed DP 103 and settle for 2 minutes. Keep the 15-minute hold for defrost or unknown startup conditions. The D-Bus pin shipped separately in #180 and was corrected in #181.

#182 D-R13 Auto-deploy WAIT retries (`d-r13-deploy-wait-retry`, d#236 unchanged · i#52): retry eligibility, drift and the window every 15 minutes for up to two hours. Skip a stale run or one superseded by a newer automatic deploy; report window expiry separately from deploy errors. Manual dispatches do not supersede waiting runs. Verified with fake GX and a simulated clock; no live GX access.

#181 D-R12 pin correction (`deploy-pin-0413`, d#236 · i#51): pin both Function nodes and Test GX to `dbus-native-victron@0.4.13`. Deploy run 45482443134 stopped before writing because Node-RED loads 0.4.13 from its user directory, not the unused 0.4.6 copy in `externalModules`. Preflight stays strict.

#180 D-R12 Deploy restart side-effects (`deploy-pin-dbus-native`, d#235 · i#50): originally pinned `dbus-native-victron@0.4.6` in both Function nodes and Test GX; superseded by #181 because the GX loads 0.4.13 from `userDir/node_modules`. Preflight blocks any mismatch without posting the flow. **Recommendation: keep the 15-min restart quiet period.** On 24 Nov, apply 45447773391 started 16 min after the last defrost start, with ~20 min until the next predicted start, and restarted modified nodes. The reported 46-s control interruption during the module install does not measure heat-pump sensor recovery. Restart loses the recent defrost state, and H8 showed that missing readings can hide a defrost exit. Shorten only if a replay with fresh post-restart readings demonstrates reliable recovery. No heat-pump behavior change or live GX access.

#179 HP-C2 Curve slider back (queued) (`hp-curve-slider`, d#234 · i#49). Preview the P23 adjustment at the 10-minute outdoor average and queue it on release with the stored P24. Advanced Apply uses the same queue and two-readback confirmation. Unit regression covers preview, release, pending and DHW refusal, and forwarding without a direct pump write.

#178 HP-C1 Curve model: drop pump outdoor (`hp-curve-model`, d#233 · i#48). Use the defrost-held DP 103 average; report capacity instead of escalating lag at ≥ 85 Hz with non-falling supply. Replace the slider with one low-priority P23/P24 batch and save only on two fresh readbacks. The idle scenario now verifies a valid sensor average before inducing a stop: during startup the restart level is unknown, not inferred from DP 125. No live GX access.

#177 D-R11 Admin API keep-alive EPIPE (`deploy-no-keepalive`, d#232 unchanged · i#47): use fresh connections for all GX admin requests. On a pre-response reset, retry the whole-flow POST once only if the live revision is unchanged; otherwise verify without reposting. Fake-GX replay covers the 1 MiB POST, retry, and verification paths; no live GX access.

- #176 R6: consolidated live GX runner guidance and archived the three handoffs (i#46, d#232 unchanged).

#175 G6 follow-up (`grid-g6-split`, d#232 · i#45): move the remaining grid decision stage and bookkeeping tick assembly into node-local includes, leaving `01` as loop wiring without changing behavior.

#174 D-R10 Adopt live GX input settings (`adopt-gx-inputs`, d#231 · i#44): adopt the six input names and periodic reporting settings, and translate their emitted topics to the controller's existing topics. Both deploy gates accept drift already matching the target and ignore layout order. Offline replay of run 45406703938 accepts 12 fields and reports no changes for the six inputs; no live GX access.

#173 D-R9 Whole-flow deploy (`deploy-whole-flow`, d#230 unchanged · i#43): replace the per-node opt-ins (D1, D-R2–D-R6 and P-D1) with a recorded Git baseline drift gate and revision-guarded whole-flow deployment. Use deterministic Tuya file-secret references for both commits. Fake API tests and an isolated Node-RED replay cover d#217 → d#230; no live GX access.

#172 D-R8 Admin API read retries (`deploy-api-retry`, d#230 unchanged · i#42): retry transient Node-RED GET failures with a deadline and name the failed request. The fake GX replay verifies recovery and exhaustion, HTTP status handling, and that POST is attempted once with the existing rollback behavior.

#171 H8 (`hp-defrost-detect-review`, d#230 · i#41): fault injection into the 20 Nov defrost replay found false edges on missing/stale DP 116/115 and false recovery from bypassed supply. Keep the defrost active through telemetry gaps, restart the 15-minute quiet period when the exit was unobserved, and validate bypass release and supply recovery.

#170 H1/H6 (`hp-curve-chart-now-band`, d#229 · i#40): show the current curve target, reported DP 125 and supply at the heating curve marker; plot the configured lower and upper bands.

#169 H10 (`hp-history-week-nav`, d#228 · i#39): History by day opens on the newest week and pages through available weeks, with at most seven day chips visible.

#168 D-R7 Function libs in deploy (`deploy-function-libs`, d#227 unchanged · i#38): deploy module declarations with preflight. The historical dry run clears the module mismatch, then stops at `hp-page-template-01` because `storeOutMessages` and `resendOnRefresh` change from `true` to `false`; the settings guard is unchanged.

#167 H3/H4 (`hp-ux-rooms-hidden`, d#227 · i#37): share room temperature classification between Devices and Temperatures; persist hidden Devices cards and restore them from the dashboard without affecting telemetry or device control.

#166 D-R6 Reviewed rewires in deploy (`deploy-reviewed-wires`, d#226 unchanged · i#36): apply explicitly reviewed target wiring only when live wiring matches the recorded Git baseline; the full offline replay writes a plan with six reviewed sources.

#165 H16(1) (d#226 · i#35): back off routine near-target DHW Silent retries after three unconfirmed writes. Fresh DP 2 confirmation or a new decision cycle resets the retry streak; protection writes are unchanged.

#164 D-R5 Group-less dashboard nodes in deploy additions and reviewed new wires (`deploy-groupless-ui`, d#225 unchanged · i#34): allow group-less Dashboard-wide nodes and opt-in append-only wiring; the Git-only replay still stops at `hp-tuya-pump-01` because output 1 replaces `hp-topic-hp-01` with `hp-status-topic-hp-01`.

#163 D-R5 Preserve repository group order on additions (`deploy-group-additions`, d#225 unchanged · i#33): order affected layout group members as in Git while preserving live-only memberships; removal behavior is unchanged.

#162 G6 (`grid-g6-bookkeeping`, d#225 · i#32 unchanged): split grid input handling, D-Bus read-back, output publication and legacy bookkeeping handoff into node-local helpers without changing grid behavior.

#161 D-R4 Dropped output with removal (`deploy-drop-output`, d#224 unchanged · i#32): allow dropping trailing outputs wired only to approved removals. The d#217 to d#224 offline removal plan passes; additions stop at `hp-dashboard-viewers-01` (`ui_ui_control`, no `group` field).

#160 TGX5-DST (`grid-dst-scenarios`, d#224 unchanged · i#31): verified Oslo spring-forward and fall-back tariff accounting, stable night limits with no extra writes, and the midnight day/month reset. Local grid edges: three passes and the existing G2-SAFE expected failure.

#159 D-R3 Group order in deploy removals (`deploy-group-order`, d#224 unchanged · i#30): accept order-only drift and restore repository order for survivors. The full d#217 to d#224 offline replay still stops at the independent `dv-aq-fn-01` output-count change.

#158 NR5 (`nr5-tick-context`, d#224 · i#29): steady automations ticks went from 15 context writes / 8 JSON serializations to 1 / 0. Test GX uses memory context (no disk flush); live store and its interval were not checked. Settings and logs still write on events, not every tick.

#157 Claude review token skill (d#223 unchanged · i#28): document owner-run rotation of the Claude review secret without echoing its value or putting it on the command line.

#156 D-R2 Remove Victron input nodes in deploy (d#223 unchanged · i#27): allow reviewed read-only Victron input removals. The d#217 → d#222/d#223 Git replay still stops at the independent `dv-aq-fn-01` output-count change; the wiring guard is unchanged.

#155 NR4 (d#223 · i#26): separate Tuya connection events from data, keep the raw state immediate for controls, and build the derived model at most once per 5 s. Send changed live values and static curve parts only to viewers, with a full snapshot on entry. History remains on demand. Roll out the new nodes, wire changes and templates together.

#154 G5 (d#222 · i#25): read-only Grid control panel on Protection with decisions, write/read-back status, input ages, alarm counts, cadence and lag. Safe mode remains unimplemented pending G2-SAFE. Roll out the new widget and controller output wiring together.

#153 G4 (d#221 · i#24): route tariff history directly to bookkeeping, report grid cadence and event-loop lag, and alarm after 10 s of missed decisions through the existing Automation log and alert digest. Verified with `grid-isolation.yml`, `grid-heartbeat.yml`, and `charging-guards.yml`. Roll out the new monitor and history wiring together.

#152 TGX-R1 (d#220 · i#23): emulator MQTT connect retry (CI flake run 45119354024). Retry transient startup failures within a configurable 60 s budget, wait 30 s for subscription readiness, and print the Venus log tail if Compose cannot start the stack.

#151 G3 (d#220 · i#22): verify ESS, DVCC and VE.Bus writes over D-Bus; retry once through the existing Victron writers and rate limits, then report a rate-limited alarm through the Automation log and existing alert digest. Test GX covers the ignored VE.Bus write and the unchanged G2 reaction ceiling. Deploy node 01's code, Function imports and alert wiring together; not a code-only deploy.

#150 NR6 (d#219 · i#21): removed the unwired `/Dc/0/Current` input and added a check against unwired inputs and injects. G2 already removed the duplicate 06:00 / 22:00 injects and Tag nodes; the wired cadence inject remains. Test GX now verifies the synthetic SerialBattery has disappeared before clearing `BmsInstance`, avoiding a race reproduced on master where the watchdog reads a stale active service and remembers `-1`.

#149 NR3 (d#218 · i#20): estimated scheduled exec starts/h (not descendant processes): BMS 120 → 0 steady-state, air history up to 30 → 0, cloud 0 → 0 disabled (30 → 4 if enabled), Devices 30 → 30, local listener ~6 → ~6, Payback 1 → 1. Up to ~187 → ~37 with cloud off, excluding event-driven jobs; the <30/h target is not met. Devices still polls for temperature history and daily mail. GX apply needs the Function imports (`fs`, `dbus-native-victron`), cloud inject change and air-history topology change together; do not code-only deploy.

#148 HP-M2 stage 1 (d#217 · i#19): observe ownership and log disagreements for DP 2, the P22–P24 group and DP 121 without changing SETs. Stages 2 (mode) and 3 (curve and slider) remain open.

#146 HP-M1 (d#216 · i#17): confirm heat pump mode from fresh DP 2 observations, pause non-safety retries after three failures, and send one incident alert plus a six-hour reminder if unresolved. Includes the HP-P1 replay; superseded checks do not count as failures, and DHW and protection writes are never backed off.

#145 (d#215 unchanged, i#16): isolate the automatic deploy recheck checkout so the pinned checkout includes `scripts/gx-deploy.ps1`.

#144 NR9 (node 34, d#215 · i#15): split heat pump state into device decoding, heating curve, dashboard model, and DHW view includes (594 → 150 lines). Two characterization tests preserve current outputs and state. NR9 is complete.

#143 (d#214 unchanged · i#14): add owner tooling and documentation for checking, installing, testing, rotating, and revoking the restricted camera SSH public key. Checked offline; no live key changes.

#142 (d#214 unchanged · i#13): deploy the restricted GX SSH mail gate with bounded stdin JSON and a documented camera client protocol. The separate `camera-ai` repository owns the production client.

#141 P-D1 follow-up (d#214 unchanged, i#12): verified replacement ignores trailing-only differences, matching deploy readback. Run 45053215705 read the same d#210 revision already verified with no substantive code drift.

#139 (d#214 unchanged · i#10): manual allowlist for Git-verified GX node removals after G2.

#138 NR9 (node 26 only, d#214 · i#9): split the backup dashboard into mail scheduling, archive scripts, mail scripts, and view includes (775 → 341 lines); two characterization tests preserve current behavior.

#134 T1b (d#213 unchanged · i#8): share the Test GX images across shards. Typical shard setup fell from ~170–200 s to 31–53 s. The extra build job adds 3:32 cold (0:58 warm) to the critical path; the cold path is estimated within a minute of baseline, not demonstrably faster. The full warm PR run was green in 52:18 including queues vs. 15:04–18:13 before, while summed runner time fell from 203:00 median to 135:16 despite one extra job. See [CI timings](docs/test-gx.md#t1b-timings).

#132 NR9 (node 29 only, d#213 · i#7): split device status into sampler, parser, and view includes (523 → 116 lines), with two characterization tests and no runtime changes.

#136 G2 (d#212 · i#5): one 2 s decision tick plus immediate CT steps over 1 kW; removed the fixed input delays, kept the output rate limits, and tightened the synthetic write ceiling to 16 s. Owner manual topology apply required. [Candidate freshness signals](docs/grid-g2-design.md) await read-only verification; G2-SAFE remains blocked.

#131 G1 (d#211 · i#4): pure grid decisions in `lib/grid/control.js`, with budgets, tariffs, logs and status in `63 Grid bookkeeping.js`. Frozen replays pass unchanged. Owner manual dry-run and apply with `allow_new_nodes=true` required.

#131 G0 (d#210 baseline): six consecutive green master Test GX runs, `75ca6a1` through `5d98fc6`, satisfy the pre-refactor gate. Frozen replay, reaction and stale-input coverage shipped in #106; G2-SAFE expected failures remain.

#130 P-D2 (d#210 unchanged · i#3): manual GX runs verify replaced lines against the recorded deployment, blocked dry runs report the reason and next step, and automatic runs select the newest eligible green master ancestor.

#129 T-R1a..c (d#210 unchanged · i#2): observe the deploy quiet period for 40 fake seconds at 14 minutes, require all six fixture gates to forward ticks, and use a dedicated fixture deploy timestamp.

#128 I1 (`d#210` unchanged · `i#1`): infrastructure changes require one separate version bump, checked in CI and shown alongside the production version in the CLI, Test GX summary, and deploy mail and report.

#126 TGX7-CLOUD-LATE / TGX7-LOCAL-AGE / TGX7-LOCAL-NULL (d#210): disabled cloud ignores late replies, battery-only wakes no longer refresh temperature, and JSON `null` lines no longer discard subsequent readings. All three expected failures are now passing regression tests.

#125 TGX5-DST-FOLD (d#209): separate the two Oslo October 02:00 budgets and preserve both CSV rows and local tariff peaks. Unit and synthetic Test GX coverage also verifies the March gap.

#123 TH3 (d#208): stuck-supply Smart kicks are heating-only; pending and active DHW suppress kicks, and a running kick returns to Silent when DHW takes over.

#118 P-D1 (d#207 unchanged): automatic replacement of GX-only code lines requires an exact match to the recorded Git deployment; fake-GX tests cover matching, hand-edited, and missing records.

#117 NR1 (d#207 unchanged): read-only GX performance sampler with fake-SSH tests and an empty baseline table in the refactoring plan. The owner will collect the live measurements. Baseline (22 Nov, d#207): CPU 20.5 %, RSS 352 / 364 MiB, >= 584 spawns/h, admin TTFB p50 187 / p95 381 ms (plan section 5).

#116 Grid reaction timing (d#207 unchanged): `grid-reaction.yml` uses a documented 30 s ESS write ceiling and a 35 s real observation window; both scenarios passed on three consecutive local runs.

#115 TGX7 (d#207 unchanged): `tests/test-gx-tuya-sensors.test.js` feeds synthetic exec responses through nodes 44/46 and the heat-pump state node. Three checks passed in-process; three expected failures are tracked above as TGX7-CLOUD-LATE, TGX7-LOCAL-AGE, and TGX7-LOCAL-NULL. No Tuya network or credentials used.

#114 TGX3 (d#207 unchanged): `dhw-schedule.yml` covers cycle interval expiry, shower prep and opt-out, manual force start/stop, invalid inputs, and a safety stop after Tuya reconnects. Four local scenarios passed in 453.9 s total, no expected failures.

#113 TB2 (d#207 unchanged): `dhw-defrost.yml` covers defrost pause/resume during an active cycle, the minimum gap after completion, and disabling DHW start after defrost. Local scenarios: 133.7 s and 118.7 s, no expected failures.

#112 TB1 (d#207 unchanged): `dhw-protection.yml` covers Silent and the supply cap at the cold limit, and separate sustained frequency and current protection steps. Local scenario: 157.6 s, no expected failures.

#111 TGX5 (d#207 unchanged): grid day/month rollover, both Europe/Oslo DST boundaries, a tier increase, and stale CT at midnight. Expected failures: TGX5-DST-FOLD and the existing G2 stale-input issue.

#110 TGX6 (d#207 unchanged): offline serial BMS restart and `BmsInstance` recovery in `bms-watchdog.yml`; notification suppression covered in-process, with SMTP stubbed in the fixture. Local scenario: 47.3 s, no expected failures.

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
| P3 | Warm-up raises the house heating for a set time | Heating controller On, supply on the owner curve; press "Warm up" +2 °C for 1 h | Raised P23/P24 written within a minute (not after a 10-min step); followed point = curve + 2; after 1 h P23/P24 back to the owner curve; `heatCurve` unchanged | done — `heat-warmup.test.js` |
| P3 | Warm-up ends safely | Cancel mid-way; switch the heating controller Off; restart Node-RED during a warm-up; start a DHW cycle during it | Owner curve back after cancel / Off; warm-up resumes after restart until its end time; after the DHW cycle the raised curve is written again | done — `heat-warmup.test.js` |
| P6 | Heating follows the curve point with a band | Heating controller On; enable band down 0 / up 2; let the supply cycle | DP 121 = 2 (owner value saved), pump curve = point + 2; compressor stops near point + 2 and restarts below the point; no mode / boost step while the supply is inside the band | done — `heat-band.test.js` (commanded behavior; physical cycling unverified) |
| P6 | Band off restores the owner settings | Turn the band off; switch the controller Off; restart Node-RED with the band on | Owner DP 121 and P23/P24 written back; saved value survives the restart | done — `heat-band.test.js` |
| P2 | Forced boiler run waits for a defrost and then starts first | Press "Force boiler run" during a defrost, with the cycle interval not elapsed and heating lagging its curve | No DHW writes during the defrost; after quiet time and supply recovery the cycle starts (curve P23 0, then valve to the tank) before house heating | todo |
| P2 | Forced boiler run keeps safety gates | Request with Er fault / DHW block / tank within 1 °C of target; cancel queued and running requests; restart Node-RED while queued | No start while a gate holds; request expires after 3 h; cancel returns to heating; the queued request survives the restart | todo |
| P4 | Toilet visits are counted once per visit | Local PIR reports at t, t+30 s and t+7 min; restart Node-RED between reports | `dhwUsage.<day>.visits` = 2 in `heat-pump-automations.json`; no extra visit after the restart | todo |
| P2 | Heating uses the defrost-held sensor average, not fixed DP 125 | P23/P24 40/9, DP 125 at 36 °C, sensor average −9 °C; then inject a defrost spike in DP 103 | Target 60 °C; Heat Pump page says "sensor −9 °C (10-min average)"; average stays at −9 °C until recovery | done — `heat-sensor-curve.test.js`, `heat-defrost-outdoor.test.js` |
| P2 | Capacity-limited heating is not an off-curve fault | Hold supply at 40 °C against a 60 °C target with compressor at 89 Hz | Capacity-limited status, no off-curve warning, no demand increase from lag, warm-up, band or kick | done — `heat-sensor-curve.test.js` |
| P2 | DHW boiler ramp follows the held average | Start a boiler cycle and inject a defrost spike in DP 103 | Boiler curve uses the pre-defrost average through recovery; the cycle status cites the sensor average | done — `dhw-automation.test.js` |
| P4 | Hot-water draws are linked to motion | Local motion, then the tank falls 2.5 °C within 3 min; later a 2 °C drop with no motion in the last 15 min | One draw with motion and one without; `dropC` and the hourly bucket updated; Heat Pump page shows the 7-day summary | todo |
| P5g | Archive mail reports why it stopped | Start a second mail while one runs; stop Node-RED / let the exec time out mid-pack | Second send: "Another data archive mail is running"; interrupted send: "@@ERROR Data archive interrupted", no staging files left in /tmp | todo |
| B1 | Heat Pump + history pages render with no console errors (null curve point, no plan) | open pages with missing values | no `cy=""` / $parse errors | done — #191 (`d#247`), Edge regression in `dashboard.spec.js`; no expected errors |
| P7 | Silent follows the curve point | Heating On, Silent; supply stays below point − down for one step interval; then reaches the point | Silent → Smart written; back to Silent once supply ≥ point; no write inside the band | done — `heat-simplify.test.js` (return threshold is point + half the upper band) |
| P7 | Band sliders drive the limits | Set down 0.5 / up 2 and Save; supply above point + 2 | Step down (boost first, then mode); live values on the sliders survive a reload | todo |
| P7 | Boiler gap | A cycle ends at target; demand again 30 min later; then press Force boiler run | No start, log "waits: last cycle ended hh:mm, gap 1 h"; Force run starts at once | todo |
| P7 | Start DHW after defrost | Option On, tank below target, gap elapsed; a defrost ends | DHW starts at once (valve to the tank), log "start DHW after defrost"; option Off: no start | todo |
| P7 | Status line | Watch the Heat Pump page through heating, DHW, defrost, idle | One line at the top with the right text and since-time | todo |
| P7 | Temperatures page lists room sensors only | Open Temperatures | No pump, water, outdoor, tank, supply, return values; day paging and motion still work | todo |
