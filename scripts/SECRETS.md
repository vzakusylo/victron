# Victron secret files: storage, synchronization and restoration

Scope: **only `vzakusylo/victron`**, not camera-ai.
Secret values never go into Git commits or this document.

Private files on the PC / Cerbo GX are the source of truth. GitHub Actions secrets
are encrypted copies, not a readable vault or a two-way sync. Synchronization does
not deploy or change anything on the GX. The selected mode is **manual, after
each change**; there is no timer or background service.

## Completed deployment: 2026-11-14

| Item | Recorded state |
| --- | --- |
| GX | `einstein`, Node.js `v20.18.2` |
| Trusted SSH | `root@<gx-tailscale-host>` (Tailscale), `root@<gx-lan-host>` (LAN); keep real values in private, git-ignored `.secrets/` notes |
| SSH identity on the PC | `$HOME\.ssh\id_ed25519_cerbo`; stays on the PC, not in GitHub Secrets |
| Node-RED supervisor | `/service/node-red-venus` |
| Actual deployed flow | `d#179 Day / Night Grid Control`, 269 nodes; newer than this checkout's portable template |
| Migrated nodes | Heat pump, boiler valve, exchanger bypass, SA1 power meter |
| Final connection check | All four `CONNECTED`; checked across three readings after restart |
| Private file backups | 11 files represented by 14 GitHub secrets: 11 primary names plus three device-file chunks |
| Last recorded upload | 2026-11-14, approximately 13:26 UTC / 14:26 Europe/Oslo |
| Original rollback snapshot | `/data/home/nodered/.node-red/backup-file-secrets-20261114T131432165Z` |

This is a deployment record, not a live status report. The original device IDs
and keys were verified against the deployed encrypted Node-RED credentials before
switching sources. No controller functions, wiring, device IPs or protocol
versions were intentionally changed. A first activation exposed Node-RED's
empty-IP substitution behavior and was rolled back; the corrected activation
preserves automatic discovery and was then verified.

GitHub Secrets are used here as **file backups**. The running GX does not contact
GitHub to obtain passwords: it reads its private files. Restoring GitHub secrets
requires a trusted Actions step that materializes those files, followed by an
explicit deployment/restoration. No automatic restore/deploy workflow was
installed, and ordinary CI jobs were not given credentials.

## Scripts and responsibilities

| File | Purpose |
| --- | --- |
| [`scripts/sync-secrets.ps1`](sync-secrets.ps1) | Upload local copies; with `-FromGx`, collect all 11 active GX files first |
| [`scripts/collect-gx-secrets.ps1`](collect-gx-secrets.ps1) | Collect nine baseline files in one SSH session; `-IncludeNodeSettings` adds the two migration files |
| [`scripts/push-secrets.ps1`](push-secrets.ps1) | Encode and upload all eligible files in a flat private directory, splitting large files into chunks |
| [`scripts/secret-utils.ps1`](secret-utils.ps1) | Shared GitHub.com authentication handling, upload checks and JSON validation |
| [`scripts/place-secrets.ps1`](place-secrets.ps1) | Decode explicitly mapped environment variables into private files, checking chunk completeness and SHA-256 |
| [`tools/victron-secrets.js`](../tools/victron-secrets.js) | Prepare flow references/private node mappings and load connection values at Node-RED startup |
| [`tools/reload-victron-secrets.js`](../tools/reload-victron-secrets.js) | Check all 11 private files, then explicitly restart Node-RED to reload them and check device reconnection |
| [`tests/secret-files.test.ps1`](../tests/secret-files.test.ps1) | Synthetic upload/restore tests; GitHub uploads are mocked |
| [`tests/victron-secrets.test.js`](../tests/victron-secrets.test.js) | Synthetic runtime-loading, mapping, validation and discovery tests |
| [`tests/reload-victron-secrets.test.js`](../tests/reload-victron-secrets.test.js) | Synthetic file validation and supervisor/health tests; no real service is restarted |
| [`tools/flows.js`](../tools/flows.js) | Existing portable-template/source synchronization check |

These links contain the full persistent script sources. The deleted temporary
migration scripts and final live-check command are preserved in full in the
audit appendix below. Earlier committed script versions remain available with
`git show d1fe2e1:scripts/collect-gx-secrets.ps1` or
`git show 1901489:scripts/collect-gx-secrets.ps1`; use the current scripts for
normal synchronization.

## Where secrets are stored

Known private Victron files from the project documentation:

