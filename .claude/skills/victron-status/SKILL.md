---
name: victron-status
description: Read the live status of the Victron Cerbo GX system (battery, grid import, capacity-tariff tier, BMS/driver health, MultiPlus state, device health) through the Node-RED MCP server. Use when the user asks how the battery / system / Victron / GX is doing, whether they stay within the grid tier, about BMS or driver problems, alarms, or for a status report. Always asks the user for the MCP token first.
---

# Victron system status (via the Node-RED MCP server)

The Cerbo GX runs an MCP server inside Node-RED (`32 MCP server.js`). This skill calls it with
`mcp-call.mjs` (next to this file) and summarises the result. All tools are read-only.

## 1. Ask for the token first

- Ask the user for the MCP token before any call, every time this skill runs, unless the user already
  gave it in this conversation. It is shown on the dashboard page **Agent (MCP)** (button "Copy token").
- Do not look for the token in files or configs (not in `~/.claude.json`, not on the device), do not
  write it to any file, and do not repeat it back in your answer.
- Pass it only through the `MCP_TOKEN` environment variable of the command.

## 2. Call the server

Default endpoint `https://venus.local:1881/mcp`; the GX self-signed certificate is trusted through
`~/.claude/victron-gx.pem` (the certificate is issued to `venus.local`, so use that name, not the IP).

PowerShell:

```powershell
$env:MCP_TOKEN = '<token>'; node .claude/skills/victron-status/mcp-call.mjs get_system_overview get_capacity_tariff get_bms_watchdog get_battery_driver_status; Remove-Item Env:MCP_TOKEN
```

Bash:

```bash
MCP_TOKEN='<token>' node .claude/skills/victron-status/mcp-call.mjs get_system_overview get_capacity_tariff get_bms_watchdog get_battery_driver_status
```

Pick the tools for the question (`list` prints all of them):

| Question | Tools |
|---|---|
| general status / "how is it doing" | `get_system_overview`, `get_capacity_tariff`, `get_bms_watchdog`, `get_battery_driver_status` |
| grid tier / kapasitetsledd / kWh today | `get_capacity_tariff`, `get_energy_today` |
| battery, BMS, driver, alarms | `get_battery_driver_status`, `get_bms_watchdog` |
| Cerbo CPU / memory / disk / services | `get_device_status` |
| solar | `get_solar_forecast`, `get_energy_today` |
| settings / constants | `get_settings` |
| backups | `list_backups` |

`get_battery_driver_status` and `get_device_status` trigger a fresh check on the GX; the script waits
and re-reads them automatically when needed.

## 3. Answer

Lead with the verdict (all fine / what is wrong), then the numbers that matter:

- window, battery voltage, grid / AC load / PV power, grid setpoint, charge current, input current limit
- tariff: season and tier, kWh today, kWh left today, today's billable peak, month top-3 average and tier
  (`monthFitsTier` false = heading above the season tier)
- driver/BMS: every check that is not `ok` (`warn` / `bad`), cell spread, active alarms,
  MultiPlus state (8 = Passthru is a problem), active BMS empty = DVCC "Controlling BMS" lost
- mention `ageSeconds` if data is older than a few minutes

Use the language the user wrote in.

## Errors

| Message | Meaning / what to tell the user |
|---|---|
| `401 Unauthorized` | wrong or regenerated token - ask for the current one |
| `403 Forbidden - No session…` | a VRM relay URL was used; agents must use the LAN / VPN address |
| `503` | MCP server disabled - enable it on the Agent (MCP) page |
| `ENOTFOUND` / timeout | this computer is not on the GX network - use the home LAN or Tailscale (`--url https://<tailscale-ip>:1881/mcp --insecure`, the certificate name will not match an IP) |
| `No CA file` | export the certificate again (Agent (MCP) page notes) or use `--insecure` once |
