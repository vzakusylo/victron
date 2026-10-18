// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `32 MCP server.js` and the embedded `func` for "MCP server"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Model Context Protocol (MCP) server so an AI agent (e.g. Claude Code) can read the system state.
// - Transport: MCP "Streamable HTTP" with plain JSON responses: `POST <node-red>/mcp` carries one
//   JSON-RPC 2.0 request (or a batch); `GET`/`DELETE /mcp` -> 405 (no server-initiated stream).
// - Methods: initialize, notifications/* (202), ping, tools/list, tools/call.
// - All tools are READ-ONLY. They return the latest data from flow context; the driver / device tools
//   also trigger a background refresh of those pages (call again a few seconds later for fresh data).
// Security:
// - every request needs the token from /data/home/nodered/grid-control-config/mcp-token.txt
//   (flow `mcpToken`, managed by "MCP page"): `Authorization: Bearer <token>` or `X-MCP-Token: <token>`
//   (the latter for setups where Node-RED HTTP basic auth already uses the Authorization header)
// - no token configured -> 503 (server disabled); wrong token -> 401
// - a browser `Origin` that does not match the Host is rejected (DNS-rebinding protection)
// Inputs:
// - msg from "POST /mcp" / "GET /mcp" (http in)
// Outputs (3):
// - output 1 -> http response
// - output 2 -> "Build device status" (refresh trigger)
// - output 3 -> "Driver checks dashboard" (refresh trigger)
// Flow context:
// - reads dashboardControllerTrace, dailySummary, dashboardLiveHour, solarForecastToday,
//   deviceStatusState, driverDashboardState, bmsWatchdogState, highVoltageSettings,
//   controllerConstantsOverrides, backupDashboardState, mcpToken
// - writes mcpState.calls (last calls, shown on the "Agent (MCP)" page)
// Change notes:
// 1. Initial version.
// 2. The call log uses X-Forwarded-For / X-Real-IP (Venus proxies Node-RED, so req.ip is 127.0.0.1).
// ==========================

const SERVER_NAME = 'victron-grid-control';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_CALL_LOG = 30;
const INSTRUCTIONS = [
    'Victron ESS on a Cerbo GX (Venus OS) controlled by Node-RED for Norwegian capacity-based grid tariffs.',
    'Battery: 14S NMC pack with a JBD BMS read by the dbus-serialbattery driver; inverter/charger: MultiPlus-II 48/5000.',
    'The controller holds the ESS grid setpoint at a season plan (summer tier 1 <= 2 kW, winter tier 2 <= 5 kW; night hours billed at 70 %),',
    'charges the battery in night/morning windows and protects against high voltage and grid export.',
    'All tools are read-only. Start with get_system_overview; use get_battery_driver_status when something looks wrong with the battery/BMS.'
].join(' ');

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const REFRESH_ARGS = {
    type: 'object',
    properties: { refresh: { type: 'boolean', description: 'Also trigger a fresh check in the background (default true). Call again after ~5 s to read it.' } },
    additionalProperties: false
};

function ageSeconds(isoOrTs) {
    const ts = typeof isoOrTs === 'number' ? isoOrTs : Date.parse(isoOrTs || '');
    return Number.isFinite(ts) ? Math.round((Date.now() - ts) / 1000) : null;
}

function pick(source, keys) {
    const out = {};
    keys.forEach(key => {
        if (source && source[key] !== undefined) {
            out[key] = source[key];
        }
    });
    return out;
}