| Source on the Cerbo GX | Local upload copy | GitHub Actions secret |
| --- | --- | --- |
| `/data/home/nodered/grid-control-config/tuya-cloud.json` | `.secrets/tuya-cloud.json` | `SECRETFILE_TUYA_CLOUD_JSON` |
| `/data/home/nodered/grid-control-config/tuya-devices.json` | `.secrets/tuya-devices.json` | `SECRETFILE_TUYA_DEVICES_JSON` |
| `/data/home/nodered/grid-control-config/tuya-local-sensors.json` | `.secrets/tuya-local-sensors.json` | `SECRETFILE_TUYA_LOCAL_SENSORS_JSON` |
| `/data/home/nodered/grid-control-config/email.json` | `.secrets/email.json` | `SECRETFILE_EMAIL_JSON` |
| `/data/home/nodered/grid-control-config/mcp-token.txt` | `.secrets/mcp-token.txt` | `SECRETFILE_MCP_TOKEN_TXT` |
| `/data/home/nodered/.node-red/flows_cred.json` | `.secrets/flows_cred.json` | `SECRETFILE_FLOWS_CRED_JSON` |
| `/data/home/nodered/.node-red/.config.runtime.json` | `.secrets/.config.runtime.json` | `SECRETFILE__CONFIG_RUNTIME_JSON` |
| `/data/home/nodered/.node-red/.config.users.json` | `.secrets/.config.users.json` | `SECRETFILE__CONFIG_USERS_JSON` |
| `/usr/lib/node_modules/node-red/venus-settings.js` (vendor settings) | `.secrets/venus-settings.js` | `SECRETFILE_VENUS_SETTINGS_JS` |
| `/data/home/nodered/.node-red/settings-user.js` (persistent user extension) | `.secrets/settings-user.js` | `SECRETFILE_SETTINGS_USER_JS` |
| `/data/home/nodered/grid-control-config/tuya-nodes.json` (created during migration below) | `.secrets/tuya-nodes.json` | `SECRETFILE_TUYA_NODES_JSON` |

These files were collected from the live GX and uploaded on 2026-11-14.
Use `gh secret list` to verify current names and timestamps after each update.
The encrypted Node-RED credentials need the runtime credential secret (or its
separately configured external `credentialSecret`) to be usable after restoration;
`flows_cred.json` alone is insufficient. Check the actual GX setup.

Other private Victron files can also be placed in `.secrets/`: the script uploads
every non-backup file, including hidden files. Names become
`SECRETFILE_` plus the upper-case filename, with punctuation replaced by `_`.
Only a flat directory is accepted; filename collisions are rejected before upload.
`.bak` files are excluded. Intentionally empty files are preserved: an empty MCP
token means the server is disabled.

The `.secrets/` folder is git-ignored. An isolated worktree does not contain
private files from another checkout: copy them here or pass `-SecretsDir` pointing
to a separate private directory. Private SSH keys and account passwords remain in
`~\.ssh` / your password manager; do not collect unrelated accounts or SSH keys
into this upload directory.

These backups do not include historical `.bak` files, every previous deployment,
the full live `flows.json`, energy history, models, drivers, SSH identities or
every Venus OS setting. The existing `CLAUDE_CODE_OAUTH_TOKEN` secret was not
read or modified. Keep the [full GX backup](../docs/backup-restore.md) as well:
this file backup is not a replacement for device recovery.

## Setup and synchronization: PowerShell 7

1. Authenticate with `gh auth login --hostname github.com`. The account needs
   permission to write Actions secrets in `vzakusylo/victron`.
2. Copy the private Victron files into this checkout's `.secrets/`, without
   displaying content. For files on the GX, use `scp` with your existing trusted
   SSH connection, for example:

   ```powershell
   New-Item -ItemType Directory -Force .\.secrets | Out-Null
   scp root@venus.local:/data/home/nodered/grid-control-config/tuya-cloud.json .\.secrets\
   scp root@venus.local:/data/home/nodered/grid-control-config/tuya-devices.json .\.secrets\
   ```

   Replace `venus.local` with your verified GX SSH host if needed. Collect the
   other required files from the table individually. Never accept an unverified
   host fingerprint. Use a private destination with restricted Windows ACLs.
   Alternatively, collect the nine baseline files in the table without printing
   their content:

   ```powershell
   pwsh -NoProfile -File .\scripts\collect-gx-secrets.ps1 -GxHost root@venus.local
   ```

   This requires trusted noninteractive SSH access and every listed source file;
   a failed read does not change local copies. Add `-IncludeNodeSettings` after
   migration to collect `tuya-nodes.json` and `settings-user.js` too.
   No SSH private key is collected. On this GX, Venus OS uses the vendor
   `venus-settings.js` and optional `settings-user.js`, not `.node-red/settings.js`.
