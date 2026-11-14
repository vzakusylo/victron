# Victron secrets: required values, updates and deployment

Scope: `vzakusylo/victron` only. Never commit values, decoded files, passwords or
private keys.

**Deployment reads GitHub Actions Secrets**, not configuration from a developer's
checkout. Actions reconstructs private files and installs them on the GX. Node-RED
and standalone readers then read those installed files locally. They do not call
GitHub at runtime: GitHub Secrets is not a downloadable vault, and `gh secret list`
returns only names and timestamps. Values can be consumed only in a trusted
Actions job using `${{ secrets.NAME }}`.

## Required file secrets

All paths below are relative to `/data/home/nodered/`, except the vendor settings.
The upload directory `.secrets/` is private and git-ignored.

| GitHub secret | Private file | Purpose |
| --- | --- | --- |
| `SECRETFILE_TUYA_CLOUD_JSON` | `grid-control-config/tuya-cloud.json` | Tuya API credentials and endpoint |
| `SECRETFILE_TUYA_DEVICES_JSON` | `grid-control-config/tuya-devices.json` | Device records and local keys |
| `SECRETFILE_TUYA_DEVICES_JSON_PART_001` | Part of `tuya-devices.json` | Base64 chunk |
| `SECRETFILE_TUYA_DEVICES_JSON_PART_002` | Part of `tuya-devices.json` | Base64 chunk |
| `SECRETFILE_TUYA_DEVICES_JSON_PART_003` | Part of `tuya-devices.json` | Base64 chunk |
| `SECRETFILE_TUYA_LOCAL_SENSORS_JSON` | `grid-control-config/tuya-local-sensors.json` | Local sensor keys and connection settings |
| `SECRETFILE_TUYA_NODES_JSON` | `grid-control-config/tuya-nodes.json` | Node IDs mapped to device ID, IP and protocol |
| `SECRETFILE_EMAIL_JSON` | `grid-control-config/email.json` | SMTP credentials and delivery settings |
| `SECRETFILE_MCP_TOKEN_TXT` | `grid-control-config/mcp-token.txt` | MCP bearer token; an intentionally empty file disables MCP |
| `SECRETFILE_SETTINGS_USER_JS` | `.node-red/settings-user.js` | Persistent startup extension loading file-backed credentials |
| `SECRETFILE_FLOWS_CRED_JSON` | `.node-red/flows_cred.json` | Encrypted Node-RED credentials; recovery only |
| `SECRETFILE__CONFIG_RUNTIME_JSON` | `.node-red/.config.runtime.json` | Matching Node-RED credential-encryption secret; recovery only |
| `SECRETFILE__CONFIG_USERS_JSON` | `.node-red/.config.users.json` | Editor/user state; recovery only |
| `SECRETFILE_VENUS_SETTINGS_JS` | `/usr/lib/node_modules/node-red/venus-settings.js` | Firmware settings reference; backup only |

These 14 entries represent 11 files. The normal installer writes the seven active
files, not the four recovery/reference files. Overwriting encrypted credentials or
their runtime secret independently of the matching deployed flow can make existing
credentials unreadable. Never overwrite another firmware version's vendor settings.
Keep a [full GX backup](../docs/backup-restore.md) for flows, palette modules, drivers,
history and complete recovery; these are not included in the secret-file backup.

Tuya re-pairing can change local keys. Renew the appropriate private records and
upload them before the next deployment. Device keys and tokens must not appear in
flow sources, deployment logs or screenshots.

## Required deployment-access secrets

| Secret | How to obtain it |
| --- | --- |
| `GX_SSH_HOST` | `root@<gx-tailscale-host>` using the GX's verified Tailscale hostname/address from private notes |
| `GX_SSH_KEY` | A dedicated CI SSH private key; authorize its public key in the GX's `/root/.ssh/authorized_keys`. Do not reuse a personal private key |
| `GX_SSH_KNOWN_HOSTS` | The matching host-key line from an already trusted `known_hosts`. If using `ssh-keyscan`, independently verify its fingerprint on the GX first |
| `TS_OAUTH_CLIENT_ID` | Tailscale admin console: OAuth client with Auth Keys write scope and permission for `tag:ci` |
| `TS_OAUTH_SECRET` | The secret returned when creating that OAuth client |

