# Large-task kickoff

At the start of a new large or cross-cutting task in this repository, tell the user that work is starting, briefly state the plan. Skip this kickoff for routine, small tasks; this is an in-conversation notice, not a proactive alert.

# Access

- Do not ask the owner for permission before tool calls, repository inspection, local commands, Docker, the local Test GX, Playwright/Edge on the local dashboard, GitHub reads, pushing your branch, opening a PR or enabling auto-merge. The owner pre-approves these when starting Copilot CLI; just do the task.
- Still never, without an explicit owner request in the task text: push to `master`, access or deploy to the live GX, read the real GX backup or secrets, remove a Docker data volume, delete a remote branch.
- Real backups, substitution maps and keys stay outside the repository and the Docker image.

# Tasks, plans and progress: one file

`BACKLOG.md` is the only place for tasks, plans, test plans (unit, Test GX, e2e), open PRs, deploy state and progress.
Do not create other task or plan files. In the same PR as the work: add the task if it is new, set it to
"in progress" with the branch / PR when you start, and move it to Done with the PR number and `d#` when you finish.
Findings of an investigation go into the task's row or a sub-section of `BACKLOG.md`.

# Workflow with the reviewer

Claude (in a separate chat) plans and reviews; you implement. The owner relays messages. Full model: `docs/agent-workflow.md`.

- Work only on the branch named in the instructions. Never push to `master`; everything goes through a PR, including docs and these rules.
- Several PRs may be open at once. Create each branch from a fresh `master`, keep it to its own files, and merge `origin/master` into it (no rebase, no force-push) when `master` moves. Merges use merge commits.
- Do not change production `flows.json` or numbered `NN *.js` files in Test GX work. If a scenario exposes a production bug, mark it `expected_fail` with a reference; the fix goes in its own PR.
- Fix Medium-or-higher findings in changed code on the same branch; Low/Nit may move to the next branch or to Known limitations.
- Keep real backups, substitution maps and keys outside the repository and the Docker image.
- Repository code, docs and commit messages are in English.
- End every task with a short report in this format:

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