3. After changing any source file, refresh its local copy and run:

   ```powershell
   pwsh -NoProfile -File .\scripts\sync-secrets.ps1
   ```

   With a different private source directory:

   ```powershell
   pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -SecretsDir C:\private\victron-secrets
   ```

   **One command to refresh all files from the deployed GX and upload them:**

   ```powershell
   pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -FromGx `
     -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\id_ed25519_cerbo"
   ```

   Replace `<gx-tailscale-host>` with your verified Tailscale host (or use your
   verified LAN host), keeping the surrounding quotes. Store these addresses
   only in private, git-ignored notes. This remains a manual command, not a
   scheduled job. Replace the same placeholders in all commands below.

Uploads go **only to GitHub.com / vzakusylo/victron**. The scripts temporarily
ignore enterprise token environment variables, use the GitHub.com account in
`gh`'s credential store, and restore the environment afterward. No file content
is printed. File bytes are stored as `base64:<encoded bytes>`; the prefix preserves
empty files. The restore script also accepts legacy unprefixed base64.
This is transport encoding, not
encryption. GitHub encrypts uploaded Actions secrets.

Directories, name collisions and failed uploads are errors. Values longer than
32,000 characters are split into `SECRETFILE_<NAME>_PART_001`, `_PART_002`, etc.;
the main secret holds a chunk manifest with a SHA-256 checksum. This leaves room
for API encryption/encoding overhead. The live `tuya-devices.json` uses three
parts. The restore step must receive every part named by the manifest. Chunks
are uploaded before the manifest; corrupt, missing or mixed versions fail
checksum validation instead of producing a partial file.
Uploads are not transactional: if a later upload fails, earlier uploads remain
updated; fix the error and rerun. Removed source files do not delete existing
GitHub secrets automatically. Local files changed on the GX are not discovered
automatically: refresh the copies before running the command.

Verify **names and update times only**, never values:

```powershell
# For this shell, select the GitHub.com keyring account rather than an enterprise token.
Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$env:GH_HOST = 'github.com'
gh secret list --repo github.com/vzakusylo/victron
```

## Place files from secrets in a trusted Actions job

The following is an example step, **not an installed workflow**. Run it only
after checking out a reviewed revision of this repository in a trusted job.
It reconstructs all 11 recorded files; no file contents should be printed:

```yaml
- name: Place Victron private files
  shell: pwsh
  env:
    SECRETFILE_TUYA_CLOUD_JSON: ${{ secrets.SECRETFILE_TUYA_CLOUD_JSON }}
    SECRETFILE_TUYA_DEVICES_JSON: ${{ secrets.SECRETFILE_TUYA_DEVICES_JSON }}
    SECRETFILE_TUYA_DEVICES_JSON_PART_001: ${{ secrets.SECRETFILE_TUYA_DEVICES_JSON_PART_001 }}
    SECRETFILE_TUYA_DEVICES_JSON_PART_002: ${{ secrets.SECRETFILE_TUYA_DEVICES_JSON_PART_002 }}
    SECRETFILE_TUYA_DEVICES_JSON_PART_003: ${{ secrets.SECRETFILE_TUYA_DEVICES_JSON_PART_003 }}
    SECRETFILE_TUYA_LOCAL_SENSORS_JSON: ${{ secrets.SECRETFILE_TUYA_LOCAL_SENSORS_JSON }}
    SECRETFILE_TUYA_NODES_JSON: ${{ secrets.SECRETFILE_TUYA_NODES_JSON }}
    SECRETFILE_EMAIL_JSON: ${{ secrets.SECRETFILE_EMAIL_JSON }}
    SECRETFILE_MCP_TOKEN_TXT: ${{ secrets.SECRETFILE_MCP_TOKEN_TXT }}
    SECRETFILE_FLOWS_CRED_JSON: ${{ secrets.SECRETFILE_FLOWS_CRED_JSON }}
    SECRETFILE__CONFIG_RUNTIME_JSON: ${{ secrets.SECRETFILE__CONFIG_RUNTIME_JSON }}
    SECRETFILE__CONFIG_USERS_JSON: ${{ secrets.SECRETFILE__CONFIG_USERS_JSON }}
    SECRETFILE_SETTINGS_USER_JS: ${{ secrets.SECRETFILE_SETTINGS_USER_JS }}
    SECRETFILE_VENUS_SETTINGS_JS: ${{ secrets.SECRETFILE_VENUS_SETTINGS_JS }}
  run: |
    ./scripts/place-secrets.ps1 -SecretsDir ./.secrets -Files @{
      SECRETFILE_TUYA_CLOUD_JSON = 'tuya-cloud.json'
      SECRETFILE_TUYA_DEVICES_JSON = 'tuya-devices.json'
      SECRETFILE_TUYA_LOCAL_SENSORS_JSON = 'tuya-local-sensors.json'
      SECRETFILE_TUYA_NODES_JSON = 'tuya-nodes.json'
      SECRETFILE_EMAIL_JSON = 'email.json'
      SECRETFILE_MCP_TOKEN_TXT = 'mcp-token.txt'
      SECRETFILE_FLOWS_CRED_JSON = 'flows_cred.json'
      SECRETFILE__CONFIG_RUNTIME_JSON = '.config.runtime.json'
      SECRETFILE__CONFIG_USERS_JSON = '.config.users.json'
      SECRETFILE_SETTINGS_USER_JS = 'settings-user.js'
      SECRETFILE_VENUS_SETTINGS_JS = 'venus-settings.js'
    }
