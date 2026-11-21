// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `62 UTCP server.js` and the embedded `func` for "UTCP server" in `flows.json` must always stay synchronized.
// Purpose:
// - Universal Tool Calling Protocol (UTCP) endpoint next to the MCP server (32 / 33), for agents that call
//   plain HTTP tools instead of speaking MCP. Docs: docs/utcp.md.
// - `GET  /utcp`              -> the UTCP manual (JSON): the tool list with inputs and HTTP call templates.
//                                 URLs in the manual are relative to the address the manual was fetched from;
//                                 no host and no secret is in it (the token is the placeholder ${UTCP_TOKEN}).
// - `POST /utcp/call/<tool>`  -> run one tool, JSON body = the tool inputs.
// Tools:
// - read:    get_system_overview, get_heat_pump_state, get_idle_periods (day), get_event_lane (day),
//            get_deploy_version, get_automation_log (lines, day)
// - control: set_heating_mode (off / test / on), start_warm_up (deltaC, hours), force_boiler_run, cancel
//            (what: warm_up | force_boiler_run). A control call needs the token AND `confirm: true`, is refused while
//            local control is OFF (cancel is always allowed: it only returns to the owner's settings), is rate
//            limited to one control call per 10 s, is logged as "UTCP: …" in the Automation log, and reuses the
//            dashboard code paths: it sends the same `ui` message the Heat Pump page sends to "Heat pump automations" (40),
//            which validates and applies it. Nothing here writes to a device directly.
// Security:
// - the same token as the MCP server (flow `mcpToken`, "Agent (MCP)" page): `Authorization: Bearer <token>` or
//   `X-MCP-Token: <token>`; no token configured -> 503, wrong token -> 401; a browser Origin that does not match the Host -> 403.
// Outputs (4):
// - 1 -> "UTCP HTTP response"
// - 2 -> "Heat pump automations" (40): `ui` messages of the control tools and their "UTCP: …" log notes
// - 3 -> exec "UTCP read automation log" (tail of the day file); its stdout comes back to this node
// - 4 -> exec "Read heat pump history" (the dashboard's day reader) -> "Build heat pump history" (38), whose second
//        output (msg.utcp set) comes back to this node with the idle periods / event lane of the day
// Change notes:
// 1. Initial version (H14).
// ==========================

const MANUAL_VERSION = '1.0.0';
const LOG_DIR = '/data/home/nodered/grid-control-logs/automations';
const HIST_DIR = '/data/home/nodered/grid-control-logs/heatpump';
const CONTROL_GAP_MS = 10 * 1000;
const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 200;
const WARM = { deltaC: [0.5, 5], hours: [0.5, 6], defaults: { deltaC: 2, hours: 1 } };   // same limits as the heating controller (40)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODE_TO_UI = { off: 'off', test: 'dry', on: 'live' };
const MODE_TEXT = { off: 'Off', test: 'Test', on: 'On' };
// Shell snippet: print every hour file of day folder $d in hour order (gz or plain), as "Heat pump command" (37) does
const CAT_DAY = 'for f in $(ls $d | sort); do case $f in *.csv.gz) gzip -dc $d/$f;; *.csv) cat $d/$f;; esac; done';

