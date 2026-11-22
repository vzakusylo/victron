# Agent process log

One line per process event: agents started / stopped, rules changed, incidents, decisions. Newest first.
Tasks themselves are tracked in `BACKLOG.md`; heat pump work in `docs/heat-pump-work-log.md`.

| Date (UTC) | Event | Change / outcome |
|---|---|---|
| 2026-11-22 | G2-SAFE deferred (decision): the grid worker found no source timestamps on the Victron inputs (cached values re-emitted every 5 s), so stale vs healthy-constant cannot be detected safely | Claude chose: no change to `01` now; G2-SAFE blocked in BACKLOG until a freshness design inside G2; expected_fails stay. Worker moved to the DST fold fix. |
| 2026-11-22 | P-R1 review of #103 done (Sonnet subagent): OK with Low findings | follow-ups T-R1a..c in BACKLOG |
| 2026-11-22 | Herdr server found not running; "Herdr server" scheduled task fails at start (0xC000013A) | Claude starts `herdr` in a Terminal-panel tab (`run_in_terminal`) and watches it with `read_terminal`; all six workers came back idle. Scheduled task still to fix. |
| 2026-11-21 | d#206 deploy dry run stopped on six new UTCP nodes | D1 adds a manual opt-in; automatic deploy still stops. Review caught a missing helper in committed-script extraction; the PowerShell runner test now covers extraction and upload. |
| 2026-11-21 | Claude operating guide written from Claude's memory notes; session-start checklist (incl. `herdr status`) and self-improvement rule | `docs/claude-operating-guide.md`, `CLAUDE.md` |
| 2026-11-21 | Herdr worker `w-testgx-faketime-2` blocked ~6 min on a Copilot permission prompt (`git fetch`) | `herdr-task.ps1` starts workers with `--allow-all`; worker restarted in its pane with `--resume`, progress kept (#102) |
| 2026-11-21 | Herdr adopted as the Claude ↔ Copilot transport (send / read / wait) | every new Copilot task is a Herdr worker (#101) |
| 2026-11-21 | Copilot model id was wrong (`gpt-sol-6.2` rejected; tabs ran on the default model) | exact id `gpt-6.2-sol` in docs, `~/.copilot/settings.json`, skill scripts (#100) |
| 2026-11-21 | Copilot "faketime" session ran ~550 AI credits without a push | stopped; work saved as a patch; restarted as a Herdr worker with a fuller brief |
| 2026-11-21 | PR #92 (review verdict gate) could not be reviewed by itself (`claude-code-action` refuses a PR that changes its own workflow) | owner admin merge; documented as a pitfall |
| 2026-11-21 | Grid control declared the top priority; refactoring plan with G0 test gate | `docs/node-red-refactoring-plan.md` (#96, #98, #99) |
| 2026-11-21 | Repo set up for Claude Code: `CLAUDE.md`, `AGENTS.md`, `.claude` settings + flows-check hook, skills, CODEOWNERS, review verdict gate, lib split | #91, #92, #93 |
| 2026-11-21 | One task file | `BACKLOG.md` single source, e2e cases merged in (#90) |
| 2026-11-20 | Auto-deploy after a green Test GX on master | #81, #83; `scenarios` required on master |
| 2026-11-20 | Roles: Claude plans and reviews, Copilot implements; auto-merge on every PR | owner rules |