```

Without `-Files`, the script restores only `tuya-cloud.json` and
`tuya-devices.json`, not all files.
If the file grows to more parts, add those parts to the step's environment too.

Expose every mapped secret as an environment variable in the trusted workflow
step. Missing or malformed input fails before writing any file. Files default
to base64 input; `-RawJson` is only for existing secrets stored as raw JSON.
This is a restoration script, not a GX deployment script. On Unix it sets mode
600; on Windows use an appropriately restricted destination directory.

### Restore onto the GX

The staging folder above is not itself a restoration of the GX. An explicit
transfer/install is still required. GitHub-hosted runners do not automatically
have access to the home LAN or the GX Tailscale network; use an already trusted
network path and account. Do not make decrypted files downloadable as Actions
artifacts or publish them in logs.

For a recovery or rollback, first take a fresh full GX backup and stop Node-RED.
Wait until `svstat /service/node-red-venus` reports `down` before replacing files.
Use the source/destination table above to install the six grid-control files and
the four `.node-red` files, owned by `nodered:nodered`, with mode 600.
The eleventh file, `venus-settings.js`, is a **vendor reference backup**: do not
overwrite another firmware version's vendor settings with it. Install the
appropriate Venus OS version instead and retain the user extension.

Deploy `tools/victron-secrets.js` from a reviewed Git revision to
`/data/home/nodered/tools/victron-secrets.js`, readable by `nodered`. Restore the
matching actual flow from a full backup, or perform the first-time migration
below. Secret files alone do not restore the flow, palette modules or drivers.
Do not replace the encrypted credentials without the matching runtime credential
secret. Restore `.config.users.json` only when deliberately recovering that
instance's editor/user state.

Validate private mappings without printing values:

```sh
node -e "require('/data/home/nodered/tools/victron-secrets.js').loadEnvironment({environment:{}}); console.log('Private connection mapping validated')"
```

This check validates mappings when the flow contains file-secret references; it
is a no-op for the original credential-based template. Then start Node-RED with
`svc -u /service/node-red-venus` and check the service, all four device
connections, fresh data and startup errors. Refresh the GitHub backup only after
deciding that the restored private files are the intended source of truth.

## Make the deployed Tuya nodes read private files

Mail, Tuya cloud/device readers, local sensors and MCP already read their private
files (MCP loads its token into flow context). Four `tuya-smart-device` nodes
previously used Node-RED's encrypted credentials instead. The following **opt-in migration**
changes those four nodes to environment references populated from private files
when Node-RED starts. The migration was activated on the GX on 2026-11-14 from
the actual deployed **d#179** flow, preserving all 269 nodes. All four Tuya
connections were verified after restart. The tracked flow stays a portable
credential-based template; generating from the actual GX avoids replacing newer
deployed logic with an older checkout.

First take the existing full GX backup. Use the **actual deployed flow file** as
input, not an outdated checkout. These commands are for a **first-time migration**,
not a routine restart. Do not regenerate `tuya-nodes.json` from already migrated
nodes: their fields contain references rather than the original IP/version.
On an already migrated GX, use the retained pre-migration flow if regeneration
is necessary and write new outputs for review instead of overwriting live files.
On the GX before its first migration:

```sh
node /data/home/nodered/tools/victron-secrets.js prepare-nodes \
  /data/home/nodered/.node-red/flows.json \
  /data/home/nodered/grid-control-config/tuya-devices.json \
  /data/home/nodered/grid-control-config/tuya-nodes.json

node /data/home/nodered/tools/victron-secrets.js prepare-flows \
  /data/home/nodered/.node-red/flows.json \
  /data/home/nodered/grid-control-config/flows-file-secrets.json
