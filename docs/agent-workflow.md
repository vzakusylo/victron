# Agent workflow: Claude plans, Copilot implements

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Owner | Vadym | Sets priorities, relays messages, merges PRs, grants access to the GX | — |
| Manager / reviewer | Claude (planning chat) | Plans, splits work into branches, checks reports against GitHub (PR, CI, review, commits), gives next steps | Commit, push or open PRs unless the owner asks explicitly |
| Implementer | Copilot | Writes code, tests and docs on the named branch, pushes, opens the PR, reports back | Push to `master`, open a second PR, change production `flows.json` / `NN *.js` in Test GX work |

## Copilot worker tiers

Claude picks a tier per task with `herdr-task.ps1 new <branch> -Tier <tier>`. The repository ships the
[`tools/herdr/herdr-task.ps1`](../tools/herdr/herdr-task.ps1) launcher and
[`tools/herdr/models.json`](../tools/herdr/models.json) tier definitions. The owner's `~/.claude/skills/herdr-worker/`
copy is kept in sync. New workers use low reasoning effort unless the tier specifies otherwise.
Use `-Model` and `-Effort` to override the tier.

| Tier | Model | Reasoning effort | Use for |
|---|---|---|---|
| `small` | `gpt-6-luna` | `low` | Docs and one-file fixes |
| `standard` (default) | `gpt-6.2-sol` | `low` | Routine implementation |
| `code` | `gpt-5.3-codex` | `low` | Refactors, CI, and scripts |
| `hard` | `gpt-6.2-sol` | `medium` | Heat pump, grid, BMS, deploy-gate logic, and unclear debugging |
| `review` | `claude-sonnet-5` | `low` | Review tasks |

Check that the new worker's status bar shows the intended model. An unknown model ID falls back to Copilot's default.

**Transport: Herdr workers (since 2026-11-21).** Every new Copilot task is started as a Herdr worker, one per
branch and worktree, so Claude talks to it directly:

