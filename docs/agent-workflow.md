# Agent workflow: Claude plans, Copilot implements

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Owner | Vadym | Sets priorities, relays messages, merges PRs, grants access to the GX | — |
| Manager / reviewer | Claude (planning chat) | Plans, splits work into branches, checks reports against GitHub (PR, CI, review, commits), gives next steps | Commit, push or open PRs unless the owner asks explicitly |
| Implementer | Copilot | Writes code, tests and docs on the named branch, pushes, opens the PR, reports back | Push to `master`, open a second PR, change production `flows.json` / `NN *.js` in Test GX work |

## Related documents

This page is the single description of the Claude / Copilot loop. It does not repeat these:

| Document | What it owns |
|---|---|
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

1. One open PR at a time. The next branch starts from a fresh `master` after the previous merge.
2. Merge with a merge commit; delete the branch on GitHub and locally afterwards.
3. Everything goes through a PR, including docs and agent rules. Nothing is pushed directly to `master`.
4. Medium or higher in changed code is fixed on the same branch. Low and Nit may move to the next branch or to Known limitations.
5. Production `flows.json` and `NN *.js` are not changed in Test GX work. A bug found by a scenario is marked `expected_fail`; its fix gets its own PR.
6. Real backups, substitution maps and keys stay outside the repository and the Docker image.
7. Mutating Test GX API calls (`/set`, `/fail`, `/reset`) and any access to the live GX need explicit owner permission, scoped as in the [permission register](test-gx-handoff-2026-11-16.md#3-permission-register-explicitly-answered-individually). Merging a PR, resolving review threads and deleting a remote branch always need a separate request.
8. Repository code, docs and commits are in English.
9. Keep reports short: branch, SHA, PR, test count, what was not checked.
