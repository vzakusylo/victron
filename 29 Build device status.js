// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `29 Build device status.js` and the embedded `func` for "Build device status"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Device status page: CPU, load, memory, disks, temperature, uptime, Venus OS version, network
//   interfaces and traffic, TCP connections / listening ports, top processes and key Venus services.
// - Everything is read-only from /proc, /sys and standard tools, so it works as the `nodered` user.
// Inputs:
// - topic `device-status-command` (dashboard): payload { action: 'refresh' }
// - topic `device-status-exec` (exec stdout): script output with `@@` markers
// - anything else -> refresh
// Outputs (2):
// - output 1 -> dashboard template (topic `device-status`)
// - output 2 -> exec "Read device status" (`sh -c <payload>`)
// Sampling:
// - /proc/stat, /proc/net/dev and every /proc/<pid>/stat are read twice, 1 s apart; CPU % and
//   network rates are the difference. Process CPU % is the share of the whole machine.
// Change notes:
// 1. Initial version.
// 2. Process command lines and owners are read from /proc/<pid>/cmdline and /proc/<pid>/status
//    (+ /etc/passwd) instead of `ps`: BusyBox ps on Venus has no -e / truncates args, so services
//    started as Python scripts (comm cut to 15 chars, e.g. "dbus-serialbatt") were not recognised.
// 3. Adds the "BMS watchdog" state (flow `bmsWatchdogState`) to the view as `bmsWatchdog`.
// ==========================

// NR9: sampler, parser and view are included at build time.

const STATE_KEY = 'deviceStatusState';
const BUSY_TIMEOUT_MS = 30000;
const PAGE_KB = 4;
const KNOWN_PORTS = {
    22: 'SSH', 53: 'DNS', 80: 'HTTP (GUI)', 443: 'HTTPS (GUI)', 502: 'Modbus TCP', 1880: 'Node-RED',
    1881: 'Node-RED (HTTPS)', 1883: 'MQTT', 8883: 'MQTT TLS', 9001: 'MQTT websocket', 9443: 'MQTT websocket TLS',
    8088: 'GUI websocket', 3000: 'Signal K', 8000: 'Venus web', 5353: 'mDNS'
};
// Labels for the remote side of outgoing connections.
const REMOTE_PORTS = {
    53: 'DNS', 80: 'HTTP', 123: 'NTP', 443: 'HTTPS (VRM / cloud)', 1883: 'MQTT', 8883: 'MQTT TLS (VRM)', 22: 'SSH'
};
const TCP_STATES = {
    '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2',
    '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING'
};
// Key services, recognised by their command line.
const KEY_SERVICES = [
    { name: 'Node-RED', pattern: /node-red/ },
    { name: 'dbus-serialbattery', pattern: /dbus-serialbattery/ },
    { name: 'dbus-aggregate-batteries', pattern: /aggregate-batteries|aggregatebatteries/ },
    { name: 'VE.Bus (mk2-dbus)', pattern: /mk2-dbus/ },
    { name: 'System calc', pattern: /systemcalc/ },
    { name: 'Venus platform', pattern: /venus-platform/ },
    { name: 'Local settings', pattern: /localsettings/ },
    { name: 'GUI', pattern: /gui-v2|venus-gui|\/gui\b|\bgui\s/ },
    { name: 'MQTT broker', pattern: /flashmq|mosquitto/ },
    { name: 'VRM logger', pattern: /vrmlogger/ },
    { name: 'Modbus TCP', pattern: /modbustcp/ },
    { name: 'D-Bus daemon', pattern: /dbus-daemon/ },
    { name: 'SSH server', pattern: /dropbear|sshd/ },
    { name: 'Web server', pattern: /nginx|hiawatha|lighttpd/ }
];

// #include lib/device-status/sampler.js

function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 * 1024 * 1024) {
        return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    if (value >= 1024 * 1024) {
        return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }
    if (value >= 1024) {
        return (value / 1024).toFixed(1) + ' KB';
    }
    return Math.round(value) + ' B';
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return (days ? days + 'd ' : '') + hours + 'h ' + minutes + 'm';
}

// #include lib/device-status/parse.js

// #include lib/device-status/view.js

let state = flow.get(STATE_KEY) || { busySince: 0, view: null };
const nowTs = Date.now();

if (msg.topic === 'device-status-exec') {
    state.busySince = 0;
    state.view = buildView(parseOutput(msg.payload));
    // Written by "BMS watchdog" every 30 s.
    state.view.bmsWatchdog = flow.get('bmsWatchdogState') || null;
    state.error = '';
    flow.set(STATE_KEY, state);
    return [{ topic: 'device-status', payload: state.view }, null];
}

// Refresh request (dashboard button, auto-refresh, connect): one sampling run at a time.
if (state.busySince && nowTs - state.busySince < BUSY_TIMEOUT_MS) {
    return [state.view ? { topic: 'device-status', payload: state.view } : null, null];
}

state.busySince = nowTs;
flow.set(STATE_KEY, state);
return [
    state.view ? { topic: 'device-status', payload: state.view } : null,
    { topic: 'device-status-exec', payload: shellQuote(SCRIPT) }
];