const pad = (v) => String(v).padStart(2, '0');
const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const DAY_ARG = { type: 'string', description: 'Day YYYY-MM-DD (local time of the GX); default today.', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const CONFIRM_ARG = { type: 'boolean', description: 'Must be true: a control call changes how the heat pump is run.' };

function pick(source, keys) {
    const out = {};
    keys.forEach((k) => { if (source && source[k] !== undefined) out[k] = source[k]; });
    return out;
}
function ageSeconds(ts) { const ms = typeof ts === 'string' ? Date.parse(ts) : ts; return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null; }

// ---- tools ------------------------------------------------------------------------------------------
const TOOLS = [
    { name: 'get_system_overview', description: 'Live controller state: active window, battery voltage, grid / AC load / PV power, ESS grid setpoint, protections and limit flags.',
        inputs: NO_ARGS, tags: ['read', 'system'],
        run() {
            const trace = flow.get('dashboardControllerTrace');
            if (!trace) return { available: false, note: 'No controller trace yet.' };
            return Object.assign({ ageSeconds: ageSeconds(trace.timestamp) }, pick(trace, ['timestamp', 'window', 'batteryVoltage', 'consumedAhDeficit', 'storedGridPowerW', 'gridPowerSignedW',
                'storedAcLoadPowerW', 'storedPvChargerPowerW', 'solarGenerationW', 'finalGridSetpoint', 'finalChargeCurrent', 'gridCurrentLimitA', 'voltageLimitActive', 'exportGuard',
                'forceChargeEnabled', 'manualDischarge', 'gridSupportMode', 'boostActive', 'limitFlags']));
        } },
    { name: 'get_heat_pump_state', description: 'Heat pump now: status line, idle cause, controller modes, local control master, warm-up, DHW state and the main readings (supply, return, tank, outdoor, compressor Hz, power).',
        inputs: NO_ARGS, tags: ['read', 'heat-pump'],
        run() {
            const v = flow.get('dhwView'), m = flow.get('heatPumpModel');
            if (!v && !m) return { available: false, note: 'No heat pump data yet.' };
            const s = m && m.summary ? Object.assign({}, m.summary) : null;
            if (s) delete s.meterDps;
            return { ageSeconds: v ? ageSeconds(v.at) : null, status: v && v.status ? v.status : null, idle: v && v.idle ? pick(v.idle, ['active', 'code', 'text', 'detail', 'since']) : null,
                localControlOn: v ? v.master === true : null, dhwState: v ? v.state || null : null, heating: v && v.heat ? pick(v.heat, ['mode', 'point', 'lag', 'gap', 'boost', 'warm', 'why']) : null,
                readings: s, devices: m ? m.devices : null, curve: m && m.curveChart ? pick(m.curveChart, ['enabled', 'p23', 'p24', 'outdoor', 'target', 'reported']) : null };
        } },
    { name: 'get_idle_periods', description: 'Periods of a day when the compressor was idle (stopped outside a DHW cycle / defrost) for a minute or more, each with its cause, and the minutes per cause.',
        inputs: { type: 'object', properties: { day: DAY_ARG, minMinutes: { type: 'number', description: 'Only periods of at least this many minutes (default 1).' } }, additionalProperties: false },
        tags: ['read', 'heat-pump', 'history'], day: true },
    { name: 'get_event_lane', description: 'The event lane of the history page for a day: heating / DHW / preheat / defrost / error / idle / gap segments with start, end, length and the tooltip text (cause or gap reason), and the legend counts.',
        inputs: { type: 'object', properties: { day: DAY_ARG }, additionalProperties: false }, tags: ['read', 'heat-pump', 'history'], day: true },
    { name: 'get_deploy_version', description: 'The deployed flow version (d#N) and the Git commit it was built from.',
        inputs: NO_ARGS, tags: ['read', 'system'],
        run() {
            const label = String(env.get('NR_FLOW_NAME') || '');
            const v = label.match(/d#\d+/);
            const src = label.match(/ \[(?:git ([a-f0-9]{12})|UI ([a-f0-9]{12}); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))\]$/);
            return { version: v ? v[0] : null, commit: src ? (src[1] || src[2]).slice(0, 7) : null };
        } },
    { name: 'get_automation_log', description: 'The last lines of the Automation log of a day (newest last): time, kind, rule and text.',
        inputs: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: LOG_LINES_MAX, description: 'How many lines (default ' + LOG_LINES_DEFAULT + ').' }, day: DAY_ARG }, additionalProperties: false },
        tags: ['read', 'log'], log: true },
    { name: 'set_heating_mode', description: 'Set the heating controller: off (owner curve only), test (decides, writes nothing) or on (writes to the heat pump). Needs local control ON.',
        inputs: { type: 'object', properties: { mode: { type: 'string', enum: ['off', 'test', 'on'] }, confirm: CONFIRM_ARG }, required: ['mode', 'confirm'], additionalProperties: false },
        tags: ['control', 'heat-pump'], control: true,
        check(a) { return Object.prototype.hasOwnProperty.call(MODE_TO_UI, a.mode) ? null : 'mode must be off, test or on'; },
        ui(a) { return { action: 'mode', id: 'heat', mode: MODE_TO_UI[a.mode] }; }, text(a) { return 'heating controller mode → ' + MODE_TEXT[a.mode]; } },
    { name: 'start_warm_up', description: 'Warm-up: raise the heating point by deltaC °C for the given hours, then follow the heating curve again. Needs local control ON.',
        inputs: { type: 'object', properties: { deltaC: { type: 'number', minimum: WARM.deltaC[0], maximum: WARM.deltaC[1], description: '°C above the point (default ' + WARM.defaults.deltaC + ').' },
            hours: { type: 'number', minimum: WARM.hours[0], maximum: WARM.hours[1], description: 'How long (default ' + WARM.defaults.hours + ' h).' }, confirm: CONFIRM_ARG }, required: ['confirm'], additionalProperties: false },
        tags: ['control', 'heat-pump'], control: true,
        check(a) {
            const d = a.deltaC === undefined ? WARM.defaults.deltaC : a.deltaC, h = a.hours === undefined ? WARM.defaults.hours : a.hours;
            if (typeof d !== 'number' || !Number.isFinite(d) || d < WARM.deltaC[0] || d > WARM.deltaC[1]) return 'deltaC must be ' + WARM.deltaC[0] + '…' + WARM.deltaC[1];
            if (typeof h !== 'number' || !Number.isFinite(h) || h < WARM.hours[0] || h > WARM.hours[1]) return 'hours must be ' + WARM.hours[0] + '…' + WARM.hours[1];
            return null;
        },
        ui(a) { return { action: 'heatWarm', on: true, deltaC: a.deltaC === undefined ? WARM.defaults.deltaC : a.deltaC, hours: a.hours === undefined ? WARM.defaults.hours : a.hours }; },
        text(a) { return 'warm-up +' + (a.deltaC === undefined ? WARM.defaults.deltaC : a.deltaC) + ' °C for ' + (a.hours === undefined ? WARM.defaults.hours : a.hours) + ' h'; } },
    { name: 'force_boiler_run', description: 'Queue a forced boiler (DHW) run: it starts as soon as defrost, faults and the DHW block allow. Needs local control ON.',
        inputs: { type: 'object', properties: { confirm: CONFIRM_ARG }, required: ['confirm'], additionalProperties: false },
        tags: ['control', 'dhw'], control: true,
        check() { return null; }, ui() { return { action: 'dhwForceRun', on: true }; }, text() { return 'forced boiler run requested'; } },
    { name: 'cancel', description: 'Cancel a running warm-up or a queued / running forced boiler run (back to the owner settings). Allowed while local control is OFF.',
        inputs: { type: 'object', properties: { what: { type: 'string', enum: ['warm_up', 'force_boiler_run'] }, confirm: CONFIRM_ARG }, required: ['what', 'confirm'], additionalProperties: false },
        tags: ['control', 'heat-pump'], control: true, alwaysAllowed: true,
        check(a) { return a.what === 'warm_up' || a.what === 'force_boiler_run' ? null : 'what must be warm_up or force_boiler_run'; },
        ui(a) { return a.what === 'warm_up' ? { action: 'heatWarm', on: false } : { action: 'dhwForceRun', on: false }; }, text(a) { return 'cancel ' + a.what.replace('_', ' '); } }
];

