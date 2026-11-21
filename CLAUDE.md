# CLAUDE.md: working in this repository

Node-RED control for a Victron Cerbo GX (Venus OS): battery / grid control under Norwegian capacity tariffs, a Tuya
heat pump with boiler (DHW), room sensors and the dashboards. The live GX runs `flows.json`; everything else is source,
tools, tests and docs. `camera-ai/` is a separate project with its own README and PLAN.

## Where things are

| Path | What |
|---|---|
| `NN Name.js` / `NN Name.html` (root) | Source of every function node / dashboard template. **Edit these, never `flows.json` by hand.** |
| `NN Name.init.js` | The node's "On Start" code |
| `lib/heat-pump/*.js`, `lib/grid/*.js` | Parts of `40` / `01`, pulled in by a `// #include lib/…js` line at build time (`tools/includes.js`): same scope as the node, not modules. Each lib file belongs to exactly one source (`check` enforces it). `//!` header lines are not embedded. |
| `flows.json` | Built from the `NN` sources by `tools/flows.js sync`; the tab label carries the version `d#<n>` |
| `tests/*.test.js` | Unit tests (`node:test`); `tests/harness.js` loads a node with fake `flow` / `context` |
| `tools/flows.js` | `sync`, `check`, `bump` |
| `tools/test-gx/` | Test GX: Venus simulator + Node-RED in Docker, scenario runner, `scenarios/*.yml` |
| `tools/gx/`, `scripts/gx-*.ps1` | Deploy tooling (compare, gate, deploy) |
| `.github/workflows/` | `check`, `pr-tests`, `test-gx` (scenarios), `claude-code-review`, `deploy-gx-code`, `deploy-victron` |
| `config/` | Device configs and install notes (serialbattery, MultiPlus) |
| `docs/` | How things work (design, deploy, Test GX). `docs/archive/` = old handoffs, read only |
| `BACKLOG.md` | **The one file for tasks, plans, test plans, open PRs, deploy state and progress** |

Big nodes: `40 Heat pump automations.js` (header, state, load, ui, tick; the parts are in `lib/heat-pump/`: `curves`,
`heating-decide`, `dhw-helpers`, `dhw-tick`, `heating-tick`, `kick`) and `01 Battery + Grid Controller.js` (main flow;
`lib/grid/constants`, `lib/grid/helpers`). Read the header comment of the node first: it lists every `d#` change.
A lib edit is a change of that node: `sync` bumps `d#` and it deploys like any flow change.

## Commands

```powershell
node tools/flows.js sync          # after editing NN sources: rebuild flows.json, bump d# once
node tools/flows.js check         # sources and flows.json in sync (CI runs this)
node --test "tests/*.test.js"     # all unit tests
node --test tests/heat-curve-follow.test.js   # one file
.\tools\test-gx\up.ps1 -Sim emu   # local Test GX stack (Docker); .\up.ps1 -Down to stop
node tools/test-gx/run-scenarios.js --file heating-review.yml   # scenarios of one file against the local stack
```

## Rules

1. **Every flow change:** edit the `NN` source, `node tools/flows.js sync` (bumps `d#`), `check`, unit tests. Never
   hand-edit `flows.json`. If `master` moved, merge it, `sync` again.
2. **A unit test for every new or changed decision.** Pure decisions (e.g. `heatDecide`) are tested directly; behaviour
   through `tests/harness.js` with ticks. A test must fail without the change.
3. **Branches and PRs:** every change on its own branch from a fresh `origin/master`, in its own worktree, PR into
   `master`, `gh pr merge <N> --auto --merge`. `master` requires `check`, `tests`, `secret-files`, `review`,
   `scenarios`. Never push to `master` directly; merge commits, no rebase or force-push.
4. **Tasks live only in `BACKLOG.md`:** add the task before the branch, set "in progress" with branch / PR, move to Done
   with PR and `d#` in the same PR as the work.
5. **Deploys:** a green Test GX run on a master push deploys that commit to the live GX automatically
   (`deploy-gx-code.yml`, env `victron-gx-auto`). Manual: Actions → Deploy GX code, dry run then apply, owner approval.
   The dry run stops on GX-only lines; check them with `tools/gx/compare.js` before `allow_live_only_lines`.
6. **Live GX, secrets, real backups:** never touch without an explicit owner request. Real backups and keys stay outside
   the repo and the Docker image. `secret-files` CI blocks private hosts / keys.
7. **Test GX work does not change production sources.** A bug found by a scenario is marked `expected_fail`; the fix gets
   its own PR. New scenario file → add it to the `files` matrix in `test-gx.yml` (a unit test checks this).
8. English in code, docs, commits and PRs.
9. Owner's own rules (in the owner's global CLAUDE.md) win: e.g. commits / pushes only when asked in that session.

## Agents

Claude plans, reviews and may implement when the owner asks; GitHub Copilot CLI implements from a brief file.
**Copilot model: `gpt-6.2-sol`** for every new task (exact id; `gpt-sol-6.2` is rejected, and without `--model`
Copilot uses its own default). One agent per worktree. Copilot's rules: `.github/copilot-instructions.md`; the loop:
`docs/agent-workflow.md`. Every report ends with the branch name.

**Every new Copilot task runs as a Herdr worker** (since 2026-11-21), so Claude can send corrections and ask for
progress instead of the owner relaying text:
1. `herdr status` must say `running` (else start `herdr` in its own terminal; never restart a running server without
   the owner: it kills all workers).
2. `herdr-task.ps1 new <branch> -Base origin/master` → worktree `~\.herdr\worktrees\victron\<branch>`, Copilot on
   `gpt-6.2-sol` as agent `w-<branch>`.
3. Write `.copilot-brief-<branch>.md` in that worktree (goal, context, steps, tests, delivery: PR + auto-merge).
4. `herdr-task.ps1 send <branch> "Read .copilot-brief-<branch>.md and do all of it."`; later `send` for corrections /
   "progress?", `read <branch>` to look without interrupting, `wait <branch>` until idle / blocked.
5. After the PR merges: `herdr-task.ps1 close <branch>`.
`herdr-task.ps1` is the owner's `herdr-worker` skill script (`~\.claude\skills\herdr-worker\`). A plain
`copilot --allow-all --model gpt-6.2-sol -i 'Read <brief> and do it'` in a terminal is the fallback when Herdr is not
available; then nobody can type into it except the owner.

Project skills (`.claude/skills/`): `ship-pr` (sync, test, backlog, PR, auto-merge), `test-gx-local` (Docker
scenarios), `deploy-gx` (dry run, GX-only lines, apply, confirm), `victron-status` (live status via MCP).

The `review` check fails when the Claude review finds a failing test or a High / Critical problem (verdict gate in
`claude-code-review.yml`); fix it and push, or comment `@claude review` to re-run. `.github/CODEOWNERS` requests the
owner's review on live-control, CI and deploy files.

## Gotchas

- `flows.json` is ~1 MB: search it with `node tools/flows.js` or grep the `NN` sources instead.
- The fixture test compares new dotted strings with committed `HEAD`; it fails until a change is committed.
- Test GX takes ~70 min (slowest file); scenarios run at their `faketime` rate (`@… x60`).
- Files in `docs/archive/` and the `*-handoff*.md` docs are history, not current instructions.
