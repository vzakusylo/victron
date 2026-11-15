# Victron GX connector

This installation runs Node-RED on **Venus OS Large** on the Cerbo GX. It is not
a remote cloud connector: the main flow uses the local Victron nodes and the GX
system D-Bus. See [Overview](overview.md), [Device and driver](device-driver.md)
and [Deployment](gx-deploy.md).

## Interfaces and signals

Victron services are named `com.victronenergy.<type>.<connection>`. Their
`com.victronenergy.BusItem` interface exposes `GetValue` and, for writable paths,
`SetValue`. Device instances and service names can change after replacing hardware;
use service type, `/DeviceInstance`, `/ProductName` and `/Mgmt/Connection` to
identify the intended device.

| Signal | Service type / path | Direction |
|---|---|---|
| House grid import | `system` / `/Ac/Grid/L1/Power` | Read |
| House AC load | `system` / `/Ac/Consumption/L1/Power` | Read |
| Battery state of charge | `battery` / `/Soc` | Read |
| BMS net consumed amp-hours | `battery` / `/ConsumedAmphours` | Read |
| Battery voltage/current/power | `battery` / `/Dc/0/Voltage`, `/Dc/0/Current`, `/Dc/0/Power` | Read |
| Battery temperature, if exposed | `battery` / `/Dc/0/Temperature` | Read |
| PV generation | `system` / `/Dc/Pv/Power` | Read |
| Device presence | device service / `/Connected` | Read |
| ESS grid setpoint | `settings` / `/Settings/CGwacs/AcPowerSetPoint` | Write |
| DVCC maximum charge current | `settings` / `/Settings/SystemSetup/MaxChargeCurrent` | Write |
| VE.Bus input current limit | `vebus` / `/Ac/In/1/CurrentLimit` | Write |

Power is W, voltage V, current A, temperatures degrees C and SoC percent. Missing
D-Bus values mean **unavailable**, not zero. Check the service's connection and
data freshness before interpreting a value. Signs depend on the source/path;
the controller's existing sign conventions must be preserved.

The Devices model (`50 Devices model.js`) independently inventories GX services
using Python `dbus.SystemBus()` and `GetValue`; it never calls `SetValue`.
The driver page checks BMS/driver health. Local Tuya devices use a separate LAN
connector; Qingping uses MQTT. Neither is a Victron D-Bus device.

## Access and configuration

Enable Venus OS Large and Node-RED on the GX. Install/use the Victron nodes supplied
with that environment, then select the correct service and path in each node.
Keep the battery, CT and MultiPlus settings consistent with the wiring in
`flows.json`. A portable repository flow does not contain live Tuya credentials:
never replace the entire live flow with that file.

Local D-Bus access needs no cloud token. Remote administration is through the
owner's authenticated SSH connection with a checked host key; Node-RED's admin
API is accessed locally on the GX, not opened publicly. Secrets belong in the
private configuration described in [Secrets](../scripts/SECRETS.md).
The [Agent MCP](agent-mcp.md) interface is a separate authenticated HTTP service.

## Troubleshooting

Check that the service exists and `/Connected` is 1, that the physical link and
device instance are correct, and that the GX sees fresh readings. For Python
inventory failures check the `dbus` module and the Devices page's explicit D-Bus
error. For control faults inspect the Driver page, the controller's reported
limits and Node-RED logs before issuing any write.

Use `scripts/gx-monitor.ps1` for read-only health checks and the revision-guarded
deployment procedure in `docs/gx-deploy.md` for changes. Back up the live flow
and credentials, retain live-only settings, and never deploy during a DHW cycle
or defrost. Local deployments must be labelled as local snapshots, not as Git
commits.