function manual() {
    return {
        utcp_version: '1.0.0',
        manual_version: MANUAL_VERSION,
        info: { title: 'Victron grid control (Cerbo GX): heat pump and system', description: 'Read tools are plain; control tools need confirm=true and local control ON. URLs are relative to the address of this manual.' },
        tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputs: t.inputs,
            outputs: { type: 'object' },
            tags: t.tags,
            tool_call_template: {
                call_template_type: 'http',
                http_method: 'POST',
                url: '/utcp/call/' + t.name,
                content_type: 'application/json',
                body_field: 'body',
                auth: { auth_type: 'api_key', api_key: 'Bearer ${UTCP_TOKEN}', var_name: 'Authorization', location: 'header' }
            }
        }))
    };
}

// ---- http -------------------------------------------------------------------------------------------
const req = msg.req || {};
const headers = req.headers || {};
const forwarded = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '').split(',')[0].trim();
const clientIp = String(forwarded || req.ip || '').replace(/^::ffff:/, '');
function respond(statusCode, body) {
    msg.statusCode = statusCode;
    msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    msg.payload = body;
    return [msg, null, null, null];
}
function note(text, kind) { return { topic: 'ui', payload: { action: 'utcpLog', kind: kind || 'info', text: 'UTCP: ' + text } }; }

// answers coming back from the exec nodes / "Build heat pump history"
if (msg.utcpPhase === 'log') {
    const lines = String(Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : msg.payload || '').split('\n').filter(Boolean);
    const entries = [];
    lines.forEach((l) => { try { const e = JSON.parse(l); entries.push({ time: new Date(e.t).toISOString(), kind: e.kind, rule: e.rule || null, text: String(e.text || '') }); } catch (e) { /* a half-written last line */ } });
    return respond(200, { day: msg.utcpDay, count: entries.length, entries });
}
if (msg.utcpPhase === 'day') {
    const d = msg.payload || {};
    if (d.empty) return respond(200, { day: msg.utcpDay, available: false, note: 'No heat pump records for this day.' });
    if (msg.utcpTool === 'get_event_lane') {
        const segments = d.events.map((e) => ({ kind: e.kind, from: e.from, to: e.to, minutes: e.min, tooltip: e.tip || e.kind }));
        return respond(200, { day: msg.utcpDay, available: true, segments, legend: d.legend.map((l) => ({ kind: l.kind, count: l.count })) });
    }
    const min = Number.isFinite(msg.utcpMin) ? msg.utcpMin : 1;
    const periods = d.events.filter((e) => e.kind === 'idle' && e.min >= min).map((e) => ({ from: e.from, to: e.to, minutes: e.min, cause: String(e.tip || '').replace(/^Idle: /, '') }));
    const byCause = {};
    periods.forEach((p) => { byCause[p.cause] = (byCause[p.cause] || 0) + p.minutes; });
    return respond(200, { day: msg.utcpDay, available: true, minMinutes: min, count: periods.length, totalMinutes: periods.reduce((s, p) => s + p.minutes, 0), byCause, periods });
}

