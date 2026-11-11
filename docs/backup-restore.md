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

## Data archive by e-mail (d#146)

The card **Data archive by e-mail** on the Backup tab sends the energy and heating data as one `.tar.gz` attachment to the address of the heat pump e-mail alerts (`grid-control-config/email.json` on the GX, see [Heat pump errors and e-mail alerts](heat-pump.md#errors-log-events-red-marks-e-mail-alerts-d145)). It is a data copy, not a device backup: settings, flows and drivers are not included.

- **Send by e-mail now** with a period: last 7 days, last 31 days or all history.
- **Weekly**: every Monday 07:00 (Europe/Oslo), the last 7 days. The inject *Data archive mail tick* checks every 15 min; a send that fails is retried every hour, at most 3 times, then the next Monday. The card shows the next run and the last result (button or weekly, size, number of files, or the error).
- Contents from `/data/home/nodered/grid-control-logs`, per UTC day of the period: `heatpump/<day>/` (heat pump recorder), `automations/<day>.jsonl` (automation log), `energy-<day>.log`, `grid-control-<day>.log`, `heatpump-<day>.log` where present; per month: `energy-<month>.csv`. "All history" packs the whole folder.
- The archive is built in `/tmp` and deleted after sending. More than 18 MB is refused (Gmail limit after encoding); then use a shorter period or a full backup download.
- Sent with `tools/send-mail.js --attach` (installed on the GX in `/data/home/nodered/tools/`). The inject *Mail data archive now (7 days)* in the flow does the same as the button.

Security note: the download and upload endpoints use Node-RED's HTTP-node security. If `httpNodeAuth` is not enabled, anyone on the LAN who can reach the Node-RED port can download a backup, and the backup contains the flow credentials.

---

← [Device, battery driver & BMS watchdog](device-driver.md) | [Agent access (MCP)](agent-mcp.md) →
