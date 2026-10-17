// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `31 Driver checks dashboard.js` and the embedded `func` for "Driver checks dashboard"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - "Driver" dashboard page: every check used to diagnose the dbus-serialbattery driver, DVCC
//   "Controlling BMS" and the MultiPlus BMS alarms, plus the driver logs and a few safe controls.
// Checks (one exec run, read-only, works as user `nodered`):
// - serial devices, driver service (svstat, if permitted) and driver process + its uptime
// - all D-Bus values in ONE python call (instead of ~30 `dbus` CLI calls): SerialBattery values and
//   alarms, VE.Bus state / error / BMS alarms, system /ActiveBmsService, DVCC + BMS settings, and the
//   non-zero /Alarms of every Victron service
// - effective dbus-serialbattery config.ini (non-comment lines) and the BMS watchdog's remembered value
// - a timeline of the last samples (active BMS, setting, VE.Bus state, BMS-lost alarm) for the repair test
// Logs: tail of /var/log/<service>/current (or /data/log/...) through tai64nlocal; the log list is
//   discovered by the checks and only those paths can be read.
// Controls: refresh, run the BMS watchdog now, force-restore Controlling BMS (both via "BMS watchdog"),
//   clear the timeline. Root-only actions (restart driver, enable.sh) are shown as SSH commands.
// Inputs:
// - topic `driver-command` (dashboard): payload { action: 'refresh' | 'logs' | 'watchdog' | 'restore-bms'
//   | 'clear-timeline', log, lines }
// - topic `driver-exec` (exec stdout): script output with `@@` markers (msg.driverStep = checks | logs)
// - anything else -> refresh
// Outputs (3):
// - output 1 -> dashboard template (topic `driver-status`)
// - output 2 -> exec "Run driver checks" (`sh -c <payload>`)
// - output 3 -> "BMS watchdog" (topic bms-watchdog-tick | bms-watchdog-force)
// Change notes:
// 1. Initial version.
// 2. Display fixes: lists of objects (e.g. /AvailableBmsServices) are shown as JSON instead of
//    "[object Object]", D-Bus floats are rounded to 3 decimals.
// ==========================

const STATE_KEY = 'driverDashboardState';
const CONFIG_PATH = '/data/apps/dbus-serialbattery/config.ini';
const GOOD_FILE = '/data/home/nodered/grid-control-config/bms-watchdog-good.txt';
const BUSY_TIMEOUT_MS = 30000;
const TIMELINE_LENGTH = 40;
const LOG_LINE_CHOICES = [50, 200, 500, 1000];
const VEBUS_STATES = {
    0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 6: 'Storage', 7: 'Equalize',
    8: 'Passthru', 9: 'Inverting', 10: 'Power assist', 11: 'Power supply', 244: 'Sustain', 252: 'External control (ESS)'
};
const VEBUS_MODES = { 1: 'Charger only', 2: 'Inverter only', 3: 'On', 4: 'Off' };
const BATTERY_PATHS = [
    '/ProductName', '/CustomName', '/Connected', '/DeviceInstance', '/Soc', '/Dc/0/Voltage', '/Dc/0/Current', '/Dc/0/Power',
    '/Dc/0/Temperature', '/Info/MaxChargeCurrent', '/Info/MaxDischargeCurrent', '/Info/MaxChargeVoltage',
    '/System/MinCellVoltage', '/System/MaxCellVoltage', '/System/NrOfCellsPerBattery', '/InstalledCapacity',
    '/Io/AllowToCharge', '/Io/AllowToDischarge', '/Io/AllowToBalance', '/FirmwareVersion', '/HardwareVersion', '/Alarms'
];
const VEBUS_PATHS = [
    '/ProductName', '/State', '/Mode', '/VebusError', '/Dc/0/Voltage', '/Dc/0/Current',
    '/Alarms/LowBattery', '/Alarms/BmsConnectionLost', '/Alarms/HighTemperature', '/Alarms/Overload',
    '/Bms/BmsExpected', '/Bms/AllowToCharge', '/Bms/AllowToDischarge', '/Bms/Error'
];
const SYSTEM_PATHS = ['/ActiveBmsService', '/ActiveBatteryService', '/AvailableBmsServices', '/Dc/Battery/Soc', '/Control/MaxChargeCurrent'];
const SETTINGS_PATHS = [
    '/Settings/Services/Bol', '/Settings/SystemSetup/BmsInstance', '/Settings/SystemSetup/BatteryService',
    '/Settings/SystemSetup/MaxChargeCurrent'
];