const method = String(req.method || '').toUpperCase();
if (headers.origin) {
    const m = String(headers.origin).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (!m || m[1].toLowerCase() !== String(headers.host || '').toLowerCase()) return respond(403, { error: 'Origin not allowed' });
}
const token = String(flow.get('mcpToken') || '').trim();
if (!token) return respond(503, { error: 'UTCP is disabled (no token). Enable the token on the Agent (MCP) dashboard page.' });
const bearer = String(headers.authorization || '').match(/^Bearer\s+(.+)$/i);
const presented = String(headers['x-mcp-token'] || (bearer ? bearer[1] : '')).trim();
if (presented !== token) return respond(401, { error: 'Unauthorized: send Authorization: Bearer <token> or X-MCP-Token: <token>' });

if (method === 'GET') return respond(200, manual());
if (method !== 'POST') return respond(405, { error: 'Use GET /utcp for the manual or POST /utcp/call/<tool>' });

const tool = TOOLS.find((t) => t.name === String((req.params || {}).tool || ''));
if (!tool) return respond(404, { error: 'Unknown tool: ' + String((req.params || {}).tool || '') });
const args = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {};

if (tool.control) {
    const refuse = (status, why) => { const r = respond(status, { ok: false, error: why }); r[1] = note('refused ' + tool.name + ' (' + why + ')', 'warn'); return r; };
    if (args.confirm !== true) return refuse(400, 'confirm: true is required for a control call');
    const bad = tool.check(args);
    if (bad) return refuse(400, bad);
    const t = Date.now(), last = context.get('lastControl') || 0;
    if (t - last < CONTROL_GAP_MS) return refuse(429, 'rate limited: one control call per ' + CONTROL_GAP_MS / 1000 + ' s');
    const view = flow.get('dhwView');
    if (!tool.alwaysAllowed && !(view && view.master === true)) return refuse(409, 'local control is OFF');
    context.set('lastControl', t);
    const r = respond(200, { ok: true, tool: tool.name, applied: tool.text(args), note: 'Sent to the heating controller, which validates it; read get_heat_pump_state to confirm.' });
    r[1] = [{ topic: 'ui', payload: tool.ui(args) }, note(tool.text(args) + (clientIp ? ' (from ' + clientIp + ')' : ''))];
    node.status({ fill: 'blue', shape: 'dot', text: tool.name });
    return r;
}

if (tool.run) return respond(200, tool.run(args));

const day = args.day === undefined ? todayKey() : String(args.day);
if (!DAY_RE.test(day)) return respond(400, { error: 'day must be YYYY-MM-DD' });
if (tool.log) {
    const lines = args.lines === undefined ? LOG_LINES_DEFAULT : Number(args.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > LOG_LINES_MAX) return respond(400, { error: 'lines must be 1…' + LOG_LINES_MAX });
    msg.utcpPhase = 'log'; msg.utcpDay = day;
    msg.payload = "'tail -n " + lines + ' ' + LOG_DIR + '/' + day + ".jsonl 2>/dev/null; true'";
    return [null, null, msg, null];
}
// idle periods / event lane: the dashboard's day reader and history builder (38) do the work
const min = args.minMinutes === undefined ? 1 : Number(args.minMinutes);
if (!Number.isFinite(min) || min < 0) return respond(400, { error: 'minMinutes must be a number ≥ 0' });
msg.utcpPhase = 'day-request'; msg.utcpDay = day; msg.utcpTool = tool.name; msg.utcpMin = min;
msg.utcp = tool.name; msg.topic = 'day'; msg.day = day;
msg.payload = "'cd " + HIST_DIR + ' 2>/dev/null || exit 0; d=' + day + '; [ -d $d ] || exit 0; echo "#day $d"; ' + CAT_DAY + "'";
return [null, null, null, msg];