```

Deploy `tools/victron-secrets.js` to the GX tools directory first. The commands
refuse to overwrite existing outputs. `prepare-nodes` matches unique device names
including the verified Smart Life aliases for the valve and meter,
and preserves the deployed IP and protocol version. A missing or ambiguous name
is an error; correct the private mapping rather than guessing device IDs.
The generated `tuya-nodes.json` maps Node-RED node IDs to `{ deviceId, deviceIp,
tuyaVersion }`; local keys stay in `tuya-devices.json`. Both files belong to
`nodered:nodered` with mode 600. Add `tuya-nodes.json` to the local backup directory
before synchronization.

On Venus OS add this to `.node-red/settings-user.js`, before `module.exports`,
without replacing existing user settings. The vendor `venus-settings.js` loads
this persistent user extension; do not edit the vendor file:

```js
require('/data/home/nodered/tools/victron-secrets.js').loadEnvironment({
    flowsFile: '/data/home/nodered/.node-red/flows.json',
    configDir: '/data/home/nodered/grid-control-config'
});
```

For a newly created `settings-user.js`, also add `module.exports = {};`.
For an existing file, keep its original exports unchanged.

Restore the private config files to `/data/home/nodered/grid-control-config`,
owned by `nodered:nodered`, mode 600. In a stopped Node-RED instance, replace its
flow file with the prepared version and restart using the GX's established
service procedure. Check all four device connections before enabling writes.
Do not import prepared nodes into a running instance that has not loaded the
environment: references would have no values. The generated flow contains only
`${VICTRON_...}` references, never IDs/keys from the secret files. Missing keys,
invalid mappings or partial migration make the loader fail instead of silently
switching to another credential source. Venus OS can catch user-settings load
errors, so inspect startup errors and device connections rather than assuming
that the entire Node-RED service will stop. Empty IPs remain literal empty strings
for UDP discovery: Node-RED cannot resolve an empty environment reference.
To change a discovery-based node to a fixed IP, set that IP in the source node
and regenerate its references; nonempty referenced IPs reload from the private
mapping at each restart.

Private values remain in files and the Node-RED process environment, not flow
context or exported function code. Rotate keys in the private files, refresh
backups, then restart Node-RED to reload Tuya connection values. Keep debug logs
private: third-party nodes can include credentials in diagnostic objects.
Rollback means restoring the pre-migration flow/settings/credential backup and
restarting; the helper is a no-op for the original credential-based flow.
Back up the updated private `settings-user.js` too. The actual rollback backup is
`/data/home/nodered/.node-red/backup-file-secrets-20261114T131432165Z`.
For this GX the supervisor is `/service/node-red-venus`: stop it with `svc -d`,
restore the original flow, credentials and runtime settings from that backup,
remove only the migration-created `settings-user.js`, and start it with `svc -u`.
This briefly stops the controller; inspect all device connections afterward.

## Routine changes and troubleshooting

For a key rotation, update the private Tuya files on the GX first. A re-paired
device can change its ID/key, so verify `tuya-nodes.json` still points at the
intended device. For connection changes, update that mapping and account for the
discovery/fixed-IP distinction described above. Restart Node-RED to reload
connection values, verify fresh device data, then run `sync-secrets.ps1 -FromGx`.
Mail, cloud readers and MCP have their existing file-loading behavior; the Tuya
startup helper does not replace those readers.

For a change to a local copy that should become live, deploy and verify it
explicitly before using `-FromGx`. That option refreshes local copies from the
GX and would overwrite a local-only edit. Conversely, synchronization without
`-FromGx` uploads local copies even if the live GX differs.

| Symptom | Action |
| --- | --- |
| SSH host-key verification fails | Use a verified saved host/identity; never disable `StrictHostKeyChecking` or accept an unverified fingerprint |
| `venus.local` is not trusted or an old LAN address times out | Use the recorded trusted Tailscale address or verified current LAN address |
| Collection fails or times out | Check connectivity, Node.js, key permissions and all required files; do not upload stale copies as though collection succeeded |
| Missing `.node-red/settings.js` | On this GX the active settings are vendor `venus-settings.js` plus optional `settings-user.js` |
| GitHub HTTP 422, value too large | Use chunk-capable `push-secrets.ps1`; direct upload of the large device file is not supported |
| Missing chunk or checksum mismatch on restoration | Pass every manifest part from the same completed upload; rerun synchronization if a previous upload was interrupted |
| Missing private mapping/key or loader error | Check exact node IDs, device mapping, file ownership/mode and protocol; do not log contents or fall back to hard-coded keys |
| `${VICTRON_...DEVICEIP}` appears in a socket error | Regenerate with the corrected helper so empty discovery IPs remain literal empty strings |
| SA1 meter times out during a restart | Inspect networking and fresh data; transient reconnects were observed with both original credentials and file-backed credentials |

The first failed migration was automatically rolled back to the original files;
the corrected attempt subsequently reconnected all four devices. The rollback
snapshot remains on the GX. Temporary activation/validation scripts in `/tmp`
were removed; the deployed startup helper and private files are persistent.

To validate the repository implementation without real secrets or GitHub writes:

```powershell
pwsh -NoProfile -File .\tests\secret-files.test.ps1
node --test "tests/*.test.js"
node .\tools\flows.js check
```

At the original migration's completion, the PowerShell tests and 44 Node.js tests passed; the portable
source/template synchronization check also passed. These tests supplement,
but do not replace, live GX connection and recovery checks.

## Detailed runbook: reread all secrets

There are three distinct operations:

| Goal | Tool/action |
| --- | --- |
| Reread the current GX private files and reload Node-RED | `node /data/home/nodered/tools/reload-victron-secrets.js reload` |
| Refresh GitHub file backups from the current GX | `scripts/sync-secrets.ps1 -FromGx` on the PC |
| Recover files held only in GitHub Secrets | A trusted Actions step exposes all mapped secrets/parts to `place-secrets.ps1`, followed by an explicit transfer/restore to the GX |

`gh secret list` shows names/timestamps, not values. There is no `gh secret get`
for downloading these values, and no GX API call that reads all GitHub secrets.
Do not put a GitHub token into Node-RED to try to work around this limitation.
The new reload tool neither reads GitHub nor uploads secrets; it works with the
private files already on the GX.

### Install/update the reload tool from this checkout

Both the existing startup helper and the new reload helper belong in the GX
tools directory. From PowerShell 7 in the repository:

```powershell
scp -i "$HOME\.ssh\id_ed25519_cerbo" -o IdentitiesOnly=yes `
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 `
  .\tools\victron-secrets.js .\tools\reload-victron-secrets.js `
  'root@<gx-tailscale-host>:/data/home/nodered/tools/'
```

Check the exit code before continuing. Use the verified LAN host
(`<gx-lan-host>`) only if that is the intended reachable GX. Do not disable host-key
verification. The helpers require Node.js; the recorded GX uses version 20.

### Step 1: validate all files without restarting

```powershell
ssh -i "$HOME\.ssh\id_ed25519_cerbo" -o IdentitiesOnly=yes `
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 `
  'root@<gx-tailscale-host>' `
  'node /data/home/nodered/tools/reload-victron-secrets.js check'