function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
}

const PYTHON = [
    'import json, sys',
    'try:',
    '    import dbus',
    'except Exception as error:',
    '    print("@@DBUSJSON " + json.dumps({"error": "python dbus module: %s" % error}))',
    '    sys.exit(0)',
    'BAT = ' + JSON.stringify(BATTERY_PATHS),
    'VEB = ' + JSON.stringify(VEBUS_PATHS),
    'SYS = ' + JSON.stringify(SYSTEM_PATHS),
    'SET = ' + JSON.stringify(SETTINGS_PATHS),
    'bus = dbus.SystemBus()',
    'def get(service, path):',
    '    try:',
    '        return bus.get_object(service, path, introspect=False).GetValue(dbus_interface="com.victronenergy.BusItem", timeout=3)',
    '    except Exception:',
    '        return None',
    'names = sorted(str(n) for n in bus.list_names() if str(n).startswith("com.victronenergy."))',
    'bat = next((n for n in names if n.startswith("com.victronenergy.battery.tty")), None)',
    'veb = next((n for n in names if n.startswith("com.victronenergy.vebus")), None)',
    'out = {"services": names, "battery": bat, "vebus": veb, "bat": {}, "veb": {}, "sys": {}, "set": {}, "alarms": {}}',
    'if bat:',
    '    out["bat"] = dict((p, get(bat, p)) for p in BAT)',
    'if veb:',
    '    out["veb"] = dict((p, get(veb, p)) for p in VEB)',
    'out["sys"] = dict((p, get("com.victronenergy.system", p)) for p in SYS)',
    'out["set"] = dict((p, get("com.victronenergy.settings", p)) for p in SET)',
    'for n in names:',
    '    alarms = get(n, "/Alarms")',
    '    if isinstance(alarms, dict):',
    '        active = dict((str(k), v) for k, v in alarms.items() if isinstance(v, (int, float)) and v)',
    '        if active:',
    '            out["alarms"][n] = active',
    'print("@@DBUSJSON " + json.dumps(out, default=str))'
].join('\n');

const CHECK_SCRIPT = [
    'echo "@@NOW $(date "+%Y-%m-%d %H:%M:%S")"',
    'echo "@@UPTIME $(cut -d" " -f1 /proc/uptime)"',
    'echo "@@USER $(id -un 2>/dev/null)"',
    'for d in /dev/ttyUSB* /dev/ttyACM*; do [ -e "$d" ] && echo "@@TTY $d"; done',
    'for s in /service/dbus-serialbattery.*; do [ -e "$s" ] && echo "@@SVC ${s##*/}|$(svstat "$s" 2>&1)"; done',
    // `[.]` keeps this script itself (whose command line contains the text) from matching.
    'for f in $(grep -la "dbus-serialbattery[.]py" /proc/[0-9]*/cmdline 2>/dev/null); do d=${f%/cmdline}; read -r st 2>/dev/null < "$d/stat" && echo "@@PROC $st"; printf "@@ARGS %s " "${d#/proc/}"; tr "\\000" " " 2>/dev/null < "$f"; echo; done',
    'for d in /var/log/dbus-serialbattery.* /var/log/serial-starter /var/log/dbus-aggregate-batteries* /data/log/dbus-serialbattery.*; do [ -f "$d/current" ] && echo "@@LOGDIR $d"; done',
    'if [ -r "' + CONFIG_PATH + '" ]; then grep -v -E "^[[:space:]]*([;#]|$)" "' + CONFIG_PATH + '" | sed "s/^/@@CFG /"; else echo "@@CFGERR not readable"; fi',
    'echo "@@GOOD $(head -n 1 "' + GOOD_FILE + '" 2>/dev/null)"',
    'PY=$(command -v python3 || command -v python)',
    'if [ -n "$PY" ]; then "$PY" - <<\'PYEOF\'',
    PYTHON,
    'PYEOF',
    'else echo "@@DBUSJSON {\\"error\\": \\"python not found\\"}"; fi',
    'true'
].join('\n');

