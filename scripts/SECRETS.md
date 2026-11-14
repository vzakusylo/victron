# Victron secret files: storage, synchronization and restoration

Scope: **only `vzakusylo/victron`**, not camera-ai.
Secret values never go into Git commits or this document.

Private files on the PC / Cerbo GX are the source of truth. GitHub Actions secrets
are encrypted copies, not a readable vault or a two-way sync. Synchronization does
not deploy or change anything on the GX. The selected mode is **manual, after
each change**; there is no timer or background service.

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
| `/data/home/nodered/.node-red/settings.js` (may contain authentication settings) | `.secrets/settings.js` | `SECRETFILE_SETTINGS_JS` |
| `/data/home/nodered/grid-control-config/tuya-nodes.json` (created during migration below) | `.secrets/tuya-nodes.json` | `SECRETFILE_TUYA_NODES_JSON` |

These rows describe **source locations and target names, not confirmation of
upload**. Only a successful script run and `gh secret list` confirm storage.
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
   Alternatively, collect the eight existing files in the table without printing
   their content:

   ```powershell
   pwsh -NoProfile -File .\scripts\collect-gx-secrets.ps1 -GxHost root@venus.local
   ```

   This requires trusted noninteractive SSH access and every listed source file;
   a failed read does not change local copies. The new `tuya-nodes.json` must be
   copied separately after migration. No SSH private key is collected.
3. After changing any source file, refresh its local copy and run:

   ```powershell
   pwsh -NoProfile -File .\scripts\sync-secrets.ps1
   ```

   With a different private source directory:

   ```powershell
   pwsh -NoProfile -File .\scripts\sync-secrets.ps1 -SecretsDir C:\private\victron-secrets
   ```

Uploads go **only to GitHub.com / vzakusylo/victron**. The scripts temporarily
ignore enterprise token environment variables, use the GitHub.com account in
`gh`'s credential store, and restore the environment afterward. No file content
is printed. File bytes are stored as `base64:<encoded bytes>`; the prefix preserves
empty files. The restore script also accepts legacy unprefixed base64.
This is transport encoding, not
encryption. GitHub encrypts uploaded Actions secrets.

Directories, name collisions, size violations and failed uploads
are errors. GitHub limits each secret to 48 KiB including the prefix and base64 overhead.
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

After checking out this repository:

```yaml
- name: Place Tuya files
  shell: pwsh
  env:
    SECRETFILE_TUYA_CLOUD_JSON: ${{ secrets.SECRETFILE_TUYA_CLOUD_JSON }}
    SECRETFILE_TUYA_DEVICES_JSON: ${{ secrets.SECRETFILE_TUYA_DEVICES_JSON }}
  run: ./scripts/place-secrets.ps1
```

This writes `.secrets/tuya-cloud.json` and `.secrets/tuya-devices.json`.
For other files, pass an explicit mapping preserving original filenames:

```powershell
.\scripts\place-secrets.ps1 -SecretsDir .\.secrets -Files @{
    SECRETFILE_EMAIL_JSON = 'email.json'
    SECRETFILE_MCP_TOKEN_TXT = 'mcp-token.txt'
    SECRETFILE_TUYA_LOCAL_SENSORS_JSON = 'tuya-local-sensors.json'
    SECRETFILE_TUYA_NODES_JSON = 'tuya-nodes.json'
    SECRETFILE_FLOWS_CRED_JSON = 'flows_cred.json'
    SECRETFILE__CONFIG_RUNTIME_JSON = '.config.runtime.json'
}
```

Expose every mapped secret as an environment variable in the trusted workflow
step. Missing or malformed input fails before writing any file. Files default
to base64 input; `-RawJson` is only for existing secrets stored as raw JSON.
This is a restoration script, not a GX deployment script. On Unix it sets mode
600; on Windows use an appropriately restricted destination directory.

## Make the deployed Tuya nodes read private files

Mail, Tuya cloud/device readers, local sensors and MCP already read their private
files (MCP loads its token into flow context). Four `tuya-smart-device` nodes use
Node-RED's encrypted credentials instead. The following **opt-in migration**
changes those four nodes to environment references populated from private files
when Node-RED starts. The current tracked/deployed `flows.json` is deliberately
unchanged until configuration and access can be verified.

First take the existing full GX backup. Use the **actual deployed flow file** as
input, not an outdated checkout. On the GX:

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
and preserves the deployed IP and protocol version. A missing or ambiguous name
is an error; correct the private mapping rather than guessing device IDs.
The generated `tuya-nodes.json` maps Node-RED node IDs to `{ deviceId, deviceIp,
tuyaVersion }`; local keys stay in `tuya-devices.json`. Both files belong to
`nodered:nodered` with mode 600. Add `tuya-nodes.json` to the local backup directory
before synchronization.

Add this to the existing private Node-RED `settings.js`, before `module.exports`,
without replacing any other settings:

```js
require('/data/home/nodered/tools/victron-secrets.js').loadEnvironment({
    flowsFile: '/data/home/nodered/.node-red/flows.json',
    configDir: '/data/home/nodered/grid-control-config'
});
```

Restore the private config files to `/data/home/nodered/grid-control-config`,
owned by `nodered:nodered`, mode 600. In a stopped Node-RED instance, replace its
flow file with the prepared version and restart using the GX's established
service procedure. Check all four device connections before enabling writes.
Do not import prepared nodes into a running instance that has not loaded the
environment: references would have no values. The generated flow contains only
`${VICTRON_...}` references, never IDs/keys from the secret files. Missing keys,
invalid mappings or partial migration stop initialization instead of silently
switching to another credential source.

Private values remain in files and the Node-RED process environment, not flow
context or exported function code. Rotate keys in the private files, refresh
backups, then restart Node-RED to reload Tuya connection values. Keep debug logs
private: third-party nodes can include credentials in diagnostic objects.
Rollback means restoring the pre-migration flow/settings/credential backup and
restarting; the helper is a no-op for the original credential-based flow.
Back up the updated private `settings.js` too.

No existing CI jobs were changed to receive credentials. Do not expose secrets
to untrusted pull request code, log decrypted files, or publish them as artifacts.
Remove plaintext files after use on persistent runners. GitHub cannot return
secret values through its CLI/API, so retain a separate recoverable backup and
the local source files. Repository secrets are not shared with other repositories.
