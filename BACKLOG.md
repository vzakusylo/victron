# Backlog: all open work in one place

Single source for what is left in this repository. Updated 2026-11-20 (master `16d7aff`, flows `d#196`).
Update this file when a task starts, finishes or changes.

## How we work

- Claude plans, controls and reviews; Copilot implements (code, conflict fixes, pushes, PRs). See
  [docs/agent-workflow.md](docs/agent-workflow.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md).
- One Copilot per branch / worktree, never two on the same folder.
- Every change on its own branch from a fresh `master`, PR into `master`, auto-merge (`gh pr merge N --auto --merge`).
  `master` requires `check`, `tests`, `secret-files` and `review`. Several PRs may be open at once.
- Production `flows.json` and `NN *.js` stay in sync (`node tools/flows.js sync`, `check`); every flow change bumps `d#`.
  When `master` moves, merge it into the branch, rebuild `flows.json` with `sync` and bump again.
- Unit tests for every decision; e2e cases go to [docs/e2e-backlog.md](docs/e2e-backlog.md).
- Live GX deploys only through **Actions → Deploy GX code** (dry run, then apply), each approved by the owner.

## 1. Open pull requests

| PR | Branch | Task | State / next step |
|---|---|---|---|
| #65 | `heating-warmup-boost` | P3: Warm up the house (+N °C for T hours) | Conflicts with master. A local merge of master exists (`2c43af2`, unpushed). Next: one Copilot finishes the merge, fixes the review Medium (`curveCmd` after a boost step-down is in the branch), pushes, then merge (REST merge: it is the base of the stacked #66). |
| #66 | `heating-curve-band` | P6: follow the heating curve point with a down/up band | Stacked on #65. After #65 merges: merge master, `sync` (bump), tests, push, auto-merge. After deploy: first live write of DP 121 — turn the band on once and check the pump reports it. |
| #73 | `hp-page-errors` | B1: guard SVG points on the Heat Pump pages | Conflicts with master, no CI yet. Next: merge master, resolve, push, auto-merge. |
| #75 | `test-gx-timeout-cleanup-2` | Test GX: JUnit on grace stop, abort only open-ended waits (PR #74 review Medium) | Mergeable; finish review and auto-merge. |
| (new) | `heating-simplify` | P7: simpler heating and boiler (d#201) | Silent/Smart follows the curve point; down/up band sliders; boiler gap; DHW after defrost; one status line; Temperatures page = room sensors only. Next: CI, merge, deploy dry run then apply. Replaces the lagUp / overC / gapMax settings of #66 (band semantics: DP 121 = up + down). |
| (new) | `heating-step-up-monitor` | P1 / P2: step up when the pump leaves the mode, log blocked steps, curve monitor (d#204) | P1 and P2 done in code; PR open with auto-merge, Test GX running. After deploy: watch for the first *not following the curve* warning. |

## 2. Deploy

| Item | State |
|---|---|
| GX version | `d#193` (`ea2687e`), confirmed by dry run 44639050718 |
| master | `d#196`: includes #63 Force boiler run, #71 load-before-save, #76 pump's own outdoor value |
| Next | Deploy GX code dry run on master, then apply (owner approval in Actions). Again after #65 / #66 merge. |
| After deploy | Count compressor starts per DHW cycle (startGap 7 vs gap 5, PR #62 review). Check `command -v flock` on the GX (P5g). |

## 3. Production backlog (not started)

| ID | Task | Size (days) | Notes |
|---|---|---|---|
| T1 | Unit-test coverage of the control logic | 1–2 | Per function node: list every decision (input → expected write), add missing tests, list uncovered decisions. After the open PRs merge. |
| D1 | Deploy tool adds reviewed new nodes | 0.5 | `tools/gx/deploy-local.js` only accepts new `temps-*` nodes; `gx-deploy.ps1` stops on added nodes. The P1 `dashboard-version-*` nodes had to be added by hand. |
| B6 | Temperatures page: all sensors, day-by-day paging, motion sensor | 0–1 | Check first: a temperatures page with motion exists since `a4af86d`. |
| B8 | Battery round-trip efficiency | 0.5–1 | |
| B4 | Automation log page: main system events + audit of page usage | 1–1.5 | |
| B5 | Docs: the victron-gx MCP connector (what, how to create, how it works, how to use) | 0.5 | |
| B3 | Data Analytics: train on history to predict solar generation | 2+ | |
| P1 | Heating stuck in Silent: step Silent → Smart → Powerful when the supply does not follow the curve | 1–2 | The supply stays below the curve point and the controller keeps Silent, so the house cannot warm. Investigate `40 Heat pump automations.js` (`heatDecide`, band, `stepMin`, `kickTick` d#175, `coldLimit` "Silent only", `allowPowerful=false` default, deploy quiet period, Test mode = no writes). Find every path where lag > `bandDown` but no step up is written (cold limit forces Silent, `allowPowerful` off caps at Smart, 10-min average not ready, mode read from the pump disagrees, step timer reset by DHW / defrost). Done when: lag below point − `bandDown` for one `stepMin` → Silent → Smart; still lagging after the next `stepMin` → Powerful (when allowed) or curve +1 °C up to the boost cap; back down at point. Each blocked step logs the reason. Unit tests for every path + Test GX scenario "supply stuck below curve in Silent steps up". |
| P2 | Detect and monitor "heating not following the curve" | 1 | Supply 10-min average below point − X °C for > N min while heating (not DHW, not defrost) → status line + Automation log warning "not following curve: point p, supply s, mode m, reason r" and a per-day counter on the Heat Pump page. Defaults X = `bandDown` + 1, N = 45 min, configurable in Advanced. Optional push / notify later. Unit tests; Test GX scenarios for the warning and for no warning inside the band. |
| C1 | Move private hosts / IDs out of `flows.json` and `NN *.js` | 1 | Only if the repository becomes public; needs a `d#` deploy. |

### Heat pump batch H0–H12 (one PR, branch `heat-pump-ux-batch`, not started; P1 / P2 shipped in d#204)

| ID | Task | Notes |
|---|---|---|
| H0 | Investigate why the pump idles / waits | From the stored history and the Automation log: every compressor-off period outside DHW and defrost with its cause (curve point reached / pump hysteresis DP 121, controller waits, Off / Test, too warm, fault). Propose curve / band / hysteresis changes; findings in `docs/heat-pump-work-log.md`. Feeds H11. |
| H1 | Heating curve "now" marker shows values | Curve target now, reported heating set (DP 125), supply now. |
| H2 + H7 | Hold the pump outdoor value during a defrost | The pump's outdoor (`pumpOutNow`) jumps in a defrost: hold the last value from before it during the defrost and the recovery, skip it in the averages, show "outdoor held (defrost)". Unit + Test GX. |
| H3 | Temperatures page "All sensor temperatures": rooms only | Same single room list as `50 Devices model.js` / `tools/sensor-history.js`. |
| H4 | Devices page: × hides a device block, "Hidden devices" list with + to bring it back | Saved in the settings file. |
| H5 | Email after every GX deploy with what changed | New d#, commit, commits since the previous GX version, trigger, Test GX link. Existing mail path, no secrets in the repo. |
| H6 | Heating curve chart: low and high band lines | Point − `bandDown` and point + `bandUp` along the curve. |
| H8 | Review defrost start / end detection | Check the rules (DP 116 / 115, bypass, `recentDefrost`, `defRecovering`, quiet period) against the recorded defrosts; fix wrong edges with tests from a real sequence. |
| H9 | Review that all data is stored | Every value the dashboard / controller uses must be in history (36 / 57 / 58); add what is missing, report gaps. |
| H10 | History by day: week navigation, at most 14 day chips | `39 Heat pump history page.html` / `38`. |
| H11 | "Idle" in the event lane and the Automation log | Idle segments (compressor off, not DHW / defrost) with the reason in the tooltip; log "Idle: reason" and "running again after N min". Test GX scenario. |

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
| 8p / T1 | Speed up Test GX (now 70+ min, one scenario ~17 real min); target < 20 min | Pending; see T1 below |
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

#59 deploy input `allow_live_only_lines` · #60 several open PRs · #61 P4 motion and hot-water stats · #62 DHW start from
the pump's live outdoor value · #63 P2 Force boiler run · #64 / #67 DHW start replay tests · #68 `startGap` on the
dashboard · #69 backup mail polish · #71 automations never save before load · #72 Test GX green in CI · #74 Test GX
timeout cleanup · #76 pump's own outdoor value for the curve · #77 Copilot no-permission rules. Earlier: P1 version in
the top-right corner (#51), P5 backup sensors (#53), P5f backup mail fixes (#57), #48 boiler emulation recovery.
