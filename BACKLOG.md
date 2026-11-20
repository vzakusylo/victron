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
| C1 | Move private hosts / IDs out of `flows.json` and `NN *.js` | 1 | Only if the repository becomes public; needs a `d#` deploy. |

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
| 8p | Parallel isolated stacks; faketime to shorten the ~32 min run | Pending |
| 3 | Boiler logic scenarios (DHW schedule, shower prep, forced-cycle stops, missing data, Tuya offline) | Pending |
| 5 | Edges: midnight, DST, month change, tariff tier change, sensor failures | Pending |
| 6 | BMS watchdog: `battery.tty*`, `/ActiveBmsService`, `BmsInstance`, `send-mail.js` stub + scenarios | Pending |
| 7 | Tuya cloud / local API stub where the logic reads it | Pending |
| — | Compare the Test GX with the live GX over SSH | Pending (needs GX access) |

Rule for logic branches: inventory every decision per function node first; done = every decision has a scenario;
production code unchanged; a found bug is marked `expected_fail` and fixed in its own PR. Every Test GX branch adds its
scenarios to the CI job.

## 6. Done (for reference)

#59 deploy input `allow_live_only_lines` · #60 several open PRs · #61 P4 motion and hot-water stats · #62 DHW start from
the pump's live outdoor value · #63 P2 Force boiler run · #64 / #67 DHW start replay tests · #68 `startGap` on the
dashboard · #69 backup mail polish · #71 automations never save before load · #72 Test GX green in CI · #74 Test GX
timeout cleanup · #76 pump's own outdoor value for the curve · #77 Copilot no-permission rules. Earlier: P1 version in
the top-right corner (#51), P5 backup sensors (#53), P5f backup mail fixes (#57), #48 boiler emulation recovery.
