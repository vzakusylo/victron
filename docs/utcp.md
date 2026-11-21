# UTCP manual (agents without MCP)

The GX serves a [UTCP](https://www.utcp.io) manual next to the MCP server (`32` / `33`). An agent fetches the manual once, then calls the plain HTTP tools it lists. Source: `62 UTCP server.js`.

- `GET /utcp` — the manual (JSON): tool names, descriptions, input schemas, and one HTTP call template per tool. URLs in it are relative to the address the manual was fetched from; the token is only the placeholder `${UTCP_TOKEN}`. No host and no secret is in the manual.
- `POST /utcp/call/<tool>` — run a tool; the JSON body holds the inputs.

## Authentication

The same token as MCP (Agent (MCP) dashboard page). Send `Authorization: Bearer <token>` or `X-MCP-Token: <token>`. No token configured: 503. Wrong or missing token: 401. A browser `Origin` that does not match the `Host`: 403. Reach the GX only over the private network; keep the token out of the repository.

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

Every control call needs the token **and** `"confirm": true`. Without `confirm` the call is refused (400) and nothing is sent. A control call is also:

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
