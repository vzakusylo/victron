---
name: deploy-gx
description: Deploy master to the live Cerbo GX through GitHub Actions - check what the GX runs, review the dry run and drift gate, apply, confirm the new d#. Use when the user says "deploy to the GX", "deploy master", a deploy run failed or stopped, or asks whether master is deployed.
---

# Deploy master to the live GX

The live GX controls a real inverter, battery and heat pump. Deploy only when the owner asked in this session. An
approval in chat is not a GitHub approval: every manual run waits for the owner in Actions (env `victron-gx`).

## 0. Is it already deployed?
`gh run list --workflow deploy-gx-code.yml -L 4` and `gh run list --workflow test-gx.yml --branch master -L 2`.
A green Test GX run on a master push deploys that commit automatically (`workflow_run`, env `victron-gx-auto`).
A `workflow_run` deploy that "succeeded" may have skipped: the gate logs the reason (not green, not master, master
moved). Look for `DEPLOYED : d#N ...` followed by `DONE: the GX flow matches <sha>`.

## 1. Dry run
`gh workflow run deploy-gx-code.yml --ref master -f mode=dry-run`, then tell the owner: Actions → the run →
Review deployments → victron-gx → Approve and deploy. Read the result:
`gh run view <id> --log-failed` (or `--log`), lines `drift gate`, `nodes added`, `nodes removed`,
`nodes changed` and `DRY RUN - nothing changed`. Changes in the Git report require no additional opt-ins.

## 2. A STOPPED dry run
- **Drift:** show the owner the baseline and `node-id field` entries. Preserve wanted changes in Git.
  If the owner explicitly approves replacing the reported drift, rerun dry run with
  `-f overwrite_drift=true` and review it before applying the same SHA with the same input.
- **Missing, split or non-Git record:** stop. The override does not bypass the need for a common Git baseline.
- **Revision conflict or unsafe window:** take a fresh dry run when the window is safe.

## 3. Apply
`gh workflow run deploy-gx-code.yml --ref master -f mode=apply -f confirm=deploy-gx-code -f version=test`
(add `-f overwrite_drift=true` only after step 2). Ask the owner to approve, and to wait until no DHW cycle runs
(the redeploy clears the controller's in-memory state).

## 4. Confirm
Check the `DEPLOYED` label, `DONE` and the health report. Report d#, commit, what changed, what is
not verified (Test GX state), and `Branch: master`.

Never: deploy a branch, skip the owner approval, or use `scripts/gx-deploy.ps1` against the live GX from this PC
without an explicit owner request.