const TOOLS = [
    {
        name: 'get_system_overview',
        title: 'System overview',
        description: 'Live controller state: active window, battery voltage and consumed Ah, grid / AC load / PV power, ESS grid setpoint, DVCC charge current, VE.Bus input current limit, protections (high voltage, export guard, force charge, manual discharge) and active limit flags.',
        inputSchema: NO_ARGS,
        run() {
            const trace = flow.get('dashboardControllerTrace');
            if (!trace) {
                return { available: false, note: 'No controller trace yet (Node-RED just started?).' };
            }
            return Object.assign({ ageSeconds: ageSeconds(trace.timestamp) }, pick(trace, [
                'timestamp', 'window', 'batteryVoltage', 'consumedAhDeficit', 'storedGridPowerW', 'gridPowerSignedW',
                'storedAcLoadPowerW', 'storedPvChargerPowerW', 'solarGenerationW', 'baseScheduleSetpoint', 'finalGridSetpoint',
                'finalChargeCurrent', 'currentChargingPowerW', 'gridCurrentLimitA', 'voltageLimitActive', 'exportGuard',
                'forceChargeEnabled', 'forceChargeLimiterActive', 'effectiveForceChargeGridW', 'manualDischarge',
                'gridSupportMode', 'adaptiveGridSupportActive', 'adaptiveGridSupportW', 'gridRestoreAhNeeded',
                'forecastRestoreAh', 'boostActive', 'limitFlags'
            ]));
        }
    },
    {
        name: 'get_capacity_tariff',
        title: 'Capacity tariff status',
        description: 'Active tariff season (summer/winter) and tier, both season profiles (setpoints and safe grid current), grid import today, energy left today at the season plan, today\'s billable peak hour and the month\'s top-3 day average and resulting tier.',
        inputSchema: NO_ARGS,
        run() {
            const trace = flow.get('dashboardControllerTrace');
            return trace && trace.tariff
                ? Object.assign({ ageSeconds: ageSeconds(trace.timestamp) }, trace.tariff)
                : { available: false, note: 'No tariff data in the controller trace yet.' };
        }
    },
    {
        name: 'get_energy_today',
        title: 'Energy today',
        description: 'Hourly grid import, AC load and solar Wh for today (completed hours plus the live hour) and the day totals.',
        inputSchema: NO_ARGS,
        run() {
            const summary = flow.get('dailySummary') || { dateKey: '', hours: [] };
            const live = flow.get('dashboardLiveHour') || null;
            const hours = (summary.hours || []).map(row => pick(row, ['hour', 'gridWh', 'acWh', 'solarWh']));
            if (live && live.hourKey) {
                hours.push({ hour: live.hourKey.substring(11, 13) + ':00 (live)', gridWh: Math.round(live.gridWh || 0), acWh: Math.round(live.acWh || 0), solarWh: Math.round(live.solarWh || 0) });
            }
            const total = key => hours.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
            return { date: summary.dateKey, hours, totals: { gridWh: total('gridWh'), acWh: total('acWh'), solarWh: total('solarWh') } };
        }
    },
    {
        name: 'get_solar_forecast',
        title: 'Solar forecast',
        description: 'Today\'s solar forecast summary (energy, peak, condition) and the shade-adjusted hourly forecast.',
        inputSchema: NO_ARGS,
        run() {
            const today = flow.get('solarForecastToday') || null;
            const adjusted = flow.get('solarForecastAdjusted') || null;
            return { today, hourlyAdjustedW: adjusted && adjusted.adjustedResult ? adjusted.adjustedResult : null };
        }
    },
    {
        name: 'get_battery_driver_status',
        title: 'Battery driver / BMS / MultiPlus status',
        description: 'Health checks of the dbus-serialbattery driver, the BMS (SoC, cell voltages, charge/discharge limits, alarms), DVCC Controlling BMS, the MultiPlus state and BMS alarms, and all active alarms of every device. Also triggers a fresh check.',
        inputSchema: REFRESH_ARGS,
        refreshOutput: 3,
        run() {
            const state = flow.get('driverDashboardState');
            const view = state && state.view;
            if (!view) {
                return { available: false, note: 'No driver check yet - a check was triggered, call again in ~5 s.' };
            }
            return Object.assign({ ageSeconds: ageSeconds(view.updatedAt) }, pick(view, [
                'sampledAt', 'overall', 'checks', 'battery', 'vebus', 'system', 'alarms', 'watchdog', 'good', 'logDirs', 'logDenied'
            ]), { driver: view.driver ? pick(view.driver, ['service', 'processes', 'ttys', 'config']) : null });
        }
    },
    {
        name: 'get_device_status',
        title: 'GX device status',
        description: 'Cerbo GX health: CPU, load, memory, disks, temperature, uptime, Venus OS version, key services, top processes, network interfaces, listening ports and connections, warnings. Also triggers a fresh sample.',
        inputSchema: REFRESH_ARGS,
        refreshOutput: 2,
        run() {
            const state = flow.get('deviceStatusState');
            const view = state && state.view;
            if (!view) {
                return { available: false, note: 'No device sample yet - a sample was triggered, call again in ~5 s.' };
            }
            return Object.assign({ ageSeconds: ageSeconds(view.updatedAt) }, view);
        }
    },
    {
        name: 'get_bms_watchdog',
        title: 'BMS watchdog',
        description: 'State of the BMS watchdog that restores DVCC "Controlling BMS" after it is lost: active BMS, setting, remembered value, MultiPlus state, BMS-lost alarm, last repair.',
        inputSchema: NO_ARGS,
        run() {
            const state = flow.get('bmsWatchdogState');
            return state ? Object.assign({ ageSeconds: ageSeconds(state.checkedAt) }, state) : { available: false, note: 'Watchdog has not run yet (every 30 s).' };
        }
    },
    {
        name: 'get_settings',
        title: 'Controller settings',
        description: 'High-voltage protection / grid support / force charge / export guard settings and the controller constants overrides (tariff season dates, tiers, limits).',
        inputSchema: NO_ARGS,
        run() {
            return {
                highVoltageSettings: flow.get('highVoltageSettings') || null,
                controllerConstantsOverrides: flow.get('controllerConstantsOverrides') || {}
            };
        }
    },
    {
        name: 'list_backups',
        title: 'Backups',
        description: 'Backups stored on the device (name, date, size, kind) and the disk space.',
        inputSchema: NO_ARGS,
        run() {
            const state = flow.get('backupDashboardState') || {};
            return { backups: state.backups || [], disk: state.disk || null, lastResult: state.result ? pick(state.result, ['action', 'ok', 'message', 'at']) : null };
        }
    }
];

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function respond(statusCode, body, extraHeaders) {
    msg.statusCode = statusCode;
    msg.headers = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {});
    msg.payload = body === undefined ? '' : body;
    return msg;
}

