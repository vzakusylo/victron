// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `33 MCP page.js` and the embedded `func` for "MCP page"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Manages the MCP access token and builds the "Agent (MCP)" dashboard page: endpoint URLs,
//   token, ready-to-paste client configuration, tool list and the latest agent calls.
// Token:
// - /data/home/nodered/grid-control-config/mcp-token.txt (48 hex chars from /dev/urandom, mode 600)
// - created automatically on first start; `regenerate` replaces it, `disable` deletes it
//   (the MCP server then answers 503); `enable` creates a new one
// - kept in flow `mcpToken` for "MCP server"
// URLs:
// - built from the GX LAN addresses and listening ports reported by the Device page
//   (flow deviceStatusState); 1881 = Node-RED HTTPS, 1880 = Node-RED HTTP (if reachable on the LAN)
// Inputs:
// - inject on start (any topic) / topic `mcp-command` { action: 'refresh' | 'regenerate' | 'disable' | 'enable' }
// - topic `mcp-exec` (exec stdout) with msg.mcpStep = load | regenerate | disable
// Outputs (2):
// - output 1 -> dashboard template (topic `mcp-page`)
// - output 2 -> exec "MCP token" (`sh -c <payload>`)
// Change notes:
// 1. Initial version.
// 2. `load` keeps an existing token (the `||` needed braces), token generation falls back to kernel
//    random UUIDs when `od` is not usable, and a failure is shown on the page (`tokenError`).
// 3. `https://venus.local:1881/mcp` is always the first endpoint (the GX certificate is issued to
//    venus.local; IP addresses fail certificate name checks in Node-based clients).
// ==========================

const TOKEN_FILE = '/data/home/nodered/grid-control-config/mcp-token.txt';
const MCP_PATH = 'mcp';
// Keep in sync with the TOOLS list in "32 MCP server.js".
const TOOL_SUMMARY = [
    { name: 'get_system_overview', text: 'window, battery V / Ah, grid / AC / PV power, setpoint, charge current, protections' },
    { name: 'get_capacity_tariff', text: 'season, tier, kWh today, left today, peak hour, month tier' },
    { name: 'get_energy_today', text: 'hourly grid / AC / solar Wh for today' },
    { name: 'get_solar_forecast', text: 'today\'s forecast and hourly adjusted forecast' },
    { name: 'get_battery_driver_status', text: 'driver / BMS / DVCC / MultiPlus health checks and alarms (+ refresh)' },
    { name: 'get_device_status', text: 'CPU, memory, disks, services, processes, network (+ refresh)' },
    { name: 'get_bms_watchdog', text: 'Controlling BMS watchdog state' },
    { name: 'get_settings', text: 'HV / grid support / force charge settings and constants overrides' },
    { name: 'list_backups', text: 'backups on the device and disk space' }
];

function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
}

// 48 hex chars from /dev/urandom; if `od` behaves differently (BusyBox builds vary) fall back to two
// kernel random UUIDs (64 hex chars). Errors are reported with @@ERR.
const GENERATE = 'mkdir -p "' + TOKEN_FILE.replace(/\/[^/]+$/, '') + '" 2>/dev/null; '
    + 'T=$(head -c 24 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d " \\n"); '
    + '[ ${#T} -ge 32 ] || T=$(cat /proc/sys/kernel/random/uuid /proc/sys/kernel/random/uuid 2>/dev/null | tr -d -- "-\\n"); '
    + '(umask 077; printf "%s" "$T" > "' + TOKEN_FILE + '") 2>/dev/null || echo "@@ERR cannot write ' + TOKEN_FILE + ' as $(id -un)"';
const SCRIPTS = {
    // braces matter: without them `a || b && c` would regenerate the token on every load
    load: '[ -s "' + TOKEN_FILE + '" ] || { ' + GENERATE + '; }; echo "@@TOKEN $(cat "' + TOKEN_FILE + '" 2>/dev/null)"',
    regenerate: GENERATE + '; echo "@@TOKEN $(cat "' + TOKEN_FILE + '" 2>/dev/null)"',
    disable: 'rm -f "' + TOKEN_FILE + '"; echo "@@TOKEN "'
};

