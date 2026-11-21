# UTCP manual (agents without MCP)

The GX serves a [UTCP](https://www.utcp.io) manual next to the MCP server (`32` / `33`). An agent fetches the manual once, then calls the plain HTTP tools it lists. Source: `62 UTCP server.js`.

- `GET /utcp` — the manual (JSON): tool names, descriptions, input schemas, and one HTTP call template per tool. URLs in it are relative to the address the manual was fetched from; the token is only the placeholder `${UTCP_TOKEN}`. No host and no secret is in the manual.
- `POST /utcp/call/<tool>` — run a tool; the JSON body holds the inputs.

## Authentication

The same token as MCP (Agent (MCP) dashboard page). Send `Authorization: Bearer <token>` or `X-MCP-Token: <token>`. No token configured: 503 (the endpoint is off without a token). Wrong or missing token: 401 (compared in constant time). A browser `Origin` that does not match the `Host`: 403.

**Who can reach it:** `/utcp` is served by Node-RED on the GX, so it is reachable from the home LAN and from Tailscale (or another VPN into the LAN), the same as `/mcp`. It is not reachable through the VRM remote link, and it must not be exposed to the internet. Keep the token out of the repository.

**Control switch.** Read tools need only the token. Control tools additionally need the switch **UTCP control** on the Agent (MCP) page. It is **OFF by default**, stored in `utcp-control.txt` next to the token file (so it survives a restart) and cleared when the MCP server is disabled. While it is off, every control tool (also `cancel`) answers `403 control disabled` and nothing is sent. The log line of the refusal is written to the Automation log.

The audit IP in the Automation log (`(from …)`) is the connection's own address (`req.ip`); `X-Forwarded-For` is ignored because there is no proxy in front of Node-RED and any client can set it. Only the UTCP node can write `UTCP: …` lines: node `40` accepts them only with an internal marker the dashboard does not send.

## Read tools

| Tool | Inputs | Returns |
|---|---|---|
| `get_system_overview` | none | Controller state: window, battery, grid / AC / PV power, setpoint, protections (same data as MCP `get_system_overview`). |
| `get_heat_pump_state` | none | Status line, idle cause, local control master, DHW state, heating state, readings, devices, curve. |
| `get_idle_periods` | `day` (YYYY-MM-DD, default today), `minMinutes` | Compressor-idle periods with cause, count, total and minutes per cause. |
| `get_event_lane` | `day` | The history event lane: heating / DHW / preheat / defrost / error / idle / gap segments with times and tooltip text, plus the legend counts. |
| `get_deploy_version` | none | `version` (`d#N`) and the short Git commit. |
| `get_automation_log` | `lines` (1–200, default 50), `day` | The last lines of the Automation log. |

## Control tools

Every control call needs the token, the **UTCP control** switch ON (403 otherwise) **and** `"confirm": true`. Without `confirm` the call is refused (400) and nothing is sent. A control call is also:

- refused (409) while local control is OFF (the master switch on the Heat Pump page). `cancel` is the exception: it only returns to the owner's settings;
- rate limited to one control call per 10 s (429);
- logged in the Automation log as `UTCP: …` (refusals too);
- sent as the same `ui` message the Heat Pump page sends to "Heat pump automations" (`40`), which validates the values again. Nothing here writes to a device directly.

| Tool | Inputs | Effect |
|---|---|---|
| `set_heating_mode` | `mode`: `off` / `test` / `on`, `confirm` | Heating controller mode (test decides but writes nothing). |
| `start_warm_up` | `deltaC` (0.5–5, default 2), `hours` (0.5–6, default 1), `confirm` | Raise the heating point for a while. |
| `force_boiler_run` | `confirm` | Queue a forced boiler run. |
| `cancel` | `what`: `warm_up` / `force_boiler_run`, `confirm` | Cancel it. |

A successful control call answers `{ "ok": true, "applied": "…" }`; read `get_heat_pump_state` to see the result.

## Example

```
GET  /utcp
POST /utcp/call/get_idle_periods     {"day": "2026-11-21", "minMinutes": 5}
POST /utcp/call/start_warm_up        {"deltaC": 2, "hours": 1, "confirm": true}
```
