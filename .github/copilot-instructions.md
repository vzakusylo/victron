# Large-task kickoff

At the start of a new large or cross-cutting task in this repository, tell the user that work is starting, briefly state the plan and identify any access scopes needed. Ask for required permissions before using those resources and wait for answers. Skip this kickoff for routine, small tasks; this is an in-conversation notice, not a proactive alert.

# Test automation access approval

These rules apply to tasks involving Test GX, `tools/test-gx/`, its tests, refresh/deploy rehearsal, or manual emulator/dashboard checks. They do not apply to unrelated tasks.

At the beginning of each new conversation about such a task, before the first tool call or repository inspection, determine which access scopes the task actually needs. Ask the user for each required approval using the conversation's permission-question tool, one question at a time, and wait for answers before acting. State the intended operations and effects precisely. Do not infer consent from tool availability, prior conversations, existing credentials, or the user's general task request. Do not request scopes that are unnecessary.

Choose only the relevant scopes from this checklist:

- **Repository and local commands:** read or edit the worktree, create temporary review copies, and run the required PowerShell, Node.js, Python, Git, `gh`, SSH, or archive commands.
- **Sensitive backup storage:** read the original GX backup, which may contain secrets; write sanitized backups, substitution maps, and reports only outside the repository. Never copy real secrets into the worktree.
- **Docker:** pull/build images and stop, recreate, or remove the Test GX stack and its data volume. Identify volume removal explicitly.
- **Test GX SSH:** access the test container as root, specifying whether the task needs read-only inspection or commands that change it.
- **Test GX APIs and flows:** read status/configuration; separately identify mutations such as `/set`, `/fail`, `/reset`, or deploying/removing temporary Node-RED flows.
- **Microsoft Edge / Playwright:** inspect or interact with the local dashboard or GitHub pages.
- **GitHub:** identify whether the task needs PR/diff/comment/check reads, pushing commits, or creating a PR. Merging a PR, resolving review threads, or deleting a remote branch requires a separate, explicit user request; general access approval is not enough.
- **Local Git:** identify requested commit or branch operations. Deleting a branch or worktree must be called out separately.
- **Network:** identify any required access to GitHub, npm, container registries, or upstream build sources.

If approval is declined or not given, do not use that resource; continue only with independent work that does not require it. These instructions do not replace runtime permission prompts or other security requirements.

# Workflow with the reviewer

Claude (in a separate chat) plans and reviews; you implement. The owner relays messages. Full model: `docs/agent-workflow.md`.

- Work only on the branch named in the instructions. Never push to `master`; everything goes through a PR, including docs and these rules.
- One open PR at a time. Create the next branch from a fresh `master` only after the previous PR is merged. Merges use merge commits.
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
