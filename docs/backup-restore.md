[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · **Backup** · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md)

# Backup & restore

> One-file backup of history and setup, restore on a new GX

The `Backup` tab creates one `.tar.gz` with everything unique to this GX device, so the full history and all setup can be restored on the same or a new device.

Included when present (`node_modules`, `.npm`, `.cache` and `/data/apps/overlay-fs` are excluded — the latter is Venus OS's own root-filesystem overlay; drivers recreate their overlays with `enable.sh`):

- `/data/home/nodered/grid-control-logs` — energy history (monthly CSV + legacy daily logs) and notification logs
- `/data/home/nodered/grid-control-config` — HV settings, controller constants, dashboard state, backup manifest
- `/data/home/nodered/.node-red/*` — Node-RED flows, credentials (+ `.config.runtime.json` with the credential secret), settings, context, library
- `/data/apps` — installed drivers incl. dbus-serialbattery (driver code + `config.ini`), and the legacy `/data/etc/dbus-serialbattery`
- `/data/grid-control-logs`, `/data/node-red` — legacy log folders
- `/data/etc/services`, `/data/rc.local`, `/data/rcS.local` — custom services / boot scripts
- `/data/conf/settings.xml` — Venus OS settings (restored only when explicitly ticked)

How it works:

- `Create backup now` writes `/data/home/nodered/grid-control-backups/grid-backup-YYYYMMDD-HHMMSS.tar.gz`; `Download` streams it via `GET /grid-backup/download?name=…`
- `Upload` (`POST /grid-backup/upload`) only stores a file as `uploaded-…tar.gz`; restoring is a separate step
- restore requires typing `RESTORE`, checks the archive (manifest present, only the paths above, no `..`), creates a `pre-restore-…` safety backup, extracts to a staging folder and copies over the live paths (files with the same name are overwritten, others are kept)
- Node-RED is restarted 5 s after a restore that included Node-RED files (option); Venus OS settings need a reboot
- `Re-enable restored drivers` (default on) runs `enable.sh` of every restored driver in `/data/apps` (e.g. `/data/apps/dbus-serialbattery/enable.sh`); reboot the GX device afterwards so the drivers start
- backups are never deleted automatically; `Delete` next to each backup removes it after a browser confirmation

New-device procedure: install Venus OS (Large) and the same extra Node-RED palette nodes (the dbus-serialbattery driver comes back from the backup), import this flow (or any flow with the Backup tab), upload the backup, restore with `Restart Node-RED` ticked, then check the Victron output nodes (VE.Bus / battery service instances can differ on new hardware).

GNU tar also skips `supervise` folders (daemontools runtime state, root-only) at any depth. On Venus OS Node-RED runs as user `nodered`, so the dashboard restore can only write the Node-RED and grid-control folders; root-owned paths (`/data/apps`, `/data/etc`, `rc.local`, `settings.xml`) and `enable.sh` need root. The Restore card then shows a ready-made SSH command for a full restore as root:

```
tar -xzf /data/home/nodered/grid-control-backups/<backup>.tar.gz -C / --exclude=data/conf/settings.xml && { [ ! -f /data/apps/dbus-serialbattery/enable.sh ] || bash /data/apps/dbus-serialbattery/enable.sh; } && reboot
```

Security note: the download and upload endpoints use Node-RED's HTTP-node security. If `httpNodeAuth` is not enabled, anyone on the LAN who can reach the Node-RED port can download a backup, and the backup contains the flow credentials.

---

← [Device, battery driver & BMS watchdog](device-driver.md) | [Agent access (MCP)](agent-mcp.md) →
