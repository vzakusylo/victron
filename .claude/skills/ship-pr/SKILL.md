---
name: ship-pr
description: Finish a change in this repo and ship it as a PR into master - sync flows.json and bump d#, run the checks and unit tests, update BACKLOG.md, commit, push, open the PR and turn on auto-merge. Use when the user says "ship it", "open the PR", "push and auto-merge", or a task is done and ready for review.
---

# Ship a change as a PR

Run in the worktree of the change (never on `master`). Commit and push only when the owner asked for it in this
session (owner's global rule); otherwise stop after step 4 and ask.

1. **Branch:** `git status -sb`. It must be a feature branch from `origin/master`. If `master` moved:
   `git fetch origin; git merge origin/master` (no rebase), then continue.
2. **Flows:** if any `NN *.js` / `NN *.html` changed: `node tools/flows.js sync` (bumps `d#` once), then
   `node tools/flows.js check` must print `OK`. Never edit `flows.json` by hand.
   **Infrastructure:** for the paths listed in `CLAUDE.md`, run
   `node tools/infra-version.js bump "Short description"`, then `node tools/infra-version.js check`.
3. **Tests:** `node --test "tests/*.test.js"`. All must pass. Exception: the fixture test
   "fixture network identities ... present in non-fixture HEAD" can fail only before the commit when new dotted
   strings were added; rerun it after the commit.
4. **BACKLOG.md:** the task row says "in progress: <branch> / #PR" or moves to section 6 Done with the PR and `d#`.
5. **Commit:** one clear English message (what and why, `(d#N)` for flow changes). Respect the owner's trailer rules.
6. **Push and PR:** `git push -u origin <branch>`, `gh pr create --base master --title ... --body ...` (what changed,
   tests, d#, what is not verified), then `gh pr merge <N> --auto --merge`.
7. **Report:** PR link, d# and i#, test counts, Test GX state, and `Branch: <name>`. A flow change deploys to the GX by itself
   after Test GX is green on the master push (see the deploy-gx skill).