function logCall(entry) {
    const state = flow.get('mcpState') || { calls: [] };
    state.calls = [Object.assign({ at: new Date().toISOString() }, entry)].concat(state.calls || []).slice(0, MAX_CALL_LOG);
    state.lastCallAt = state.calls[0].at;
    flow.set('mcpState', state);
}

const req = msg.req || {};
const headers = req.headers || {};
const method = String(req.method || 'POST').toUpperCase();
// Venus OS serves Node-RED through a local HTTPS proxy, so req.ip is 127.0.0.1; prefer the forwarded client.
const forwardedFor = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '').split(',')[0].trim();
const clientIp = String(forwardedFor || req.ip || (req.connection && req.connection.remoteAddress) || '').replace(/^::ffff:/, '');

if (method !== 'POST') {
    return [respond(405, { error: 'Use POST with a JSON-RPC body (MCP Streamable HTTP, JSON responses only).' }, { Allow: 'POST' }), null, null];
}

// DNS-rebinding protection: a browser request from another site carries a foreign Origin.
if (headers.origin) {
    // (no `URL` in the function sandbox)
    const originMatch = String(headers.origin).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    const originHost = originMatch ? originMatch[1].toLowerCase() : '';
    if (!originHost || originHost !== String(headers.host || '').toLowerCase()) {
        logCall({ ip: clientIp, method: '-', ok: false, detail: 'rejected origin ' + headers.origin });
        return [respond(403, rpcError(null, -32000, 'Origin not allowed')), null, null];
    }
}

