# GX deploy: how to make it efficient (research, 2026-11-24)

This records the pre-change design investigation. For the shipped whole-flow path, see
[Deploying to the GX](gx-deploy.md). It uses the existing Tuya file-secret preparation on both commits;
the manual override does not skip baseline identity or revision checks.

## Summary

Today's deploy is a **three-way merge per node**: it compares the live flow, the last deployed commit and the
target commit, then patches only planned fields of planned nodes. Every new kind of flow change needs a new tool path
plus a manual opt-in:
- new nodes;
- removals;
- rewires;
- groups;
- `libs`.

That is why the GX has been stuck on **d#217** since 22 Nov:
- master is at d#230, **34 flow commits** later;
- in about 38 hours, **11 deploy runs failed**, each on a new guard, a missing opt-in or the DHW window.

**Recommendation:** deploy the **whole commit flow**, behind a **drift gate**:
- **The repo is the only truth.** If the live flow still equals the flow of the last deployed commit, POST the target
  commit's whole `flows.json` (API v2 with `rev`, `Node-RED-Deployment-Type: nodes`).
- **Live differs (someone edited on the GX):** stop, and have the owner choose to *adopt* the edit (pull it into the
  repo via a PR) or *overwrite* it (with a backup).
- **Review moves earlier.** Structural changes (nodes, wires, libs) are reviewed in the PR and tested by Test GX
  before merge, not again at deploy time with opt-ins.
- **Optional:** make GX-side edits rare by giving the editor read-only access (`adminAuth` `permissions: "read"`).

The per-node planner and `node-additions.js` (304 lines) go away. The safety parts stay:
- the rev check;
- the window and DHW gate;
- the backup and rollback;
- the modules preflight;
- the post-deploy verify.

## How it works now (origin/master, i#41)

| Part | Lines | Role |
|---|---|---|
| `tools/gx/compare.js` | 279 | live vs base vs commit; "code differs / GX-only / only in commit"; writes the plan |
| `tools/gx/node-additions.js` | 304 | additions, removals, rewires, groups; opt-in checks |
| `tools/gx/deploy.js` | 328 | on the GX: rev check, DHW gate, per-field patch, whole-node equality check, backup, POST, verify |
| `tools/gx/deploy-gate.js`, `window.js`, `verify.js`, `live-snapshot.js` | 314 | gate, defrost window, verify, snapshot |
| `.github/workflows/deploy-gx-code.yml` | 253 | inputs: `allow_live_only_lines`, `allow_new_nodes`, `allow_removed_nodes`, `allow_new_wires` |

What already works and should be kept:
- `POST /flows` with `Node-RED-Deployment-Type: nodes`, so only changed nodes restart;
- the `rev` check (`deploy.js:161`);
- the backup to `.node-red/backup-<time>-pre-d<n>/`;
- the deployment record (live flow says which commit it came from).

### Failures since 23 Nov, by cause

| Run(s) | Stop | Kind |
|---|---|---|
| several auto runs | new nodes / removals / rewires need opt-ins, and automatic runs have none | design: opt-ins can never pass automatically |
| 45265105379 | `e4766632305fb432 differs … outside the planned fields` (`libs`) | planner did not know a field |
| earlier dry runs | successive wiring stops | planner did not know a shape |
| 45352055641 | `socket hang up` on `GET /context/node/…/dhw` during a DHW cycle | transient API error, no retry; the DHW gate would have stopped the run anyway |

Every structural change hits the same pattern:
1. A flow PR adds a new structural shape and passes review and Test GX.
2. The deploy stops on it.
3. A tool PR teaches the planner that shape.
4. A new dry run follows, and the cycle starts again.

## What Node-RED gives us (official docs)

