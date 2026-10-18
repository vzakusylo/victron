[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · **Device & driver** · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md)

# Device, battery driver & BMS watchdog

> Device status page, BMS watchdog, Driver page and logs

**On this page:**

- [Device status dashboard](#device-status-dashboard)
- [BMS watchdog](#bms-watchdog)
- [Driver dashboard](#driver-dashboard)

## Device status dashboard

The `Device` tab shows the health of the GX device itself (read-only, works as the `nodered` user):

- host, model, Venus OS version, kernel, uptime
- CPU usage (sampled over 1 s from `/proc/stat`), load average, memory (used / available / cache / swap), temperatures (`/sys/class/thermal`)
- disks (`df`), network interfaces with addresses and live RX/TX rates (`/proc/net/dev`)
- TCP: listening ports with known service names, external connections (in/out), counts of established / time-wait / internal loopback connections (`/proc/net/tcp`, `tcp6`)
- top processes by CPU and by memory (`/proc/<pid>/stat` + `ps`), key Venus services (Node-RED, dbus-serialbattery, VE.Bus, system calc, GUI, MQTT, VRM logger, …) with running state, CPU and memory
- warnings for high CPU / load / memory / disk / temperature and for core services that are not running

It refreshes when the tab is opened and every 15 s while it stays open (toggle), one sampling run at a time.

Node-RED load: the Victron input nodes send every update, so the controller runs several times per second. Its trace output (output 6, which feeds the Analytics / Energy dashboards and the `DBG controller trace` debug node) is therefore throttled to one message per 5 s for sensor updates; control outputs are not throttled. The debug node is off by default — enable it only while debugging.

## BMS watchdog

After a reboot the DVCC "Controlling BMS" setting was once found empty (`com.victronenergy.system /ActiveBmsService = []`). The MultiPlus then raised `BMS connection lost` + `Low battery` and stayed in Passthru (no charging, no inverting) until the BMS was selected again by hand.

The `BMS watchdog` function (inject every 30 s → exec `dbus` CLI, works as user `nodered`):

- reads `/ActiveBmsService`, `/Settings/SystemSetup/BmsInstance`, the SerialBattery `/Connected` and the VE.Bus `/State` + BMS alarms
- while a BMS is active it remembers the exact `BmsInstance` value in `/data/home/nodered/grid-control-config/bms-watchdog-good.txt`
- if no BMS is active for 2 checks while the SerialBattery is connected, it writes the remembered value back (max once per 5 min) and raises a GX notification
- a MultiPlus still in Passthru with `BMS connection lost` while the BMS is active is only reported (restart the VE.Bus system by hand)
- its status is shown on the `Device` page

Related device setting: `BMS_TYPE = LltJbd` in `/data/apps/dbus-serialbattery/config.ini` makes the driver connect within ~1 s after boot instead of scanning every BMS type for about a minute, so the BMS is present before the MultiPlus looks for it.

## Driver dashboard

The `Driver` tab collects every check used to diagnose the battery driver (read-only, as user `nodered`; all D-Bus values come from one Python call):

- health checklist (✓ / ⚠ / ✗): serial port, driver service (`svstat`, if permitted) and process uptime, BMS on D-Bus and connected, `BMS_TYPE` set, duplicate `config.ini` keys, DVCC on, Controlling BMS / active BMS, watchdog remembered setting, MultiPlus state (8 = Passthru is an error), MultiPlus BMS alarms, battery alarms, cell balance, active alarms of all devices
- live values: SerialBattery (SoC, V, A, CCL/DCL/CVL, cells, allow flags), MultiPlus (state, mode, error, BMS alarms), system and DVCC settings, every non-zero `/Alarms` entry
- driver process command line, serial ports, effective `config.ini`
- controls: run checks / auto-refresh 10 s, `Run watchdog check now`, `Restore Controlling BMS now` (forces an immediate watchdog repair), repair-test timeline (active BMS, setting, MultiPlus state, BMS-lost alarm per refresh), log viewer for the discovered `/var/log/...` driver and serial-starter logs (50–1000 lines)
- root-only actions (restart driver, `enable.sh`, live log, set `BMS_TYPE`) are listed as SSH commands with copy buttons
- driver logs under `/var/log` are root-only on Venus OS; the page then lists them with their permissions and offers two root commands: make them readable now, or permanently via `/data/grid-control-logperm.sh` started from `/data/rc.local` (re-applies the read permission every 5 min, because logs are recreated on reboot and rotation; the helper is included in the backup)

---

← [Dashboard](dashboard.md) | [Backup & restore](backup-restore.md) →