const token = String(flow.get('mcpToken') || '').trim();
if (!token) {
    return [respond(503, rpcError(null, -32000, 'MCP server is disabled (no token). Enable it on the Agent (MCP) dashboard page.')), null, null];
}

const bearer = String(headers.authorization || '').match(/^Bearer\s+(.+)$/i);
const presented = String(headers['x-mcp-token'] || (bearer ? bearer[1] : '')).trim();
if (presented !== token) {
    logCall({ ip: clientIp, method: '-', ok: false, detail: presented ? 'wrong token' : 'missing token' });
    return [respond(401, rpcError(null, -32001, 'Unauthorized: send Authorization: Bearer <token> or X-MCP-Token: <token>')), null, null];
}

const body = msg.payload;
if (!body || typeof body !== 'object') {
    return [respond(400, rpcError(null, -32700, 'Parse error: expected a JSON-RPC object')), null, null];
}

const refreshOutputs = { 2: null, 3: null };

function handle(request) {
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return rpcError(request && request.id, -32600, 'Invalid request');
    }
    const isNotification = request.id === undefined || request.id === null;
    const params = request.params || {};

    if (isNotification) {
        logCall({ ip: clientIp, method: request.method, ok: true });
        return null;
    }

    switch (request.method) {
        case 'initialize': {
            const requested = String(params.protocolVersion || '');
            const clientInfo = params.clientInfo ? (params.clientInfo.name || '') + ' ' + (params.clientInfo.version || '') : '';
            logCall({ ip: clientIp, method: 'initialize', ok: true, detail: clientInfo.trim() });
            return rpcResult(request.id, {
                protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, title: 'Victron grid control (Cerbo GX)', version: SERVER_VERSION },
                instructions: INSTRUCTIONS
            });
        }
        case 'ping':
            return rpcResult(request.id, {});
        case 'tools/list':
            logCall({ ip: clientIp, method: 'tools/list', ok: true });
            return rpcResult(request.id, {
                tools: TOOLS.map(tool => ({
                    name: tool.name,
                    title: tool.title,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    annotations: { readOnlyHint: true, openWorldHint: false }
                }))
            });
        case 'tools/call': {
            const tool = TOOLS.find(item => item.name === params.name);
            if (!tool) {
                logCall({ ip: clientIp, method: 'tools/call', tool: String(params.name || ''), ok: false, detail: 'unknown tool' });
                return rpcError(request.id, -32602, 'Unknown tool: ' + params.name);
            }
            const args = params.arguments || {};
            if (tool.refreshOutput && args.refresh !== false) {
                refreshOutputs[tool.refreshOutput] = tool.refreshOutput === 2
                    ? { topic: 'device-status-command', payload: { action: 'refresh' } }
                    : { topic: 'driver-command', payload: { action: 'refresh' } };
            }
            try {
                const data = tool.run(args);
                logCall({ ip: clientIp, method: 'tools/call', tool: tool.name, ok: true });
                return rpcResult(request.id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false });
            }
            catch (error) {
                logCall({ ip: clientIp, method: 'tools/call', tool: tool.name, ok: false, detail: error.message });
                return rpcResult(request.id, { content: [{ type: 'text', text: 'Tool failed: ' + error.message }], isError: true });
            }
        }
        default:
            logCall({ ip: clientIp, method: request.method, ok: false, detail: 'method not found' });
            return rpcError(request.id, -32601, 'Method not found: ' + request.method);
    }
}

let responseBody;
if (Array.isArray(body)) {
    const responses = body.map(handle).filter(Boolean);
    responseBody = responses.length ? responses : undefined;
}
else {
    responseBody = handle(body) || undefined;
}

return [
    responseBody === undefined ? respond(202) : respond(200, responseBody),
    refreshOutputs[2],
    refreshOutputs[3]
];
