# Organizing work over Herdr (any project)

One planning agent, many implementation workers in Herdr, one open PR at a time.

## 1. Roles

| Who | Does |
|---|---|
| **Owner** | Sets priorities. Approves deploys, anything destructive or outward-facing, and anything involving secrets. |
| **Orchestrator** (one planning chat, e.g. Claude) | Picks tasks, checks for conflicts, writes briefs, sends and watches workers, reviews PRs, releases the next PR. Usually does not implement. |
| **Workers** (coding agents in Herdr panes) | Each implements one task on its own branch and worktree: code, tests, docs, commit, push, PR, fixing review comments. |
| **Scheduled check** (optional, e.g. hourly) | Keeps work moving when nobody is watching. Pushes the open PR forward, releases the next one or starts the next task, and alerts the owner on a blocker. |

## 2. Setup (once)

- **Server:** one Herdr server, started from a terminal tab the orchestrator can read. Never restart a running server
  without the owner: it kills every worker.
- **One worker per task:** its own git worktree, branch and pane (`~/.herdr/worktrees/<repo>/<branch>`, agent name
  `w-<branch>`).
- **Start workers non-interactive:** with the agent's "allow all tools" flag and a fixed model ID. Otherwise they
  stop at a permission prompt nobody can answer.
- **Rules file in the repo:** put the rules workers must follow in a file they read automatically (e.g.
  `.github/copilot-instructions.md` or `AGENTS.md`). Cover the PR rules, forbidden actions and the report format.
- **One task list** (e.g. `BACKLOG.md`): tasks, state, open PRs, progress. Nothing else.

## 3. Session start (orchestrator)

1. `git fetch`. Check the main branch tip and what is deployed.
2. Check open PRs and their checks.
3. `herdr status` must say `running`. `herdr agent list`, then read every worker's pane.
4. Read the task list. Tell the owner in a few lines what is running.

## 4. Starting a task

1. **Conflict check** against open PRs, worker branches and queued briefs:
   - **Files:** no overlap. Generated files count through their sources.
   - **Areas:** no two tasks in the same module, workflow or deploy tool.
   - **Shared counters and lists** (versions, task list, changelog) are allowed. The later PR re-syncs them after
     its rebase.
   - **Dependencies:** the task must not need an unmerged result.
   - If any check fails, queue the task or narrow it.
2. **Create the worker** from a fresh main branch: `herdr-task.ps1 new <branch> -Base origin/main -Model <id>`.
3. **Write the brief** as a file in the worktree, `.brief-<branch>.md`:
   - **Step 0:** `git fetch`, then branch from the latest main.
   - **Goal or incident:** with the evidence (run IDs, log lines, exact data).
   - **Fix:** what to change, and what *not* to touch.
   - **Tests:** including at least one that **fails without the change**.
   - **Docs and versions:** docs, version bumps and the task list row, all in the same PR.
   - **Conflict check result** and the PR rules (section 6).
   - **Forbidden actions.**
   - **Report format,** ending with `Branch: <name>`.
4. **Send it:** `send <branch> "Read .brief-<branch>.md and do all of it."`
5. **Read the pane once after sending.** If a permission prompt shows, the worker was started without "allow all":
   close it and start it again.
6. **Reuse an idle worker:** send "New task (fresh branch from origin/main): read <brief>". The worker creates the
   new branch itself.

## 5. While workers run

- **Look without interrupting:** `herdr pane read <pane>`.
- **Correct or ask for progress:** `herdr pane send-text <pane> "…"`, then `herdr pane send-keys <pane> Enter`.
  Workers answer progress requests in 2–5 lines: done, now, next, blockers.
- **Questions from a worker:** the orchestrator answers. Anything live, destructive or involving secrets goes to the
  owner. The orchestrator never approves those on the owner's behalf.
- **A "prompt stalled" error right after a send** usually means the text arrived. Check with `read`.
- **Watch for drift:** a pane showing a different branch than expected means the worker moved on, possibly to work
  started by the scheduled check.

## 6. PR flow: one open PR at a time

1. Workers may build in parallel but **hold their PR** while any PR is open.
2. When no PR is open, the orchestrator releases **one** branch. The worker then:
   1. rebases onto the latest main;
   2. regenerates generated files and bumps versions once, on top of main;
   3. runs all checks and tests;
   4. pushes, with force-with-lease only if the branch was pushed before;
   5. opens the PR and enables auto-merge.
3. **Every comment is resolved before merge:** automated review findings of any severity, other bots and the owner.
   - Each fix is a commit, followed by a reply on the thread and resolving it.
   - A wrong comment gets a reasoned reply, never a silent resolve.
4. **Release order:**
   - fixes that block deploys or CI;
   - the most critical system area;
   - the next areas, in order of importance;
   - housekeeping.
5. **If main moves after the PR opens,** merge main into the branch. Do not rebase again.

## 7. After the merge

- **Deploy:** automatic if the pipeline does it. Otherwise dry run first, the orchestrator reads the comparison,
  the owner approves the apply.
- **Close or reuse the worker:** `close <branch>` refuses if it has uncommitted changes.
- **Fix the process too:** if the process failed or cost time, fix the rule (rules file, guide, brief template) in
  the next PR and log one dated line in a process log.

## 8. Scheduled check (optional)

Each run:

1. Reads the open PRs, their checks and review threads, the Herdr server and the workers.
2. **If a PR is open:** tells its worker exactly what to fix, and makes sure auto-merge is on.
3. **If no PR is open:** releases one waiting branch. If none is waiting, it starts the next runnable task on an idle
   worker with a full brief.
4. **Alerts the owner only on a blocker:**
   - the server is down;
   - a worker is stuck on a prompt or a question;
   - a check failed twice in a row;
   - a review needs the owner's decision;
   - a conflict cannot be resolved;
   - there is nothing left to do.

   Send each blocker once, then again only after some hours.
5. Never deploys, restarts the server, pushes to main or handles secrets.

## 9. Hard limits for workers

- No pushes to the main branch, and no second open PR.
- No production or live-system access, no deploys, no secrets in the repo or in chat.
- No deleting data, remote branches or shared volumes they did not create. Each worker uses its own isolated test
  environment.
- Stay inside the task's branch, files and area.

## 10. Owner's part

- Set priorities.
- Approve deploys and code-owned reviews.
- Answer blocker alerts.
- Ask "status" for a summary.