```

`check` reads the 11 files in the storage table, parses JSON, checks JavaScript
syntax without evaluating the private settings files, verifies the required
mail/cloud fields, and validates the file-backed Tuya connection mapping using
the deployed flow. It reports only file/node counts. It does not print values,
change files, restart Node-RED, send mail or contact Tuya/GitHub.

Expected summary for this GX:

```text
Validated private files: 11; file-backed Tuya nodes: 4
```

This is a local content/mapping check, not proof that SMTP/cloud credentials are
accepted remotely. An error is nonzero; fix the private files and retry before
reloading. An original credential-based flow must first undergo the documented
migration. Keep old working files/full backups before editing live secrets.

During the subsequent documentation/tool update, the reload helper was installed
on the GX and its `check` command returned the expected 11-file/four-node summary.
No additional live service restart was requested for that update; restart,
failure recovery and disabled-MCP behavior are covered by synthetic tests.

### Step 2: explicitly reload the running GX instance

**This briefly stops all Node-RED flows, including the controller.** Run it only
when that interruption is acceptable. This mode requires root:

```powershell
ssh -i "$HOME\.ssh\id_ed25519_cerbo" -o IdentitiesOnly=yes `
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 `
  'root@<gx-tailscale-host>' `
  'node /data/home/nodered/tools/reload-victron-secrets.js reload'
```

The tool validates the private files before any supervisor command, requires
the service already to be running, and records a device-health baseline through
the GX's loopback MCP endpoint. It then issues `svc -d`, waits for the supervisor
to report `down`, and issues `svc -u`. If the stop/wait step fails, it still
requests startup of the previously running service. It never enables a service
that was already stopped.

Node-RED rereads its vendor/user settings, credential/runtime/user files and
startup Tuya mappings on restart. The existing mail/cloud/local-sensor readers
retain their own file-loading behavior; this tool does not rewrite their logic
or force a mail/cloud request. Sleeping battery devices can take time to publish
a new reading.

The post-start check retries until the previously fresh connected Tuya roles
recover, or the bounded startup window is exhausted. Output contains only
role/state/staleness. Previously unhealthy roles are not silently considered
fixed: inspect every returned state. If MCP is intentionally disabled by an
empty token file, the tool checks local HTTP readiness instead and explicitly
asks for manual connection verification; it does not enable MCP.

On failed recovery the tool exits nonzero and leaves Node-RED requested to run.
It does **not** overwrite files or roll back user-edited secrets automatically.
Inspect `svstat /service/node-red-venus`, the dashboard and startup errors,
without copying credential-bearing diagnostics into chat. For bad edited
credentials, restore the known working files/full snapshot and repeat `check`
and `reload`. The audit activation script's rollback is a different,
snapshot-specific operation, not part of this reload tool.

### Step 3: refresh the backups after successful reload

When the intended configuration is live and verified:

```powershell
pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -FromGx `
  -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\id_ed25519_cerbo"