| Step | Command (`herdr-task.ps1` from `tools/herdr/` or the owner's `herdr-worker` skill) |
|---|---|
| Server up | `herdr status` → `running` (else start `herdr` in its own terminal; do not restart a running server without the owner) |
| Start | From the main checkout: `new <branch> -Repo (Get-Location).Path -Base origin/master -Tier <tier>` (worktree `~\.herdr\worktrees\victron\<branch>`, agent `w-<branch>`, Copilot started with `--allow-all`; without it, a prompt blocks each command) |
| Check | first `read <branch>` after the brief: if it shows "Do you want to run this command?", the worker lacks `--allow-all`: `close` and `new` again |
| Task | write `.copilot-brief-<branch>.md` in the worktree, then `send <branch> "Read .copilot-brief-<branch>.md and do all of it."` |
| Corrections / progress | `send <branch> "<correction or: progress?>"` (waits for idle / blocked and prints the answer) |
| Look | `read <branch> -Lines 150` (does not interrupt), `wait <branch>` |
| Finish | after the PR merges: `close <branch>` (refuses with uncommitted changes) |

Rules: Claude never commits in a worker's worktree; it answers a worker's question or brings it to the owner, and never
approves destructive commands on the owner's behalf. Standard-tier fallback without Herdr:
`copilot --allow-all --model gpt-6.2-sol --reasoning-effort low -i 'Read <brief> and do it'` in a terminal tab
(only the owner can type into it).

## Related documents

This page is the single description of the Claude / Copilot loop. It does not repeat these:

| Document | What it owns |
|---|---|
| [Herdr workflow guide](herdr-workflow.md) | How to organize any project over Herdr |
| [`BACKLOG.md`](../BACKLOG.md) | **All tasks, plans, test plans, open PRs, deploy state and progress** (the one task file) |
| [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) | Copilot's kickoff rule, Test GX access-scope checklist, short version of the rules below and the report template |
| [Development & deployment](development.md) | `NN *.js` ↔ `flows.json` sync, `d#` version, checks before a deploy |
| [Test GX](test-gx.md) | Test GX build, emulator API, Known limitations |

The [historical Test GX handoff](archive/test-gx-handoff-2026-11-16.md) records approvals for that task only. It does not grant standing permissions.

## Loop

```
Owner   -> Claude:  task, or Copilot report + "check"
Claude  -> Owner:   verdict + steps + Branch line
Owner   -> Copilot: Claude's steps, copied as is
Copilot -> Owner:   report (template 2)
... repeat until Claude says "ready to merge" -> owner merges
```

## Template 1: owner -> Claude (new task)

```
Task: <what is needed>
Area: <flow / page / tool>
Constraints: <deadline, "plan only, do not start", etc.>
```

## Template 2: Copilot -> owner -> Claude (report)

```
Branch: <name>
Commit: <SHA>, pushed: yes/no
PR: #<n> (open/draft) or none
Done:
- <item>
Checked:
- tests: <passed>/<total>
- test-gx-refresh.ps1: DIFF <n>, status <OK/WARN/FAIL>, reason
- manual: <what, result>
Not checked / deferred:
- <item, reason>
Outside the branch:
- <anything pushed elsewhere; should be "none">
```

The owner adds one word: **check**, **what next** or **can I merge?**

## Template 3: Claude -> owner (answer)

```
Verdict: <ready to merge | fix before merge | nothing to check>

What I checked myself:
- PR #<n>: state, head SHA, mergeable
- CI: <checks and results>
- Claude review: <verdict>
- commits / files: <what was verified>

Fix before merge (all severities):
1. <finding> -> <fix>. Done when: <test / output>

Process issues:
- <rule broken, what to do>

Steps:
1. <step>. Done when: <criterion>

Branch: <where to work>, <where to commit>, <when to open the PR>, <next branch>
```

## Control words (owner -> Claude)

| Word | Meaning |
|---|---|
| save only | Add to the backlog or plan; do not start |
| I'll fix it myself | No instructions for that item |
| don't | Drop the item |
| switch to N | Change the active plan item |

## Standing rules

- **Latest master first:** every new task starts with `git fetch origin` and `git switch -c <branch> origin/master`
  (also in a reused worker worktree); never on a stale `master` or the previous task's branch. Briefs say it as step 1.
- **Conflict check** before every new task and every push: no file / area overlap with open PRs, Herdr worker branches, queued briefs and BACKLOG "in progress"; shared counters (`d#`, `i#`, BACKLOG) only with a merge of master + re-bump; else queue it. Details: `docs/claude-operating-guide.md` §2a.

1. **One open PR at a time.** Branches may be built in parallel, but a PR opens only when no other PR is open. Right before opening it:
   - rebase on the latest `origin/master`;
   - run `sync` again (`d#`) and bump `i#` once on top;
   - run `check` and all tests;
   - push, with `--force-with-lease` if the branch was pushed before.

   Details: `docs/claude-operating-guide.md` §2a.
2. Merge with a merge commit; delete the branch on GitHub and locally afterwards.
3. Everything goes through a PR, including docs and agent rules. Nothing is pushed directly to `master`.
4. **Fix every PR comment before merge:** Claude findings of every severity, Copilot reviewer comments,
   and owner comments. Give each fix its own commit, reply on the thread with the commit, and resolve it.
   If a comment is wrong, reply with the reason and ask Claude; never silently resolve it.
   Keep auto-merge paused while any review thread remains unresolved.
5. Production `flows.json` and `NN *.js` are not changed in Test GX work. A bug found by a scenario is marked `expected_fail`; its fix gets its own PR.
6. Real backups, substitution maps and keys stay outside the repository and the Docker image.
7. Live-GX access, deleting remote branches and removing Docker data volumes need an explicit owner request. Never push directly to `master`. Local Test GX calls (`/set`, `/fail`, `/reset`) within the assigned task do not require a separate request.
8. Repository code, docs and commits are in English.
9. Keep reports short: branch, SHA, PR, `d#` and `i#`, test count, what was not checked.
10. Tasks and plans live only in [`BACKLOG.md`](../BACKLOG.md): a new task is added there before its branch, set to
    "in progress" with the branch / PR when work starts, and moved to Done with the PR and `d#` in the same PR as the
    work. No other task or plan files.
11. Infrastructure changes (paths listed in [`CLAUDE.md`](../CLAUDE.md)) bump `i#` once per PR:
    `node tools/infra-version.js bump "Short description"` and `node tools/infra-version.js check`.
    Only flow changes bump `d#`; a PR affecting both scopes bumps both counters. Pure docs and backlog need neither.