The tailnet policy must allow `tag:ci` to reach the GX on TCP 22. Do not disable
SSH host-key verification or expose SSH publicly as a workaround.
`CLAUDE_CODE_OAUTH_TOKEN` is used by a different workflow, not this deployment.

Create the dedicated key with `ssh-keygen -t ed25519 -f <private-key-path>` and
authorize the `.pub` file through an existing trusted SSH connection. For unattended
CI use a dedicated key without a passphrase; restrict its network access and rotate
it separately. Keep both the private key and pinned host-key file outside Git.

## Write and update secrets

Use PowerShell 7 and the GitHub.com `gh` account authorized for this repository:

```powershell
Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$env:GH_HOST = 'github.com'
gh auth login --hostname github.com
```

Refresh all 11 files from the GX and upload them without printing values:

```powershell
pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -FromGx `
  -GxHost 'root@<gx-tailscale-host>' -SshKey "$HOME\.ssh\<gx-key-file>"
```

Replace placeholders, keeping quotes. The SSH host must already be trusted.
The collector reads one consistent file set through a single SSH connection,
but it is not a transaction with concurrent GX edits: coordinate changes first.
Use a private local directory with restricted Windows ACLs.

Alternatively, upload an already prepared flat private directory:

```powershell
pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -SecretsDir C:\private\victron-secrets
```

For individual access secrets, pipe values from private files or use the hidden
interactive prompt; PowerShell does not support the input-redirection operator `<`:

```powershell
Get-Content "$HOME\.ssh\<ci-key-file>" -Raw | gh secret set GX_SSH_KEY --repo vzakusylo/victron
'root@<gx-tailscale-host>' | gh secret set GX_SSH_HOST --repo vzakusylo/victron
Get-Content C:\private\gx-known-hosts -Raw | gh secret set GX_SSH_KNOWN_HOSTS --repo vzakusylo/victron
gh secret set TS_OAUTH_CLIENT_ID --repo vzakusylo/victron
gh secret set TS_OAUTH_SECRET --repo vzakusylo/victron
gh secret list --repo vzakusylo/victron
```

Use repository secrets for this workflow. If intentionally using environment
secrets instead, set them in `victron-gx`; those override repository values.
Never print secrets to verify them.

Synchronization is **manual, after every intended change**. First update and
verify private settings, then upload them; subsequent deployment will otherwise
restore older GitHub values. During coordinated GX work, do not collect or deploy
an intermediate state. GitHub Secrets does not provide an automatic two-way sync.

## Encoding and chunk updates

The uploader stores bytes as `base64:<encoded bytes>`; `base64:` represents an
intentionally empty file. This is transport encoding; GitHub provides encryption.
The restore script also accepts legacy unprefixed base64, or explicit `-RawJson`
for existing raw-JSON secrets.

Values over 32,000 characters use `SECRETFILE_<NAME>_PART_001`, `_PART_002`, etc.
The main secret contains a `victron-chunks-v1` manifest with the part count and
SHA-256 of the original bytes. **Upload parts before the manifest.** Restoration
checks completeness and SHA-256 before writing any file.

If a file grows beyond three parts, add the new part names to the deployment
workflow's environment. All parts listed by its manifest must be passed explicitly;
GitHub does not dynamically download secrets by name.

Uploads are not transactional. If one fails, fix the error and rerun before
deploying. Removed files and obsolete chunks are not automatically deleted;
remove obsolete names with `gh secret delete NAME --repo vzakusylo/victron` after
checking that the active manifest no longer uses them.

## Deploy exclusively from GitHub Secrets

Workflow: [`.github/workflows/deploy-victron.yml`](../.github/workflows/deploy-victron.yml).
It is manual, not a push/PR trigger. Ordinary CI receives no private file values.
Create/configure the `victron-gx` environment with required reviewers and
deployment-branch restrictions to allow only reviewed code from `master`.

After the workflow is merged into the default branch, use Actions → Deploy
Victron secrets → Run workflow, or:

```powershell
gh workflow run deploy-victron.yml --repo vzakusylo/victron --ref master -f action=check
gh run list --repo vzakusylo/victron --workflow deploy-victron.yml --limit 5
```

| Action | Effect |
| --- | --- |
| `check` (default) | Reconstructs all 11 file secrets, checks encoding/checksums and JSON/JavaScript syntax; creates the seven-file installation bundle. No GX connection or service change |
| `install` | Reconstructs from GitHub again, connects using the access secrets, installs seven active files and the two startup/validation helpers. Requires confirmation and an **already stopped** Node-RED service |

An install must be coordinated with other GX work. First take a full GX backup,
stop Node-RED through a trusted connection, and verify `svstat` reports `down`:

```sh
svc -d /service/node-red-venus
svstat /service/node-red-venus
```

Then dispatch installation:

```powershell
gh workflow run deploy-victron.yml --repo vzakusylo/victron --ref master `
  -f action=install -f confirm=overwrite-gx-private-files
```