function buildEndpoints() {
    const device = flow.get('deviceStatusState');
    const view = device && device.view;
    const ips = [];
    if (view && Array.isArray(view.interfaces)) {
        view.interfaces.forEach(iface => {
            String(iface.ips || '').split(',').forEach(cidr => {
                const ip = cidr.trim().split('/')[0];
                if (ip && !/^127\.|^169\.254\./.test(ip)) {
                    ips.push({ ip, iface: iface.name });
                }
            });
        });
    }
    const listening = view && view.tcp && Array.isArray(view.tcp.listening) ? view.tcp.listening : [];
    const listensOnLan = port => listening.some(entry => entry.port === port
        && entry.addresses.some(address => !/^127\.|^::1\b/.test(address)));
    const known = listening.length > 0;
    // The GX certificate is issued to venus.local (no IP in it), so this is the address Node-based
    // clients such as Claude Code can verify (with NODE_EXTRA_CA_CERTS); always listed first.
    const endpoints = [{
        url: 'https://venus.local:1881/' + MCP_PATH,
        iface: 'mDNS',
        kind: 'https',
        note: 'Recommended on the home network: matches the GX certificate (venus.local)'
    }];

    ips.forEach(item => {
        if (!known || listensOnLan(1881)) {
            endpoints.push({ url: 'https://' + item.ip + ':1881/' + MCP_PATH, iface: item.iface, kind: 'https', note: 'Node-RED HTTPS by IP (curl -k works; the certificate name does not match an IP)' });
        }
        if (listensOnLan(1880)) {
            endpoints.push({ url: 'http://' + item.ip + ':1880/' + MCP_PATH, iface: item.iface, kind: 'http', note: 'Node-RED HTTP (no TLS - LAN only)' });
        }
    });

    return { endpoints, host: view ? view.host : '', sampledAt: view ? view.sampledAt : '', deviceKnown: Boolean(view) };
}

function emit(execMsg) {
    const token = String(flow.get('mcpToken') || '');
    const calls = (flow.get('mcpState') || {}).calls || [];
    const page = Object.assign({
        enabled: Boolean(token),
        token,
        tokenError: flow.get('mcpTokenError') || '',
        tokenFile: TOKEN_FILE,
        path: MCP_PATH,
        tools: TOOL_SUMMARY,
        calls,
        updatedAt: new Date().toISOString()
    }, buildEndpoints());
    return [{ topic: 'mcp-page', payload: page }, execMsg || null];
}

if (msg.topic === 'mcp-exec') {
    const output = String(msg.payload || '');
    const match = output.match(/@@TOKEN ?([0-9a-fA-F]*)/);
    const errorMatch = output.match(/@@ERR (.*)/);
    flow.set('mcpToken', match ? match[1] : '');
    flow.set('mcpTokenError', msg.mcpStep !== 'disable' && !(match && match[1])
        ? 'Token could not be created' + (errorMatch ? ': ' + errorMatch[1] : (output.trim() ? ' (output: ' + output.trim().substring(0, 200) + ')' : ' (no output from the exec node)'))
        : '');
    node.status({ fill: match && match[1] ? 'green' : 'grey', shape: 'dot', text: match && match[1] ? 'MCP enabled' : 'MCP disabled' });
    return emit();
}

const action = msg.topic === 'mcp-command' && msg.payload && msg.payload.action ? String(msg.payload.action) : 'load';

if (action === 'refresh') {
    return emit();
}

const step = action === 'regenerate' || action === 'enable' ? 'regenerate' : (action === 'disable' ? 'disable' : 'load');
return emit({ topic: 'mcp-exec', mcpStep: step, payload: shellQuote(SCRIPTS[step]) });