Source: [POST /flows](https://nodered.org/docs/api/admin/methods/post/flows/),
[securing Node-RED](https://nodered.org/docs/user-guide/runtime/securing-node-red),
[projects](https://nodered.org/docs/user-guide/projects/).

- **Deployment types** (header `Node-RED-Deployment-Type`):

  | Type | What restarts |
  |---|---|
  | `full` (the default) | all nodes stop, then the new configuration starts |
  | `nodes` | only modified nodes stop |
  | `flows` | only flows that contain modified nodes stop |
  | `reload` | flows are re-read from storage; all nodes restart |

  **`nodes` is the right one.** POSTing the whole flow with `nodes` restarts only what changed, so a whole-flow
  deploy is not "more disruptive" than a per-node patch.
- **Conflict detection:** with `Node-RED-API-Version: v2`, send the `rev` from `GET /flows`. A mismatch is rejected
  with **409**. Success returns the new `rev`.
- **Credentials:** the docs list three ways to send credentials, but do not say what happens when a node is POSTed
  without them. In practice, the current `deploy.js` already POSTs the full flow without credentials and the GX kept
  them (d#200 to d#217 deploys). Keep a test for this on Test GX: a node with credentials survives a whole-flow POST.
- **Read-only editor:** `adminAuth` users can have `permissions: "read"` (also as a `default` for anonymous users).
  Deploying needs `flows.write`. The docs imply, but don't state outright, that `read` blocks deploys: verify on
  Test GX.
- **Projects (git on the device):** they need `git` and `ssh-keygen` on the device, run one project at a time and use
  no git credential helper. The docs page still calls the feature a preview. Not a fit for Venus OS, and it gives no
  gating.

## Options

| | Option | Gain | Cost / risk | Verdict |
|---|---|---|---|---|
| A | Keep the per-node planner, keep widening it | nothing new to build | every new flow shape needs a tool PR and a dry-run cycle; automatic deploys stay blocked by opt-ins | **no** |
| B | **Whole-flow deploy behind a drift gate** | any reviewed, Test-GX-green commit deploys as is, automatically; ~600 lines of planner removed | GX-side edits must be adopted or overwritten explicitly | **yes** |
| C | B, plus a read-only editor on the GX | drift becomes rare, so B's gate almost never stops | owner needs an admin login for emergencies; verify `read` on Test GX | **yes, after B** |
| D | Node-RED Projects on the GX (git pull) | git history on the device | git and keys on Venus, preview feature, no gate, credentials key handling | no |
| E | Copy `flows.json` over SSH and restart the service | simplest | restarts **every** node (the grid controller drops), no rev check | no |

## Proposed design (B + C)

The gate and deploy, in order:
1. **Preflight (CI):** the target commit is on master and Test GX is green for it. Already in `deploy-gate.js`.
2. **Snapshot:** `GET /flows` (v2) gives the live flow and its `rev`.
3. **Drift gate:** normalize the live flow (stable JSON; ignore `x`, `y`, the tab's version label) and compare it to
   the normalized `flows.json` of the **deployment record's commit**:
   - **equal:** go on;
   - **different:** stop with a short diff (node ids and fields). The owner then picks one:
     - `adopt`: a tool writes the live edits into the `NN` sources on a new branch → PR → normal pipeline;
     - `overwrite=true`: manual input, backup kept.

   This reuses what `compare.js` already does for "GX-only lines verified against the deployment record".
4. **Window gate:** defrost and DHW, as now. **Change:** an automatic run that hits WAIT re-checks later (for example,
   a scheduled re-run every 15 min, up to 2 h) instead of failing.
5. **Modules preflight:** for every `libs` entry in the **target** flow, check that the module is a built-in or
   resolves on the GX, and that `functionExternalModules` is not `false`. This becomes a check of the whole flow, not
   a per-patch one.
6. **Backup:** `flows.json`, `flows_cred.json` and the live snapshot, as now.
7. **Deploy:** `POST /flows` with the target `flows.json` plus the deployment record, sent with
   `Node-RED-API-Version: v2`, `rev` and `Node-RED-Deployment-Type: nodes`. A 409 means someone deployed in between:
   stop, nothing changed.
8. **Verify:** the new `rev`, the version label and node health (`verify.js`); on failure, roll back by POSTing the
   backup the same way.
9. **API robustness:** retry idempotent GETs (snapshot, context reads) 2–3 times with a short back-off, and log which
   request failed. This avoids the `socket hang up` stop.

What goes away:
- `node-additions.js`;
- the per-field patch and whole-node equality logic in `deploy.js`;
- the plan's `patch` / `add` / `wire` / `groups` lists;
- the inputs `allow_new_nodes`, `allow_removed_nodes`, `allow_new_wires` and `allow_live_only_lines`. They are
  replaced by the drift gate with `adopt` / `overwrite`.

What reviewers still see: the deploy report lists what changes between the deployed commit and the target. It gives
node ids added, removed, rewired and patched, generated from git, for information only, not as gates.

## Migration plan (one PR at a time)

1. **API retry + logging** (small, `i#`): retries for the GETs in `deploy.js`. This unblocks the current d#230 dry run
   if the hang-up repeats.
2. **Test GX checks for the new model** (`i#`):
   - credentials survive a whole-flow POST with `nodes`;
   - a 409 on a stale `rev`;
   - `nodes` restarts only changed nodes (use a counter node).
3. **Whole-flow deploy behind the drift gate** (`i#`): the new `deploy.js` path, the `adopt` / `overwrite` inputs and
   the docs (`docs/gx-deploy.md`). Remove the opt-in inputs. Run it first as a dry run against the GX on d#217: the
   drift gate must say "equal to 0c1b770" (the earlier dry runs already proved the GX-only lines match that record).
4. **WAIT means retry later** for automatic runs (`i#`).
5. **Read-only editor** (C): test `adminAuth` `read` on Test GX, then the owner applies it to the live GX settings.
   The live GX is the owner's call (Rule 6).

Until step 3 lands, the d#230 deploy can still go out with the current tool and opt-ins once the window is SAFE.

## Open questions for the owner

- ~~Do you ever edit flows directly in the GX editor?~~ **Answered 2026-11-24: no.** So C costs nothing, and any
  drift that B's gate finds is unexpected and worth stopping for.
- Is a whole-flow deploy acceptable as the automatic path, given that Test GX is green and the PR was reviewed?
- How long may an automatic deploy wait for a SAFE window before giving up and mailing you?
