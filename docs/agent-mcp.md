[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · [Tariffs](tariffs-norway.md) · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · **Agent (MCP)** · [Development](development.md) · [Limitations](limitations.md)

# Agent access (MCP)

> MCP server for AI agents, Claude Code setup, victron-status skill, example answer

Node-RED also serves a [Model Context Protocol](https://modelcontextprotocol.io) server so an AI agent can read the live system state.

- endpoint: `POST <node-red base URL>/mcp` (MCP Streamable HTTP, JSON responses; `GET` → 405). Use `https://venus.local:1881/mcp` on the home network (the GX certificate is issued to `venus.local`) or `https://<GX IP>:1881/mcp` with `curl -k`; from outside reach the LAN through a VPN such as Tailscale. The VRM remote link (`https://<id>-nodered.proxyrelayN.victronenergy.com/mcp`) does **not** work for agents: the relay answers 403 "No session. Go back to VRM and retry." to anything but a logged-in browser (tested)
- access: a 48-hex-character token from `/dev/urandom`, stored in `/data/home/nodered/grid-control-config/mcp-token.txt` (created on first start, kept across restarts, included in the backup). Send `Authorization: Bearer <token>`, or `X-MCP-Token: <token>` if Node-RED HTTP basic auth already uses the `Authorization` header. Wrong / missing token → 401, disabled → 503, a foreign browser `Origin` → 403
- tools (all read-only): `get_system_overview`, `get_capacity_tariff`, `get_energy_today`, `get_solar_forecast`, `get_battery_driver_status` (also triggers a fresh check), `get_device_status` (also triggers a fresh sample), `get_bms_watchdog`, `get_settings`, `list_backups`
- the `Agent (MCP)` page shows the endpoints (`venus.local` first, the VRM link last and marked as not usable by agents), the token (show / copy / regenerate / disable), copy-ready `claude mcp add …`, `.mcp.json` and `curl` test commands, the tool list and the latest agent calls

Example (Claude Code):

```
claude mcp add --transport http victron-gx https://<id>-nodered.proxyrelayN.victronenergy.com/mcp --header "Authorization: Bearer <token>"
```

Claude Code skill: `.claude/skills/victron-status/` (`SKILL.md` + `mcp-call.mjs`) reads the status through this server without registering it — it asks for the token every time, passes it only via `MCP_TOKEN`, and trusts the GX certificate from `~/.claude/victron-gx.pem` (issued to `venus.local`, so the URL is `https://venus.local:1881/mcp`).

## Example: `/victron-status` answer

Real answer from Claude Code on 2026-10-18 (tools used: `get_system_overview`, `get_capacity_tariff`, `get_bms_watchdog`, `get_battery_driver_status`):

> Everything is working. No faults or alarms. The only `warn` is cosmetic: the driver log folders are root-only, so the check can’t read them.
>
> **System** (data is current, 0–51 s old)
>
> - Time window: OUTSIDE. No charge or discharge window is active right now.
> - Battery: 56.07 V, BMS SoC 77 %, 22 °C, current 0 A
> - Grid import 1107 W, AC load 1106 W, PV only 90 W (it’s cloudy: `SOL:CLOUDY`)
> - Grid setpoint 4950 W, charge current 0 A, input current limit 23.5 A
> - Force-charge is armed at 1350 W but not limiting. Export guard and manual discharge are off.
>
> **Capacity tariff**
>
> - Winter season (started 17 Oct), tier 2 (5 kW)
> - Today: 32.4 kWh imported, 62.1 kWh left before today’s limit
> - Today’s billable peak is 3.74 kWh (06:00 hour), so 1.26 kWh of headroom remains
> - October’s three highest peaks are 3736 / 2477 / 2005 Wh, averaging 2739 W. The month stays within tier 2 (`monthFitsTier` is true).
>
> **BMS / driver**
>
> - The BMS (LLT/JBD, 14S, 350 Ah) is connected and is the active controlling BMS (DVCC on). The watchdog status is `ok` and it hasn’t needed to repair anything.
> - MultiPlus-II is in state 3 (Bulk), mode On, with no VE.Bus error, BMS-lost or low-battery alarms
> - Cell spread is 8 mV (4.000–4.008 V), which is good
> - The driver process has been running for 11 h 54 m. No alarms on any device.
>
> Worth a look: the GX system SoC shows 100 %, but the BMS reports 77 %. The system’s active battery service is `com.victronenergy.battery/289`, not the BMS at `ttyACM0`. That may be the aggregate-batteries service or a battery monitor. If the VRM and dashboard SoC should match the BMS, check Settings → System setup → Battery monitor.

Connecting Claude Code with verified TLS (tested): the GX self-signed certificate has `CN=venus.local` and no IP in it, so use the name, export the certificate once (for example to `~/.claude/victron-gx.pem`) and start Claude Code with `NODE_EXTRA_CA_CERTS` pointing to it:

```
claude mcp add --transport http -s local victron-gx https://venus.local:1881/mcp --header "Authorization: Bearer <token>"
```

Notes: the VRM relay link can change (e.g. `proxyrelay10` → `proxyrelay15`) — copy the current one from the page. Check it once with the page's curl test from the agent's computer: a JSON tool list means the relay passes the request; an HTML page or redirect means it wants a VRM browser login, then use the LAN address. The LAN HTTPS port uses the GX self-signed certificate (Node clients need `NODE_EXTRA_CA_CERTS`).

---

← [Backup & restore](backup-restore.md) | [Development & deployment](development.md) →
