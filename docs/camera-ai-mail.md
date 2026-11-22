# Camera AI email alerts through the Cerbo GX

The camera AI on **omarchy** sends its email alerts **through the Cerbo GX**: it uses the same mailbox, the same SMTP
settings and the same `send-mail.js` as the heat pump alerts (node 47) and the backup mail (node 26). No mail password
is stored on omarchy.

- **Production client:** the separate repo `vzakusylo/camera-ai`, deployed on omarchy. The `camera-ai/` folder in this
  repo is a copy, and a change there does not reach production.
- **GX side:** this repo. It holds `tools/send-mail.js` and the gate `tools/camera-mail-gate.js` (#142, on the GX since d#214). Both reach
  the GX through Deploy GX code.

## How it works today (scp + remote command)

`camera_ai/alerts.py` (class `Mailer`) works in four steps:

1. It writes `{"subject": …, "text": …}` to `camera-alert-<ms>.json`, and copies the snapshot to
   `camera-alert-<ms>.jpg` if there is one.
2. `scp` copies both files to `/tmp/` on the GX (timeout 120 s).
3. `ssh` runs `node /data/home/nodered/tools/send-mail.js --file /tmp/<tag>.json [--attach /tmp/<tag>.jpg]`, then
   `rm -f` on both files (timeout 180 s).
4. It parses the last stdout line, `{ "ok": true }` or `{ "ok": false, "error": … }`.

It retries 3 times, 10 s apart, on scp errors or timeouts, because the Wi-Fi link to the GX sometimes times out.

| Setting | Where | Notes |
|---|---|---|
| Alerts on/off, labels, cooldown | `config/camera.json` → `alerts` on omarchy | defaults: `enabled`, `["person"]`, 10 min |
| GX login | `alerts.gx`, `alerts.ssh_key` | `root@<gx-host>`, `~/.ssh/id_ed25519_cerbo` on omarchy (its own key, `camera-ai@omarchy`) |
| SMTP host / user / app password / recipient | `/data/home/nodered/grid-control-config/email.json` on the GX, mode 600 | never in a repo; see the header of `tools/send-mail.js` |
| Attachment limit | `send-mail.js` `MAX_ATTACH` | 18 MB in total |

**Access:** the GX allows only root SSH logins. An **unrestricted** camera key in the GX's `authorized_keys` would
give omarchy full root on the GX, which also runs the battery and grid control. The owner decided (2026-11-22) not to
add it unrestricted and to use the restricted key below instead.

## Restricted key with a forced-command gate (#142)

The camera key may run **only** `camera-mail-gate.js`:

```text
restrict,command="/data/home/nodered/tools/camera-mail-gate.js" ssh-ed25519 <public-key-blob> camera-ai@omarchy
```

- `restrict` turns off port, agent and X11 forwarding, the pty and `~/.ssh/rc`. `command=` ignores whatever command
  the client sends, so `scp` and a shell are not possible.
- **Protocol:** one `ssh` call, with one JSON object on stdin: `{"subject": "…", "text": "…", "jpg_b64": "<optional
  base64 snapshot>"}`.
  - The gate checks the fields and enforces a size cap.
  - It writes the image to a temporary file under `/tmp` and runs `send-mail.js --file … [--attach …]`.
  - It prints that tool's single JSON line and always deletes its temporary files.
  - The remote command `check` runs `send-mail.js --check` (an SMTP login only, no mail).
  - Limits: EOF within 45 s, max 10 MiB; subject nonblank, max 200 code points, no control characters; `jpg_b64` canonical padded Base64 of a JPEG; unknown fields rejected. Exit 0 ok, 1 sender/internal failure, 2 invalid or timed-out input. Details: header of `tools/camera-mail-gate.js`.
- **Client:** `alerts.py` in `vzakusylo/camera-ai` (PR vzakusylo/camera-ai#1, branch `gx-mail-gate`) changes to this single piped `ssh` call, with no `scp`. It keeps the
  same timeouts, retries and `{ok, error}` result.

### Set up / rotate / revoke the camera key

The GX's OpenSSH 9.6 supports `restrict` and uses `/data/home/root/.ssh/authorized_keys`; `/root/.ssh` does not
exist on this GX. `.ssh` must be mode 700 and `authorized_keys` mode 600.
The [public key](../config/camera-ai.pub) has fingerprint `SHA256:91Mhj59t2c4XPqr/JElreNI8gCCSUMkU8qatAHJiPis`.

After deploying the gate, run these from the repository root in PowerShell 5.1 or 7. Set `$gx` and
`$adminKey` to the known GX SSH destination and the **administrator** identity path, not the camera's key.
The GX host key must already be trusted.

```powershell
.\scripts\gx-camera-key.ps1 -GxHost $gx -KeyPath $adminKey -Check
.\scripts\gx-camera-key.ps1 -GxHost $gx -KeyPath $adminKey -Add
.\scripts\gx-camera-key.ps1 -GxHost $gx -KeyPath $adminKey -Test
```

`-Check` is the default and read-only. It prints the path and expected fingerprint, checks the exact restricted
line, permissions, duplicates and non-ASCII bytes, and exits 1 if any check fails. The owner runs `-Add` only when
the camera key is missing. It requires an existing administrator-owned `authorized_keys`, takes a timestamped
backup before changing it, preserves unrelated keys, and checks the result. It refuses to add over a different or
ambiguous camera entry. `-Test` runs the mail gate's SMTP login check as the administrator; expect
`OK gate: {"ok":true,"check":true}`. To test the actual SSH key and forced command, also run this from omarchy:

```bash
ssh -T -o IdentitiesOnly=yes -o BatchMode=yes -i ~/.ssh/id_ed25519_cerbo root@<gx-host> check
```

Expect `{"ok":true,"check":true}` before sending one test alert. To **revoke**, run
`.\scripts\gx-camera-key.ps1 -GxHost $gx -KeyPath $adminKey -Remove` and close any existing connections using
the camera key. Removal backs up the file and deletes only entries matching the supplied key and camera label.
To **rotate**, keep the old public key available, remove it with `-Remove -PubKeyFile <old.pub>`, then add the
new Ed25519 public key (comment `camera-ai@omarchy`) with `-Add -PubKeyFile <new.pub>` after verifying its
fingerprint. Update the camera's configured identity and retest from omarchy. This order briefly interrupts alerts.
Don't edit `authorized_keys` manually while the script is running; inspect and remove a stale
`.camera-key.lock` only after confirming no key operation is active.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `scp: …` / `timeout talking to the GX` | Wi-Fi or GX not reachable from omarchy (retried 3×); check with `scripts/gx-reach.ps1` from the PC |
| `no mail settings: …email.json` | the mail settings file on the GX is missing (e.g. after a firmware reinstall); restore it, see `docs/backup-restore.md` |
| `Permission denied (publickey)` | Run `gx-camera-key.ps1 -Check` to inspect `/data/home/root/.ssh/authorized_keys`, permissions, duplicates, non-ASCII characters, and the expected fingerprint. |
| Gmail rejects the login | the app password changed; set it again with `tools/set-mail-password.js` on the GX |
