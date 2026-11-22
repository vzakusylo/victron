# Claude operating guide (victron)

How Claude works in this repository: the owner's standing rules, collected from Claude's memory notes and the
sessions of 2026-11-08 … 2026-11-21, so every new session (and the other Claude account on this PC) starts from the
same rules. `CLAUDE.md` is the short version; this file is the full one. Private data (hosts, IPs, keys, device IDs)
stays out of the repository: it lives in the owner's local notes and in `.secrets/`.

## 1. Session start checklist (every session, before any work)

1. `git fetch origin` and check `master`: `git log -1 origin/master`, `node tools/flows.js version` (the `d#`).
2. What runs on the GX: the last **Deploy GX code** run (`gh run list --workflow deploy-gx-code.yml -L 3`); an apply
   log ends with `GX runs d#N … live code equals <sha>`. Never work on a stale base: a branch older than master gets
   `git merge origin/master` first.
3. Open PRs and their checks: `gh pr list --state open`, `gh pr checks <N>`.
4. **Herdr**: `herdr status` must say `server: status: running`. If not, start `herdr` in its own terminal tab (it is
   the transport to every Copilot worker). Never restart a running server without the owner: it kills all workers.
   Then `herdr-task.ps1 list` / `herdr agent list` to see the workers and `read` each one.
   **Start it from Claude Code so Claude can watch it:** open a Terminal-panel tab by running `herdr` with the terminal tool `run_in_terminal` (title `herdr`, cwd = the session's working directory); Claude reads that tab with
   `read_terminal` and workers with `herdr pane read <pane>`. Check `herdr status` → `running` a few seconds later;
   the workers come back idle (sessions are kept). Keep that tab open: closing it or the app stops all workers.
   The "Herdr server" scheduled task currently fails at start (`0xC000013A`, 22 Nov); until fixed, use the tab.
   Owner commands (live GX, long runs) also go in a Terminal-panel tab or the owner's primary tab, which Claude can
   read with `read_terminal` instead of asking for pasted output.
5. `BACKLOG.md`: what is in progress, what is next.
6. Tell the owner in a few lines what is running before starting new work.

## 2. Roles and hand-off

| Who | Does |
|---|---|
| Owner | Sets priorities, approves GX deploys in GitHub Actions, approves anything destructive or outward-facing |
| Claude (one chat) | Plans, writes briefs, reviews PRs and reports, keeps `BACKLOG.md` and these docs current; implements itself only when the owner asks ("claude implement…", "claude only now") |
| Copilot (Herdr workers) | Implements on its own branch / worktree, tests, commits, pushes, opens the PR, sets auto-merge, reports |

- **Copilot model**: exactly `gpt-6.2-sol` (`gpt-sol-6.2` is rejected and silently falls back to a default).
- **Transport**: every new Copilot task is a Herdr worker started by `herdr-task.ps1 new <branch> -Base origin/master`
  (Copilot with `--allow-all --model gpt-6.2-sol`). Brief file in the worktree, `send` it, `send` corrections or
  "progress?", `read` without interrupting, `wait`, `close` after the merge. After the first `send`, `read`: a
  "Do you want to run this command?" box means the worker lacks `--allow-all` (restart it with `--resume=<session>`).
- Plain `copilot --allow-all --model gpt-6.2-sol -i '…'` in a terminal tab is the fallback; nobody but the owner can
  type into it. Never two agents on the same branch / folder.
- Herdr transport: the CLI talks JSON over a local socket to the Herdr server; the server types into the worker's
  terminal and reads its screen; status is inferred (a prompt can report "stalled" for a few seconds after a restart
  although the text arrived).

## 3. Owner's rules (standing)

1. **English everywhere**: chat, code, comments, docs, commits, PRs, reviews.
2. **Every answer that gives next steps names the branch**: last line `Branch: <name> (…)`.
3. **Tasks live only in `BACKLOG.md`** (tasks, plans, test plans, e2e cases, open PRs, deploy state, progress). Add a
   task before its branch, "in progress: <branch> / #PR" when it starts, Done with PR and `d#` in the same PR.
   Analysis / design documents (e.g. `docs/node-red-refactoring-plan.md`) are allowed when the owner asks; their tasks
   still get a `BACKLOG.md` row when they start.
4. **Branches and PRs**: each change on its own branch from fresh `origin/master`, PR into `master`, then
   `gh pr merge <N> --auto --merge`. Merge commits only, no rebase, no force-push; merge `origin/master` into a branch
   when master moved. Several PRs may be open at once. `master` is protected: required checks `check`, `tests`,
   `secret-files`, `review` (Claude review with a verdict gate), `scenarios` (Test GX).
5. **Commits and pushes by Claude only when the owner asks in that session** (owner's global rule); no
   `Co-Authored-By: Claude` trailer. The permission system enforces this: a refused push is a question for the owner.
6. **Flow changes**: edit the `NN` source or its `lib/` file, `node tools/flows.js sync` (bumps `d#`), `check`, unit
   tests; never hand-edit `flows.json`. A unit test for every changed decision, failing without the change.
7. **Test GX**: production sources are not changed in Test GX work; a found bug is `expected_fail` with a reference and
   gets its own PR. New scenario files go into the `files` matrix of `test-gx.yml`.
8. **Deploys**: a green Test GX on a master push deploys automatically (env `victron-gx-auto`). Manual: dry run, then
   apply, each approved by the owner in Actions (a chat "approve" is not a GitHub approval). A dry run that stops on
   "GX has code lines the commit does not have" is a safety stop: compare the GX commit with master
   (`git diff <gx-sha> origin/master -- <files>`); only lines the new commit replaced on purpose → apply with
   `allow_live_only_lines=true`. Apply outside a DHW cycle (a redeploy clears the controllers' in-memory state).
9. **Live GX, secrets, real backups**: no access without an explicit owner request in that session; read-only access
   when the task says so. Real backups and keys never enter the repo or the Docker image.
10. **Reviews**: first line the verdict (safe to merge / needs changes / nothing to check); what was checked
    (CI, review verdict, tests, diff); findings by severity (Medium+ fixed before merge, Low / Nit may be deferred);
    numbered steps with done criteria; last line `Branch:`. Review comments for Copilot are posted on the PR
    (`gh pr comment`), then the worker is told to read them.
11. **Grid control first**: the energy controller (grid setpoint, DVCC, VE.Bus limit, HV protection, export guard,
    tariff budget) is the most important part; nothing else may delay or break it. Grid refactoring waits for its
    Test GX gate (G0 in `docs/node-red-refactoring-plan.md`).
12. Destructive or outward-facing actions (deleting branches / data, posting, deploying, admin merges) need the owner's
    explicit yes in chat for that action.

## 4. Self-improvement rule

When something in the process costs time or goes wrong (a blocked agent, a wrong model id, a stuck deploy, a manual
relay, a repeated question, a review finding that a rule would have prevented):
1. Fix the immediate problem.
2. In the same session, update the rule where it belongs: `CLAUDE.md` (short), this guide (full),
   `docs/agent-workflow.md` (Claude ↔ Copilot loop), `.github/copilot-instructions.md` (Copilot side), a skill script,
   or Claude's memory; as a small docs PR with auto-merge, after the owner's go for the push.
3. Add one line to `docs/agent-process-log.md` (date, what happened, what changed).
4. Remove rules that turned out wrong instead of stacking exceptions.

## 5. Documenting what is going on

- `docs/agent-process-log.md`: dated, one line per process event (agent started / stopped, rule changed, incident,
  decision). Claude appends to it in the PR that changes the process, or in a docs PR at the end of a working session.
- `BACKLOG.md`: task state; `docs/heat-pump-work-log.md`: heat pump changes and findings.
- Each PR description says what changed, what was tested, what is not verified.

## 6. Known pitfalls

- A function node redeploy clears its context; an inject with "once" does not re-fire.
- `flows.json` is ~1 MB: grep the `NN` sources and `lib/` instead.
- The fixture test compares new dotted strings with committed `HEAD`: it fails until the change is committed.
- Test GX runs ~67 min (slowest file); scenarios run at their faketime rate; T1 is shortening this.
- `claude-code-action` does not run on a PR that changes `claude-code-review.yml` itself: such a PR needs an owner
  (admin) merge.
- PowerShell adds CR to piped scripts; on the GX pipe with `tr -d '\r'`. BusyBox lacks some options (`head -c`).
- Large file transfers PC → GX stall: let the GX compute and return summaries, or fetch from GitHub by commit.
