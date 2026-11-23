# Large-task kickoff

At the start of a new large or cross-cutting task in this repository, tell the user that work is starting, briefly state the plan. Skip this kickoff for routine, small tasks; this is an in-conversation notice, not a proactive alert.

# Access

- Do not ask the owner for permission before tool calls, repository inspection, local commands, Docker, the local Test GX, Playwright/Edge on the local dashboard, GitHub reads, pushing your branch, opening a PR or enabling auto-merge after the review gate below. The owner pre-approves these when starting Copilot CLI; just do the task.
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
- **One open PR at a time.** Create each branch from a fresh `master` and keep it to its own files.
  - Don't open your PR while another PR is open: build and test locally, then wait until Claude releases it.
  - The next task waits in its branch (local commits only, no PR); after the active PR merges it is rebased on the latest origin/master and only then opened.
  - Right before opening it: `git fetch origin; git rebase origin/master`, run `sync` again (`d#`), bump `i#` once on top of master, run check and all tests.
  - Push with `--force-with-lease` if the branch was pushed before, then open the PR. Enable auto-merge after review feedback is addressed and all threads are resolved.
  - After the PR is open, merge `origin/master` in (no further rebase) if `master` moves. Merges use merge commits.
- Every infrastructure change bumps `i#` once per PR: `node tools/infra-version.js bump "Short description"` then `node tools/infra-version.js check`. See `CLAUDE.md` for the covered paths. Production-only and pure docs changes do not bump `i#`; report both versions from `node tools/flows.js version`.
- Do not change production `flows.json` or numbered `NN *.js` files in Test GX work. If a scenario exposes a production bug, mark it `expected_fail` with a reference; the fix goes in its own PR.
- **Fix every PR comment before merge:** Claude review findings of every severity, Copilot reviewer
  comments, and owner comments. Give each fix its own commit, reply on the thread with that commit,
  and resolve it. If a comment is wrong, reply with the reason and ask Claude; never silently resolve
  it. Keep auto-merge paused while any review thread remains unresolved.
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

# Model

Use the model `gpt-6.2-sol` for every task in this repository (start with `copilot --allow-all --model gpt-6.2-sol`). If the session runs on another model, say so in the first line of the report.

# Herdr workers

New tasks are started as Herdr workers (one worktree under `~\.herdr\worktrees\victron\<branch>`). Claude may type
into your pane: a correction or `progress?`. Answer in 2–5 lines (done, now, next, blockers), then continue the task.