function buildLogScript(logDir, lines) {
    return 'echo "@@LOGFILE ' + logDir + '/current"; '
        + 'tail -n ' + lines + ' "' + logDir + '/current" 2>&1 | { command -v tai64nlocal >/dev/null 2>&1 && tai64nlocal || cat; } | sed "s/^/@@L /"';
}

function toNumber(value) {
    if (value === null || value === undefined || Array.isArray(value) || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function display(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    if (Array.isArray(value)) {
        // e.g. /AvailableBmsServices is a list of objects
        return value.length ? value.map(item => (item && typeof item === 'object' ? JSON.stringify(item) : display(item))).join(', ') : '(empty)';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && !Number.isInteger(value)) {
        // D-Bus floats arrive as 54.59999847412109
        return String(Math.round(value * 1000) / 1000);
    }
    return String(value);
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return (days ? days + 'd ' : '') + (days || hours ? hours + 'h ' : '') + minutes + 'm ' + (total % 60) + 's';
}

function parseChecks(rawText) {
    const result = { ttys: [], services: [], processes: [], args: {}, logDirs: [], config: [], configError: '', good: '', dbus: null };
    String(rawText || '').split(/\r?\n/).forEach(line => {
        const match = line.match(/^@@([A-Z]+) ?(.*)$/);
        if (!match) {
            return;
        }
        const value = match[2];
        switch (match[1]) {
            case 'NOW': result.now = value.trim(); break;
            case 'UPTIME': result.uptimeSec = Number(value.trim()) || 0; break;
            case 'USER': result.user = value.trim(); break;
            case 'TTY': result.ttys.push(value.trim()); break;
            case 'SVC': {
                const parts = value.split('|');
                result.services.push({ name: parts[0], status: parts.slice(1).join('|').replace(/^[^:]*:\s*/, '').trim() });
                break;
            }
            case 'PROC': {
                const close = value.lastIndexOf(')');
                const rest = value.substring(close + 2).split(' ');
                result.processes.push({ pid: Number(value.substring(0, value.indexOf('(')).trim()), startTicks: Number(rest[19]) || 0 });
                break;
            }
            case 'ARGS': {
                const parts = value.match(/^(\d+) (.*)$/);
                if (parts) {
                    result.args[Number(parts[1])] = parts[2].trim();
                }
                break;
            }
            case 'LOGDIR': result.logDirs.push(value.trim()); break;
            case 'CFG': result.config.push(value.trim()); break;
            case 'CFGERR': result.configError = value.trim(); break;
            case 'GOOD': result.good = value.trim(); break;
            case 'DBUSJSON':
                try {
                    result.dbus = JSON.parse(value);
                }
                catch (error) {
                    result.dbus = { error: 'cannot parse D-Bus output: ' + error.message };
                }
                break;
            default:
                break;
        }
    });
    return result;
}

function check(name, level, detail) {
    return { name, level, detail };
}

function buildView(parsed, state) {
    const dbusData = parsed.dbus || { error: 'no D-Bus output' };
    const bat = dbusData.bat || {};
    const veb = dbusData.veb || {};
    const sys = dbusData.sys || {};
    const set = dbusData.set || {};
    const uptimeSec = parsed.uptimeSec || 0;

    // Driver process
    const processes = parsed.processes.map(proc => ({
        pid: proc.pid,
        args: parsed.args[proc.pid] || '',
        uptimeText: formatDuration(uptimeSec - proc.startTicks / 100),
        uptimeSec: uptimeSec - proc.startTicks / 100
    }));
    const driverProcess = processes[0] || null;

    // Config
    const configMap = {};
    const duplicates = [];
    parsed.config.forEach(line => {
        const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (kv) {
            if (Object.prototype.hasOwnProperty.call(configMap, kv[1])) {
                duplicates.push(kv[1]);
            }
            configMap[kv[1]] = kv[2].trim();
        }
    });

    // Battery
    const minCell = toNumber(bat['/System/MinCellVoltage']);
    const maxCell = toNumber(bat['/System/MaxCellVoltage']);
    const cellSpreadMv = minCell !== null && maxCell !== null ? Math.round((maxCell - minCell) * 1000) : null;
    const batteryAlarms = bat['/Alarms'] && typeof bat['/Alarms'] === 'object' && !Array.isArray(bat['/Alarms'])
        ? Object.keys(bat['/Alarms']).filter(key => toNumber(bat['/Alarms'][key])).map(key => key + '=' + bat['/Alarms'][key])
        : [];

    // VE.Bus
    const vebusState = toNumber(veb['/State']);
    const vebusMode = toNumber(veb['/Mode']);
    const vebusError = toNumber(veb['/VebusError']);
    const bmsLost = toNumber(veb['/Alarms/BmsConnectionLost']) || 0;
    const lowBattery = toNumber(veb['/Alarms/LowBattery']) || 0;

    // System / settings
    const activeBms = sys['/ActiveBmsService'];
    const activeBmsOk = typeof activeBms === 'string' && activeBms.length > 0;
    const dvccOn = toNumber(set['/Settings/Services/Bol']) === 1;
    const bmsSetting = set['/Settings/SystemSetup/BmsInstance'];

    // Active alarms of all services
    const alarmList = [];
    Object.keys(dbusData.alarms || {}).forEach(service => {
        Object.keys(dbusData.alarms[service]).forEach(name => {
            const level = Number(dbusData.alarms[service][name]);
            alarmList.push({ service, name, level, levelText: level >= 2 ? 'alarm' : 'warning' });
        });
    });

    // svstat needs read access to the root-owned supervise folder; as `nodered` it usually reports
    // "unable to open ... access denied" - then the process check below is used instead.
    const svcRaw = parsed.services[0] || null;
    const svc = svcRaw && !/unable|denied|permission/i.test(svcRaw.status) ? svcRaw : null;
    const svcUp = svc ? /^up/.test(svc.status) : null;
    const svcSeconds = svc ? Number((svc.status.match(/(\d+) seconds/) || [])[1]) : null;
    const watchdog = flow.get('bmsWatchdogState') || null;

    const checks = [
        check('Serial port', parsed.ttys.length ? 'ok' : 'bad', parsed.ttys.join(', ') || 'no /dev/ttyUSB* or /dev/ttyACM*'),
        svc
            ? check('Driver service', svcUp ? (svcSeconds !== null && svcSeconds < 30 ? 'warn' : 'ok') : 'bad',
                svc.name + ': ' + svc.status + (svcUp && svcSeconds !== null && svcSeconds < 30 ? ' (recently restarted - watch whether it keeps restarting)' : ''))
            : check('Driver service', driverProcess ? 'info' : 'bad', svcRaw
                ? svcRaw.name + ': svstat needs root (' + svcRaw.status + '), using the process check'
                : (driverProcess ? 'no /service entry visible, using the process check' : 'no /service/dbus-serialbattery.*')),
        check('Driver process', driverProcess ? (driverProcess.uptimeSec < 30 ? 'warn' : 'ok') : 'bad',
            driverProcess ? 'pid ' + driverProcess.pid + ', running ' + driverProcess.uptimeText : 'dbus-serialbattery.py is not running'),
        check('BMS on D-Bus', dbusData.battery ? (toNumber(bat['/Connected']) === 1 ? 'ok' : 'bad') : 'bad',
            dbusData.battery ? dbusData.battery + ', Connected=' + display(bat['/Connected']) : (dbusData.error || 'no com.victronenergy.battery.tty* service')),
        check('BMS_TYPE in config.ini', configMap.BMS_TYPE ? 'ok' : 'warn',
            configMap.BMS_TYPE ? 'BMS_TYPE = ' + configMap.BMS_TYPE : (parsed.configError ? 'config.ini ' + parsed.configError : 'not set: the driver scans all BMS types (~1 min) after every boot')),
        check('config.ini duplicates', duplicates.length ? 'warn' : 'ok', duplicates.length ? 'duplicate keys: ' + duplicates.join(', ') : 'none'),
        check('DVCC', dvccOn ? 'ok' : 'bad', dvccOn ? 'on' : 'off or unknown (' + display(set['/Settings/Services/Bol']) + ')'),
        check('Controlling BMS / active BMS', activeBmsOk ? 'ok' : 'bad',
            'active: ' + display(activeBms) + ' | setting: ' + display(bmsSetting)),
        check('Watchdog remembered setting', parsed.good ? 'ok' : 'warn', parsed.good ? parsed.good : 'none yet (saved automatically while a BMS is active)'),
        check('MultiPlus state', vebusState === null ? 'warn' : (vebusState === 8 || vebusState === 2 ? 'bad' : 'ok'),
            vebusState === null ? 'no VE.Bus service' : vebusState + ' ' + (VEBUS_STATES[vebusState] || '') + ', mode ' + display(vebusMode) + ' ' + (VEBUS_MODES[vebusMode] || '')),
        check('MultiPlus BMS alarms', bmsLost || lowBattery ? 'bad' : 'ok',
            'BMS connection lost=' + bmsLost + ', low battery=' + lowBattery + ', VE.Bus error=' + display(vebusError)),
        check('Battery alarms', batteryAlarms.length ? 'bad' : 'ok', batteryAlarms.length ? batteryAlarms.join(', ') : 'none'),
        check('Cell balance', cellSpreadMv === null ? 'warn' : (cellSpreadMv > 100 ? 'bad' : (cellSpreadMv > 40 ? 'warn' : 'ok')),
            cellSpreadMv === null ? 'no cell data' : cellSpreadMv + ' mV (min ' + minCell + ' V / max ' + maxCell + ' V)'),
        check('Active alarms (all devices)', alarmList.length ? 'bad' : 'ok', alarmList.length ? alarmList.length + ' active' : 'none')
    ];
    const worst = checks.some(item => item.level === 'bad') ? 'bad' : (checks.some(item => item.level === 'warn') ? 'warn' : 'ok');

    // Timeline sample (repair test monitor)
    const sample = {
        time: (parsed.now || '').substring(11, 19),
        active: display(activeBms),
        setting: display(bmsSetting),
        vebusState: vebusState === null ? '—' : vebusState + ' ' + (VEBUS_STATES[vebusState] || ''),
        bmsLost,
        lowBattery,
        ok: activeBmsOk && vebusState !== 8 && !bmsLost
    };
    state.timeline = (state.timeline || []).concat([sample]).slice(-TIMELINE_LENGTH);

    return {
        updatedAt: new Date().toISOString(),
        sampledAt: parsed.now || '',
        user: parsed.user || '',
        overall: worst,
        checks,
        battery: {
            service: dbusData.battery || '',
            rows: BATTERY_PATHS.filter(path => path !== '/Alarms').map(path => ({ path, value: display(bat[path]) })),
            cellSpreadMv
        },
        driver: {
            service: svcRaw,
            processes,
            ttys: parsed.ttys,
            config: parsed.config,
            configError: parsed.configError
        },
        system: {
            rows: SYSTEM_PATHS.map(path => ({ path, value: display(sys[path]) }))
                .concat(SETTINGS_PATHS.map(path => ({ path, value: display(set[path]) })))
        },
        vebus: {
            service: dbusData.vebus || '',
            rows: VEBUS_PATHS.map(path => {
                const value = veb[path];
                let text = display(value);
                if (path === '/State' && toNumber(value) !== null) {
                    text += ' (' + (VEBUS_STATES[toNumber(value)] || '?') + ')';
                }
                if (path === '/Mode' && toNumber(value) !== null) {
                    text += ' (' + (VEBUS_MODES[toNumber(value)] || '?') + ')';
                }
                return { path, value: text };
            })
        },
        alarms: alarmList,
        watchdog,
        good: parsed.good,
        timeline: state.timeline.slice().reverse(),
        logDirs: parsed.logDirs,
        log: state.log || null,
        dbusError: dbusData.error || '',
        logLineChoices: LOG_LINE_CHOICES
    };
}

let state = flow.get(STATE_KEY) || { busySince: 0, timeline: [], logDirs: [], log: null, view: null };
const nowTs = Date.now();

function emit(execMsg, watchdogMsg) {
    flow.set(STATE_KEY, state);
    const view = state.view ? Object.assign({}, state.view, { log: state.log, busy: Boolean(state.busySince) }) : null;
    return [view ? { topic: 'driver-status', payload: view } : null, execMsg || null, watchdogMsg || null];
}

if (msg.topic === 'driver-exec') {
    state.busySince = 0;
    if (msg.driverStep === 'logs') {
        const lines = [];
        let file = '';
        String(msg.payload || '').split(/\r?\n/).forEach(line => {
            if (line.startsWith('@@LOGFILE ')) {
                file = line.substring(10).trim();
            }
            else if (line.startsWith('@@L ')) {
                lines.push(line.substring(4));
            }
            else if (line === '@@L') {
                lines.push('');
            }
        });
        state.log = { file, text: lines.join('\n') || '(empty)', lineCount: lines.length, loadedAt: new Date().toISOString() };
        return emit();
    }

    const parsed = parseChecks(msg.payload);
    state.logDirs = parsed.logDirs;
    state.view = buildView(parsed, state);
    return emit();
}

const command = msg.topic === 'driver-command' && msg.payload && typeof msg.payload === 'object' ? msg.payload : { action: 'refresh' };
const action = String(command.action || 'refresh');

if (action === 'clear-timeline') {
    state.timeline = [];
    if (state.view) {
        state.view.timeline = [];
    }
    return emit();
}

if (action === 'watchdog' || action === 'restore-bms') {
    // The watchdog does the work; refresh the checks a bit later from the dashboard.
    return emit(null, { topic: action === 'restore-bms' ? 'bms-watchdog-force' : 'bms-watchdog-tick' });
}

if (state.busySince && nowTs - state.busySince < BUSY_TIMEOUT_MS) {
    return emit();
}

if (action === 'logs') {
    const logDir = String(command.log || '');
    const lines = LOG_LINE_CHOICES.includes(Number(command.lines)) ? Number(command.lines) : LOG_LINE_CHOICES[1];
    if (!(state.logDirs || []).includes(logDir)) {
        state.log = { file: logDir, text: 'Unknown log - refresh the checks first.', lineCount: 0, loadedAt: new Date().toISOString() };
        return emit();
    }
    state.busySince = nowTs;
    return emit({ topic: 'driver-exec', driverStep: 'logs', payload: shellQuote(buildLogScript(logDir, lines)) });
}

state.busySince = nowTs;
return emit({ topic: 'driver-exec', driverStep: 'checks', payload: shellQuote(CHECK_SCRIPT) });
