---
name: deploy-gx
description: Deploy master to the live Cerbo GX through GitHub Actions - check what the GX runs, dry run, read the compare, decide on GX-only lines, apply, confirm the new d#. Use when the user says "deploy to the GX", "deploy master", a deploy run failed or stopped, or asks whether master is deployed.
---

# Deploy master to the live GX

The live GX controls a real inverter, battery and heat pump. Deploy only when the owner asked in this session. An
approval in chat is not a GitHub approval: every manual run waits for the owner in Actions (env `victron-gx`).

## 0. Is it already deployed?
`gh run list --workflow deploy-gx-code.yml -L 4` and `gh run list --workflow test-gx.yml --branch master -L 2`.
A green Test GX run on a master push deploys that commit automatically (`workflow_run`, env `victron-gx-auto`).
A `workflow_run` deploy that "succeeded" may have skipped: the gate logs the reason (not green, not master, master
moved). The apply log ends with `GX runs d#N ... the live code equals <sha>`.

## 1. Dry run
`gh workflow run deploy-gx-code.yml --ref master -f mode=dry-run`, then tell the owner: Actions → the run →
Review deployments → victron-gx → Approve and deploy. Read the result:
`gh run view <id> --log-failed` (or `--log`), lines `live :`, `repo :`, `code differs`, `STOPPED`.

## 2. A STOPPED dry run
- **GX-only lines** ("the GX has code lines the commit does not have"): check the GX's own commit from the `live :` line
  (`[git <sha>]`). If the GX equals that commit (it was deployed from the repo), the flagged lines are the ones master
  replaced: confirm with `git diff <gx-sha> origin/master -- "<NN file>"` that every flagged node only lost lines master
  rewrote. Then apply with `allow_live_only_lines=true`. If the GX has hand edits, stop and show them to the owner
  (`node tools/gx/compare.js LIVE.b64 --commit <sha> --show <id>`); wanted lines go into the `NN` source first.
- **Added nodes:** the deploy stops on new nodes; tell the owner (backlog D1).
- **Reviewed wiring changes:** review the compare, then use manual `allow_new_wires` with the exact source IDs. Check each source's before/after wiring in a dry run of the same commit before apply. Automatic runs ignore this input.

## 3. Apply
`gh workflow run deploy-gx-code.yml --ref master -f mode=apply -f confirm=deploy-gx-code -f version=test`
(add `-f allow_live_only_lines=true` only after step 2). Ask the owner to approve, and to wait until no DHW cycle runs
(the redeploy clears the controller's in-memory state).

## 4. Confirm
The apply log: `GX runs d#N ... live code equals <sha>` and the change list. Report d#, commit, what changed, what is
not verified (Test GX state), and `Branch: master`.

Never: deploy a branch, skip the owner approval, or use `scripts/gx-deploy.ps1` against the live GX from this PC
without an explicit owner request.