```

This is the manual GX-to-GitHub backup operation, not another restart. It
refreshes local copies before upload. Check secret names/timestamps using the
GitHub.com listing command above. GitHub Secrets still cannot be read back
outside a trusted Actions job.

If the newest values exist **only in GitHub**, reverse the recovery sequence:
materialize every file and chunk in the trusted Actions step above; transfer
them over a trusted connection to the intended GX paths; retain a current
recovery snapshot; preserve file owner/mode; then run `check` and the controlled
reload. Do not use `-FromGx` beforehand, because that would replace newer
backup values with the GX's older source files.

No existing CI jobs were changed to receive credentials. Do not expose secrets
to untrusted pull request code, log decrypted files, or publish them as artifacts.
Remove plaintext files after use on persistent runners. GitHub cannot return
secret values through its CLI/API, so retain a separate recoverable backup and
the local source files. Repository secrets are not shared with other repositories.

## Audit appendix: temporary scripts actually used

The following scripts were used only for this Victron migration. They were
copied to `/tmp`, executed over the trusted SSH connection, and removed after
completion. They are preserved here for audit/recovery context, **not as an
instruction to rerun them on the already migrated GX**. The activation script
stops Node-RED and can overwrite files; its fixed paths, original-absence check
and expected node count belong to the recorded deployment.

No passwords, device IDs, local keys, SMTP password, token or encrypted credential
contents are embedded below. The staging script reads credentials on the GX only
to compare values in memory; it prints neither the values nor decrypted JSON.

### 1. `stage-gx-secrets.js`: verify credentials and stage a rollback snapshot

The installed Node-RED credential format was inspected before using this
AES-256-CTR decoder. It is specific to that instance's runtime format and is not
a replacement for Node-RED's credential handling on other installations.
The source flow, encrypted credentials and runtime credential secret are
retained together in a mode-700 backup directory.

```js
'use strict';
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const base = '/data/home/nodered/.node-red';
const config = '/data/home/nodered/grid-control-config';
const tool = require('/data/home/nodered/tools/victron-secrets.js');
try {
    const flowBytes = fs.readFileSync(path.join(base, 'flows.json'));
    const flows = JSON.parse(flowBytes);
    const devices = JSON.parse(fs.readFileSync(path.join(config, 'tuya-devices.json')));
    const runtime = JSON.parse(fs.readFileSync(path.join(base, '.config.runtime.json')));
    const encrypted = JSON.parse(fs.readFileSync(path.join(base, 'flows_cred.json'))).$;
    if (!runtime._credentialSecret || !encrypted) throw new Error('Expected credential format unavailable.');
    const decipher = crypto.createDecipheriv('aes-256-ctr',
        crypto.createHash('sha256').update(runtime._credentialSecret).digest(),
        Buffer.from(encrypted.slice(0, 32), 'hex'));
    const credentials = JSON.parse(decipher.update(encrypted.slice(32), 'base64', 'utf8') + decipher.final('utf8'));
    const mapping = tool.prepareNodeSettings(flows, devices);
    for (const [id, setting] of Object.entries(mapping)) {
        const stored = JSON.parse(credentials[id].secretConfig);
        if (stored.deviceId !== setting.deviceId || stored.deviceKey !== devices[setting.deviceId].key) {
            throw new Error('Private mapping differs from deployed credentials for node ' + id + '.');
        }
    }
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const backup = path.join(base, 'backup-file-secrets-' + stamp);
    fs.mkdirSync(backup, { mode: 0o700 });
    for (const name of ['flows.json', 'flows_cred.json', '.config.runtime.json']) {
        fs.copyFileSync(path.join(base, name), path.join(backup, name));
        fs.chmodSync(path.join(backup, name), 0o600);
    }
    const userFile = path.join(base, 'settings-user.js');
    if (fs.existsSync(userFile)) throw new Error('Existing user settings require a reviewed merge; no deployed files changed.');
    const nodesFile = path.join(backup, 'tuya-nodes.json');
    fs.writeFileSync(nodesFile, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    const preparedFile = path.join(backup, 'flows-file-secrets.json');
    fs.writeFileSync(preparedFile, JSON.stringify(tool.prepareFlows(flows), null, 2), { mode: 0o600 });
    fs.copyFileSync(path.join(config, 'tuya-devices.json'), path.join(backup, 'tuya-devices.json'));
    fs.chmodSync(path.join(backup, 'tuya-devices.json'), 0o600);
    tool.loadEnvironment({ flowsFile: preparedFile, configDir: backup, environment: {} });
    const userSettings = "'use strict';\nrequire('/data/home/nodered/tools/victron-secrets.js').loadEnvironment();\nmodule.exports = {};\n";
    fs.writeFileSync(path.join(backup, 'settings-user.js'), userSettings, { mode: 0o600 });
    fs.writeFileSync(path.join(backup, 'original-flow.sha256'),
        crypto.createHash('sha256').update(flowBytes).digest('hex'), { mode: 0o600 });
    console.log('Verified all four device IDs and keys against deployed encrypted credentials.');
    console.log('Staged backup and migration: ' + backup);
} catch (error) {
    console.error(error.message.includes('node ') ? error.message : 'Migration staging failed; deployed files unchanged.');
    process.exitCode = 1;
}
```

### 2. `check-gx-secrets.js`: baseline and bounded reconnection check

The MCP token is read on the GX and sent only to the GX's loopback HTTP endpoint.
The returned health summary contains role/state/staleness only. A reconnect
check requires every previously healthy role to recover; it does not require a
previously unhealthy role to become healthy. The final independent check below
was used to confirm that all four roles were connected with fresh readings.

```js
'use strict';
const fs = require('fs');
const backup = '/data/home/nodered/.node-red/backup-file-secrets-20261114T131432165Z';
async function snapshot() {
    const token = fs.readFileSync('/data/home/nodered/grid-control-config/mcp-token.txt', 'utf8').trim();
    const response = await fetch('http://127.0.0.1:1880/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'get_heat_pump', arguments: {} } }), signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    if (!response.ok || !body.result || body.result.isError) throw new Error('Health endpoint unavailable.');
    const data = JSON.parse(body.result.content[0].text);
    if (!Array.isArray(data.devices)) throw new Error('No device health data.');
    return data.devices.filter(d => ['hp', 'valve', 'bypass', 'meter'].includes(d.role))
        .map(d => ({ name: d.role, state: d.state, stale: d.stale }));
}
(async () => {
    if (process.argv[2] === 'baseline') {
        const health = await snapshot();
        fs.writeFileSync(backup + '/health-before.json', JSON.stringify(health), { mode: 0o600 });
        console.log(JSON.stringify(health));
        return;
    }
    const before = JSON.parse(fs.readFileSync(backup + '/health-before.json'));
    const expected = before.filter(d => d.state === 'CONNECTED' && !d.stale);
    if (!expected.length) throw new Error('No baseline connections to verify.');
    for (let i = 0; i < 24; i++) {
        try {
            const now = await snapshot();
            if (expected.every(d => now.some(n => n.name === d.name && n.state === 'CONNECTED' && !n.stale))) {
                console.log('Previously healthy devices reconnected: ' + expected.length);
                console.log(JSON.stringify(now));
                return;
            }
        } catch { /* Service is still starting; bounded retry below. */ }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Device health did not recover within the validation window.');
})().catch(() => { console.error('GX device health verification failed.'); process.exitCode = 1; });
```

### 3. `activate-gx-secrets.sh`: guarded activation and automatic rollback

The script checks the original flow hash before stopping the service, waits for
the supervisor to report it stopped, installs the staged files with the correct
owner/mode, and validates runtime field loading and reconnection. On failure it
restores the original flow, encrypted credentials and runtime secret and removes
only the extension created by this migration. Before any reuse, review this
snapshot-specific logic and preserve any subsequently added user settings.

```sh
#!/bin/sh
set -eu
B=/data/home/nodered/.node-red/backup-file-secrets-20261114T131432165Z
N=/data/home/nodered/.node-red
C=/data/home/nodered/grid-control-config
S=/service/node-red-venus
changed=0
ok=0
cleanup() {
    if [ "$changed" = 1 ] && [ "$ok" != 1 ]; then
        echo "Migration validation failed; restoring the original Node-RED configuration."
        svc -d "$S"
        sleep 3
        cp "$B/flows.json" "$N/flows.json"
        cp "$B/flows_cred.json" "$N/flows_cred.json"
        cp "$B/.config.runtime.json" "$N/.config.runtime.json"
        rm -f "$N/settings-user.js"
        chown nodered:nodered "$N/flows.json" "$N/flows_cred.json" "$N/.config.runtime.json"
        svc -u "$S"
    fi
}
trap cleanup EXIT
node /tmp/check-gx-secrets.js baseline
node -e 'const fs=require("fs"),c=require("crypto"),b=process.argv[1];if(c.createHash("sha256").update(fs.readFileSync("/data/home/nodered/.node-red/flows.json")).digest("hex")!==fs.readFileSync(b+"/original-flow.sha256","utf8"))process.exit(1)' "$B"
test ! -e "$N/settings-user.js"
svc -d "$S"
changed=1
i=0
while svstat "$S" | grep -q ': up'; do
    i=$((i+1))
    test "$i" -lt 20
    sleep 1
done
cp "$B/tuya-nodes.json" "$C/tuya-nodes.json"
cp "$B/settings-user.js" "$N/settings-user.js"
cp "$B/flows-file-secrets.json" "$N/flows.json"
chmod 600 "$C/tuya-nodes.json" "$N/settings-user.js" "$N/flows.json"
chown nodered:nodered "$C/tuya-nodes.json" "$N/settings-user.js" "$N/flows.json"
node -e 'const fs=require("fs"); const f=JSON.parse(fs.readFileSync("/data/home/nodered/.node-red/flows.json")); const e={}; require("/data/home/nodered/tools/victron-secrets.js").loadEnvironment({environment:e}); if(f.length!==269||Object.keys(e).length!==16)process.exit(1); console.log("All four Tuya nodes resolve their private file values.")'
svc -u "$S"
node /tmp/check-gx-secrets.js
ok=1
echo "File-secret migration activated; original d179 flow and credentials retained in rollback backup."
```

Shell files copied from Windows must use LF endings. Before execution the actual
temporary activation file was normalized on the GX with:

```sh
sed -i 's/\r$//' /tmp/activate-gx-secrets.sh
```

After the first activation was rolled back, the staged flow was regenerated
using the corrected empty-IP handling, without replacing the original snapshot:

```sh
node -e 'const fs=require("fs"),b="/data/home/nodered/.node-red/backup-file-secrets-20261114T131432165Z";const f=JSON.parse(fs.readFileSync(b+"/flows.json"));fs.writeFileSync(b+"/flows-file-secrets.json",JSON.stringify(require("/data/home/nodered/tools/victron-secrets.js").prepareFlows(f),null,2));'
```

### 4. Final independent live check: three readings

This was the final read-only check from PowerShell. It neither changes settings
nor sends device commands. Each result contains only role, state and reading age:

```powershell
@'
const fs=require('fs');
const token=fs.readFileSync('/data/home/nodered/grid-control-config/mcp-token.txt','utf8').trim();
(async()=>{
    for(let i=0;i<3;i++){
        const r=await fetch('http://127.0.0.1:1880/mcp',{
            method:'POST',
            headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
                params:{name:'get_heat_pump',arguments:{}}}),
            signal:AbortSignal.timeout(10000)
        });
        const b=await r.json();
        const d=JSON.parse(b.result.content[0].text);
        console.log(JSON.stringify(d.devices
            .filter(x=>['hp','valve','bypass','meter'].includes(x.role))
            .map(x=>({role:x.role,state:x.state,age:x.ageSeconds}))));
        if(i<2)await new Promise(r=>setTimeout(r,10000));
    }
})().catch(()=>{console.error('Health query failed');process.exitCode=1;});
'@ | ssh -i "$HOME\.ssh\id_ed25519_cerbo" -o IdentitiesOnly=yes `
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 `
    'root@<gx-tailscale-host>' node
```

The first staging/activation checks ran as `node /tmp/stage-gx-secrets.js` and
`sh /tmp/activate-gx-secrets.sh` over that same trusted SSH connection.
Only the temporary files `/tmp/stage-gx-secrets.js`,
`/tmp/check-gx-secrets.js` and `/tmp/activate-gx-secrets.sh` were removed afterward.
The rollback snapshot, startup helper and real private configuration were kept.
