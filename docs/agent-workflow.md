# Agent workflow: Claude plans, Copilot implements

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Owner | Vadym | Sets priorities, relays messages, merges PRs, grants access to the GX | — |
| Manager / reviewer | Claude (planning chat) | Plans, splits work into branches, checks reports against GitHub (PR, CI, review, commits), gives next steps | Commit, push or open PRs unless the owner asks explicitly |
| Implementer | Copilot | Writes code, tests and docs on the named branch, pushes, opens the PR, reports back | Push to `master`, open a second PR, change production `flows.json` / `NN *.js` in Test GX work |

Copilot runs with model **`gpt-6.2-sol`** for every new task. The id must be exactly `gpt-6.2-sol`; in an interactive
session check the status bar or switch with `/model`.

**Transport: Herdr workers (since 2026-11-21).** Every new Copilot task is started as a Herdr worker, one per
branch and worktree, so Claude talks to it directly:

| Step | Command (`herdr-task.ps1`, owner's `herdr-worker` skill) |
|---|---|
| Server up | `herdr status` → `running` (else start `herdr` in its own terminal; do not restart a running server without the owner) |
| Start | `new <branch> -Base origin/master` (worktree `~\.herdr\worktrees\victron\<branch>`, agent `w-<branch>`, Copilot started with `--allow-all --model gpt-6.2-sol`; without `--allow-all` it blocks on a prompt per command) |
| Check | first `read <branch>` after the brief: if it shows "Do you want to run this command?", the worker lacks `--allow-all`: `close` and `new` again |
| Task | write `.copilot-brief-<branch>.md` in the worktree, then `send <branch> "Read .copilot-brief-<branch>.md and do all of it."` |
| Corrections / progress | `send <branch> "<correction or: progress?>"` (waits for idle / blocked and prints the answer) |
| Look | `read <branch> -Lines 150` (does not interrupt), `wait <branch>` |
| Finish | after the PR merges: `close <branch>` (refuses with uncommitted changes) |

Rules: Claude never commits in a worker's worktree; it answers a worker's question or brings it to the owner, and never
approves destructive commands on the owner's behalf. Fallback without Herdr: `copilot --allow-all --model gpt-6.2-sol
-i 'Read <brief> and do it'` in a terminal tab (only the owner can type into it).

## Related documents

This page is the single description of the Claude / Copilot loop. It does not repeat these:

| Document | What it owns |
|---|---|
| [`BACKLOG.md`](../BACKLOG.md) | **All tasks, plans, test plans, open PRs, deploy state and progress** (the one task file) |
| [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) | Copilot's kickoff rule, Test GX access-scope checklist, short version of the rules below and the report template |
| [Test GX handoff](test-gx-handoff-2026-11-16.md) | §3 permission register (approved scopes), §11 isolated PR review procedure, §13 next-agent checklist |
| [Development & deployment](development.md) | `NN *.js` ↔ `flows.json` sync, `d#` version, checks before a deploy |
| [Test GX](test-gx.md) | Test GX build, emulator API, Known limitations |

If a rule here and the permission register disagree, the stricter one applies. In particular, register entry 9 ("updating master") covers fast-forwarding a local `master` after a merge; it does not allow pushing commits directly to `master`.

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

Fix before merge (Medium and above):
1. <finding> -> <fix>. Done when: <test / output>

Can defer (Low / Nit):
1. <finding> -> <target branch or Known limitations>

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

- **Conflict check** before every new task and every push: no file / area overlap with open PRs, Herdr worker branches, queued briefs and BACKLOG "in progress"; shared counters (`d#`, `i#`, BACKLOG) only with a merge of master + re-bump; else queue it. Details: `docs/claude-operating-guide.md` §2a.

1. Several PRs may be open at once. Each branch starts from a fresh `master`, touches only its own files, and merges `origin/master` in before its PR is merged if `master` moved.
2. Merge with a merge commit; delete the branch on GitHub and locally afterwards.
3. Everything goes through a PR, including docs and agent rules. Nothing is pushed directly to `master`.
4. Medium or higher in changed code is fixed on the same branch. Low and Nit may move to the next branch or to Known limitations.
5. Production `flows.json` and `NN *.js` are not changed in Test GX work. A bug found by a scenario is marked `expected_fail`; its fix gets its own PR.
6. Real backups, substitution maps and keys stay outside the repository and the Docker image.
7. Live-GX access, pushing to master, deleting remote branches and removing Docker data volumes need an explicit owner request (see the [permission register](test-gx-handoff-2026-11-16.md#3-permission-register-explicitly-answered-individually)). Local Test GX calls (`/set`, `/fail`, `/reset`) and everything else in a task run without asking.
8. Repository code, docs and commits are in English.
9. Keep reports short: branch, SHA, PR, `d#` and `i#`, test count, what was not checked.
10. Tasks and plans live only in [`BACKLOG.md`](../BACKLOG.md): a new task is added there before its branch, set to
    "in progress" with the branch / PR when work starts, and moved to Done with the PR and `d#` in the same PR as the
    work. No other task or plan files.
11. Infrastructure changes (paths listed in [`CLAUDE.md`](../CLAUDE.md)) bump `i#` once per PR:
    `node tools/infra-version.js bump "Short description"` and `node tools/infra-version.js check`.
    Only flow changes bump `d#`; a PR affecting both scopes bumps both counters. Pure docs and backlog need neither.