The installer rejects a running service before changing files. It creates a
private `backup-pre-secret-deploy-<unique-suffix>` directory under `.node-red`,
sets private files to mode 600, validates the installed mappings against the
existing live flow, and restores the previous files on copy/validation failure.
It leaves Node-RED stopped, including after a rollback; inspect the outcome before
starting it explicitly:

```sh
svc -u /service/node-red-venus
svstat /service/node-red-venus
node /data/home/nodered/tools/reload-victron-secrets.js check
```

Check startup errors, device connections and fresh readings after starting.
A later `reload-victron-secrets.js reload` rereads **installed local files**, not
GitHub. It briefly restarts an already running service and checks recovery.
An empty MCP token keeps MCP disabled and requires manual device verification.

The workflow never uploads decoded files as artifacts, prints their contents,
deploys `flows.json`, or enables a stopped service. It cleans runner copies and
the dedicated temporary remote script. Routine installation does not replace
the runtime credential secret, encrypted credentials or user state.

The existing GX must already have file-secret flow references and a compatible
`settings-user.js` extension. Do not replace the newer live flow with the tracked
portable template. For first-time migration, use the helpers below on a reviewed
original flow; preserve literal empty discovery IPs and the settings exports.

## Scripts and knowledge

| Script | Use |
| --- | --- |
| [`sync-secrets.ps1`](sync-secrets.ps1) | Main update command; `-FromGx` collects all 11 files before uploading |
| [`collect-gx-secrets.ps1`](collect-gx-secrets.ps1) | Read-only trusted SSH collection; nine baseline files, or all 11 with `-IncludeNodeSettings` |
| [`push-secrets.ps1`](push-secrets.ps1) | Upload a flat private directory; include hidden files, exclude `.bak`, reject name collisions, split large values |
| [`secret-utils.ps1`](secret-utils.ps1) | GitHub.com authentication selection, encoding/upload checks and JSON validation |
| [`place-secrets.ps1`](place-secrets.ps1) | Decode explicitly mapped secret environment variables; validate chunks before writing. Default mapping restores only two Tuya files, so use the full workflow mapping for all files |
| [`install-gx-secrets.sh`](install-gx-secrets.sh) | Stopped-service installation, exact regular-file archive validation, backup, ownership/modes and rollback |
| [`deploy-victron.yml`](../.github/workflows/deploy-victron.yml) | Complete Actions environment mappings, reconstruction, Tailscale/SSH installation and cleanup |
| [`victron-secrets.js`](../tools/victron-secrets.js) | `prepare-nodes`, `prepare-flows`, exported `loadEnvironment`: validate node/device mappings and populate startup environment references |
| [`reload-victron-secrets.js`](../tools/reload-victron-secrets.js) | `check` validates installed files/mappings; `reload` validates, restarts an already running service and checks connection recovery |

On this Venus OS, Node-RED loads optional `.node-red/settings-user.js` from
`venus-settings.js`, not `.node-red/settings.js`. The extension calls
`loadEnvironment` before exporting its existing settings. Migrated Tuya nodes use
`${VICTRON_<NORMALIZED_NODE_ID>_<FIELD>}`, `storeAsCreds: false`, and no embedded
credentials. An empty discovery IP must stay a literal empty string: an empty
environment-variable substitution may leave a Node-RED reference unresolved.
Do not generate new mappings from a flow already containing these references.

Synthetic validation commands (no real upload or service restart):

```powershell
pwsh -NoProfile -File .\tests\secret-files.test.ps1
pwsh -NoProfile -File .\tests\deploy-secrets.test.ps1
node --test "tests/*.test.js"
node .\tools\flows.js check
```

Missing secret variables, malformed files, missing chunks, checksum mismatches,
untrusted SSH fingerprints and installation failures are errors, not reasons to
fall back silently to local developer configuration. Supply the missing values or
repair/re-upload the intended source, then rerun the trusted workflow.
