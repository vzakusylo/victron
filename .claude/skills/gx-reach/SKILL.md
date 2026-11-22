---
name: gx-reach
description: Check that the live Cerbo GX is reachable (ping, SSH port, SSH login) and give the owner the exact NR1 performance-baseline command. Use when the user says "is the GX reachable", "check GX ip", "gx reach", "run the baseline / NR1", or before any SSH-based GX tool (perf-baseline, gx-monitor, manual deploy).
---

# GX reachability check (and NR1 baseline command)

Read-only. Never deploys, never changes the GX. Addresses and key paths stay out of the repo (`secret-files` CI).

## 1. Find the addresses
Do not hard-code them in any repo file. Take them from Claude's memory note `gx-access-and-tuya-devices`
(Tailscale address of machine `einstein`, LAN address, key `~/.ssh/id_ed25519_cerbo`), or ask the owner.
Tailscale first: the LAN address does not answer from the PC on Wi-Fi.

## 2. Run the check
```powershell
.\scripts\gx-reach.ps1 -Hosts root@<tailscale-ip>,root@<lan-ip> -KeyPath "$HOME\.ssh\id_ed25519_cerbo"
```
One line per host: `ping`, `ssh-port`, `login`, then `OK` / `NO`. Exit 0 and `Use: $env:GX_SSH_HOST='…'` when one
host works; exit 1 otherwise → tell the owner to start Tailscale on the PC or join the home LAN.

## 3. NR1 baseline (only the owner runs it on the live GX; Claude gives the command)
```powershell
git pull; $env:GX_SSH_HOST='<working user@host from step 2>'; $env:GX_SSH_KEY_PATH="$HOME\.ssh\id_ed25519_cerbo"; node .\tools\gx\perf-baseline.js --minutes 15 > gx-perf-baseline.json
```
15 min, sampled every 10 s, read-only; no deploy / Node-RED restart meanwhile. The table prints to the console; do not
commit the JSON. With the owner's table: fill section 5 of `docs/node-red-refactoring-plan.md` (own branch + PR),
set NR1 Done in `BACKLOG.md`. G1 waits for this baseline.

End the answer with a `Branch:` line.
