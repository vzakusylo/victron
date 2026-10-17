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

const SCRIPT = [
    'echo "@@HOST $(hostname 2>/dev/null)"',
    'echo "@@USER $(id -un 2>/dev/null)"',
    'echo "@@KERNEL $(uname -r 2>/dev/null)"',
    'echo "@@MODEL $(tr -d "\\000" 2>/dev/null < /proc/device-tree/model)"',
    'echo "@@VENUS $(head -n 2 /opt/victronenergy/version 2>/dev/null | tr "\\n" " ")"',
    'echo "@@DATE $(date "+%Y-%m-%d %H:%M:%S %Z")"',
    'echo "@@UPTIME $(cat /proc/uptime)"',
    'echo "@@LOAD $(cat /proc/loadavg)"',
    'echo "@@NCPU $(grep -c "^processor" /proc/cpuinfo)"',
    'echo "@@CPUMODEL $(grep -m 1 -i -E "^(model name|hardware|cpu model)" /proc/cpuinfo | cut -d: -f2-)"',
    'for t in /sys/class/thermal/thermal_zone*/temp; do [ -r "$t" ] && echo "@@TEMP ${t%/temp} $(cat "$t")"; done',
    'grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo | sed "s/^/@@MEM /"',
    'df -Pk 2>/dev/null | sed "1d; s/^/@@DF /"',
    'ip -o -4 addr show 2>/dev/null | sed "s/^/@@IP /"',
    'sample() {',
    '  echo "@@SAMPLE $1"',
    '  head -n 1 /proc/stat | sed "s/^/@@CPU /"',
    '  sed "1,2d; s/^/@@NET /" /proc/net/dev 2>/dev/null',
    '  for d in /proc/[0-9]*; do read -r st 2>/dev/null < "$d/stat" && echo "@@P $st"; done',
    '}',
    'sample 1',
    'sleep 1',
    'sample 2',
    // Full command line + owner straight from /proc: `comm` is cut to 15 chars (e.g. "dbus-serialbatt")
    // and BusyBox `ps` has no -e and truncates args, so it cannot be relied on.
    'cut -d: -f1,3 /etc/passwd 2>/dev/null | sed "s/^/@@PASSWD /"',
    'for d in /proc/[0-9]*; do',
    '  u=""; while read -r k v rest; do [ "$k" = "Uid:" ] && { u=$v; break; }; done 2>/dev/null < "$d/status"',
    '  printf "@@ARGS %s %s " "${d#/proc/}" "${u:--}"; tr "\\000" " " 2>/dev/null < "$d/cmdline"; echo',
    'done',
    'sed "1d; s/^/@@TCP /" /proc/net/tcp 2>/dev/null',
    'sed "1d; s/^/@@TCP6 /" /proc/net/tcp6 2>/dev/null',
    'true'
].join('\n');

function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
}

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

function parseProcStat(line) {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    if (open < 0 || close < 0) {
        return null;
    }
    const rest = line.substring(close + 2).split(' ');
    // field n of /proc/<pid>/stat is rest[n - 3]
    return {
        pid: Number(line.substring(0, open).trim()),
        comm: line.substring(open + 1, close),
        state: rest[0],
        ticks: (Number(rest[11]) || 0) + (Number(rest[12]) || 0),
        threads: Number(rest[17]) || 1,
        rssKb: (Number(rest[21]) || 0) * PAGE_KB
    };
}

function parseCpuLine(line) {
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (values[3] || 0) + (values[4] || 0);
    const total = values.slice(0, 8).reduce((sum, value) => sum + (value || 0), 0);
    return { idle, total };
}

function hexToIpv4(hex) {
    const parts = [];
    for (let index = 6; index >= 0; index -= 2) {
        parts.push(parseInt(hex.substring(index, index + 2), 16));
    }
    return parts.join('.');
}

function hexToIp(hex) {
    if (hex.length === 8) {
        return hexToIpv4(hex);
    }
    // IPv6: four little-endian 32-bit words
    const words = [0, 1, 2, 3].map(index => hex.substring(index * 8, index * 8 + 8));
    const bytes = [];
    words.forEach(word => {
        for (let index = 6; index >= 0; index -= 2) {
            bytes.push(word.substring(index, index + 2));
        }
    });
    const joined = bytes.join('').toLowerCase();
    if (joined.startsWith('00000000000000000000ffff')) {
        return hexToIpv4(words[3]);
    }
    if (/^0+$/.test(joined)) {
        return '::';
    }
    if (joined === '00000000000000000000000000000001') {
        return '::1';
    }
    const groups = [];
    for (let index = 0; index < 32; index += 4) {
        groups.push(joined.substring(index, index + 4).replace(/^0{1,3}/, ''));
    }
    return groups.join(':');
}

function parseTcpLine(line, family) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[1].indexOf(':') < 0) {
        return null;
    }
    const [localHex, localPortHex] = parts[1].split(':');
    const [remoteHex, remotePortHex] = parts[2].split(':');
    return {
        family,
        localIp: hexToIp(localHex),
        localPort: parseInt(localPortHex, 16),
        remoteIp: hexToIp(remoteHex),
        remotePort: parseInt(remotePortHex, 16),
        state: TCP_STATES[parts[3].toUpperCase()] || parts[3]
    };
}

function portLabel(port) {
    return KNOWN_PORTS[port] || '';
}

function parseOutput(rawText) {
    const info = { temps: [], mem: {}, disks: [], ips: [], tcp: [], ps: {}, users: {} };
    const samples = { 1: { cpu: null, net: {}, procs: {} }, 2: { cpu: null, net: {}, procs: {} } };
    let sample = 1;

    String(rawText || '').split(/\r?\n/).forEach(line => {
        const match = line.match(/^@@([A-Z0-9]+) ?(.*)$/);
        if (!match) {
            return;
        }
        const value = match[2];
        const current = samples[sample];

        switch (match[1]) {
            case 'HOST': info.host = value.trim(); break;
            case 'USER': info.user = value.trim(); break;
            case 'KERNEL': info.kernel = value.trim(); break;
            case 'MODEL': info.model = value.trim(); break;
            case 'VENUS': info.venus = value.trim(); break;
            case 'DATE': info.date = value.trim(); break;
            case 'UPTIME': info.uptimeSec = Number(value.trim().split(/\s+/)[0]) || 0; break;
            case 'LOAD': {
                const parts = value.trim().split(/\s+/);
                info.load = [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
                info.runnable = parts[3] || '';
                break;
            }
            case 'NCPU': info.ncpu = Math.max(1, Number(value) || 1); break;
            case 'CPUMODEL': info.cpuModel = value.trim(); break;
            case 'TEMP': {
                const parts = value.trim().split(/\s+/);
                const milli = Number(parts[1]);
                if (Number.isFinite(milli)) {
                    info.temps.push({ zone: (parts[0] || '').split('/').pop(), celsius: Math.round(milli / 100) / 10 });
                }
                break;
            }
            case 'MEM': {
                const parts = value.trim().match(/^(\w+):\s+(\d+)/);
                if (parts) {
                    info.mem[parts[1]] = Number(parts[2]) || 0;
                }
                break;
            }
            case 'DF': {
                const parts = value.trim().split(/\s+/);
                if (parts.length >= 6 && Number(parts[1]) > 0) {
                    info.disks.push({
                        fs: parts[0],
                        mount: parts.slice(5).join(' '),
                        totalKb: Number(parts[1]) || 0,
                        usedKb: Number(parts[2]) || 0,
                        availableKb: Number(parts[3]) || 0,
                        usePct: parseInt(parts[4], 10) || 0
                    });
                }
                break;
            }
            case 'IP': {
                const parts = value.trim().match(/^\d+:\s+(\S+)\s+inet\s+(\S+)/);
                if (parts) {
                    info.ips.push({ iface: parts[1], cidr: parts[2] });
                }
                break;
            }
            case 'SAMPLE': sample = Number(value) === 2 ? 2 : 1; break;
            case 'CPU': samples[sample].cpu = parseCpuLine(value); break;
            case 'NET': {
                const parts = value.split(':');
                if (parts.length >= 2) {
                    const fields = parts[1].trim().split(/\s+/).map(Number);
                    current.net[parts[0].trim()] = { rx: fields[0] || 0, tx: fields[8] || 0 };
                }
                break;
            }
            case 'P': {
                const proc = parseProcStat(value);
                if (proc) {
                    current.procs[proc.pid] = proc;
                }
                break;
            }
            case 'PASSWD': {
                const parts = value.trim().split(':');
                if (parts.length >= 2) {
                    info.users[parts[1]] = parts[0];
                }
                break;
            }
            case 'ARGS': {
                const parts = value.match(/^(\d+) (\S+) ?(.*)$/);
                if (parts) {
                    info.ps[Number(parts[1])] = { uid: parts[2], args: parts[3].trim() };
                }
                break;
            }
            case 'TCP':
            case 'TCP6': {
                const entry = parseTcpLine(value, match[1] === 'TCP6' ? 'IPv6' : 'IPv4');
                if (entry) {
                    info.tcp.push(entry);
                }
                break;
            }
            default:
                break;
        }
    });

    return { info, samples };
}

function buildView(parsed) {
    const { info, samples } = parsed;
    const ncpu = info.ncpu || 1;
    const cpu1 = samples[1].cpu;
    const cpu2 = samples[2].cpu;
    const deltaTotal = cpu1 && cpu2 ? Math.max(1, cpu2.total - cpu1.total) : 1;
    const cpuUsagePct = cpu1 && cpu2 ? Math.round((1 - (cpu2.idle - cpu1.idle) / deltaTotal) * 1000) / 10 : null;
    const elapsedSec = deltaTotal / ncpu / 100; // USER_HZ = 100

    // Processes
    const processes = Object.keys(samples[2].procs).map(pidKey => {
        const proc = samples[2].procs[pidKey];
        const before = samples[1].procs[pidKey];
        const psInfo = info.ps[proc.pid] || {};
        return {
            pid: proc.pid,
            name: proc.comm,
            user: psInfo.uid === undefined || psInfo.uid === '-' ? '' : (info.users[psInfo.uid] || psInfo.uid),
            // kernel threads have an empty cmdline
            args: String(psInfo.args || '[' + proc.comm + ']').substring(0, 160),
            cpuPct: before ? Math.round((proc.ticks - before.ticks) / deltaTotal * 1000) / 10 : 0,
            rssKb: proc.rssKb,
            rssText: formatBytes(proc.rssKb * 1024),
            threads: proc.threads,
            state: proc.state
        };
    });
    const threadCount = processes.reduce((sum, proc) => sum + proc.threads, 0);
    const topCpu = processes.slice().sort((a, b) => b.cpuPct - a.cpuPct || b.rssKb - a.rssKb).slice(0, 12);
    const topMem = processes.slice().sort((a, b) => b.rssKb - a.rssKb).slice(0, 12);

    // Key services
    const services = KEY_SERVICES.map(service => {
        const matches = processes.filter(proc => service.pattern.test(proc.args) || service.pattern.test(proc.name));
        return {
            name: service.name,
            running: matches.length > 0,
            pids: matches.map(proc => proc.pid).join(', '),
            cpuPct: Math.round(matches.reduce((sum, proc) => sum + proc.cpuPct, 0) * 10) / 10,
            rssText: formatBytes(matches.reduce((sum, proc) => sum + proc.rssKb, 0) * 1024)
        };
    });

    // Memory
    const mem = info.mem;
    const memTotalKb = mem.MemTotal || 0;
    const memAvailableKb = mem.MemAvailable !== undefined ? mem.MemAvailable : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0);
    const memUsedKb = Math.max(0, memTotalKb - memAvailableKb);
    const memUsedPct = memTotalKb ? Math.round(memUsedKb / memTotalKb * 1000) / 10 : 0;
    const swapTotalKb = mem.SwapTotal || 0;
    const swapUsedKb = Math.max(0, swapTotalKb - (mem.SwapFree || 0));

    // Disks: real filesystems first, tmpfs after
    const disks = info.disks.map(disk => Object.assign({}, disk, {
        totalText: formatBytes(disk.totalKb * 1024),
        usedText: formatBytes(disk.usedKb * 1024),
        availableText: formatBytes(disk.availableKb * 1024),
        isTmp: /tmpfs|devtmpfs|none|overlay/.test(disk.fs),
        level: disk.usePct >= 90 ? 'critical' : (disk.usePct >= 75 ? 'warning' : 'ok')
    })).sort((a, b) => Number(a.isTmp) - Number(b.isTmp) || a.mount.localeCompare(b.mount));

    // Network
    const interfaces = Object.keys(samples[2].net)
        .filter(name => name !== 'lo')
        .map(name => {
            const now = samples[2].net[name];
            const before = samples[1].net[name] || now;
            const ips = info.ips.filter(ip => ip.iface === name).map(ip => ip.cidr).join(', ');
            return {
                name,
                ips,
                rxRate: formatBytes(Math.max(0, now.rx - before.rx) / Math.max(0.5, elapsedSec)) + '/s',
                txRate: formatBytes(Math.max(0, now.tx - before.tx) / Math.max(0.5, elapsedSec)) + '/s',
                rxTotal: formatBytes(now.rx),
                txTotal: formatBytes(now.tx)
            };
        })
        .filter(iface => iface.ips || iface.rxTotal !== '0 B');

    // TCP
    const stateCounts = {};
    info.tcp.forEach(entry => { stateCounts[entry.state] = (stateCounts[entry.state] || 0) + 1; });
    const listenMap = {};
    info.tcp.filter(entry => entry.state === 'LISTEN').forEach(entry => {
        const key = entry.localPort;
        if (!listenMap[key]) {
            listenMap[key] = { port: entry.localPort, label: portLabel(entry.localPort), addresses: [] };
        }
        const address = entry.localIp + ' (' + entry.family + ')';
        if (listenMap[key].addresses.indexOf(address) < 0) {
            listenMap[key].addresses.push(address);
        }
    });
    const listening = Object.keys(listenMap).map(key => listenMap[key]).sort((a, b) => a.port - b.port);
    const listenPorts = new Set(listening.map(entry => entry.port));
    const established = info.tcp
        .filter(entry => entry.state === 'ESTABLISHED')
        .map(entry => {
            const inbound = listenPorts.has(entry.localPort);
            return {
                direction: inbound ? 'in' : 'out',
                local: entry.localIp + ':' + entry.localPort,
                remote: entry.remoteIp + ':' + entry.remotePort,
                service: inbound ? portLabel(entry.localPort) : (REMOTE_PORTS[entry.remotePort] || ''),
                loopback: /^127\.|^::1$/.test(entry.remoteIp)
            };
        });
    // Loopback connections (local services talking to each other) are only counted.
    const loopbackCount = established.filter(entry => entry.loopback).length;
    const external = established
        .filter(entry => !entry.loopback)
        .sort((a, b) => a.direction.localeCompare(b.direction) || a.remote.localeCompare(b.remote));

    // Health warnings
    const warnings = [];
    if (cpuUsagePct !== null && cpuUsagePct >= 85) {
        warnings.push('CPU usage ' + cpuUsagePct + '%');
    }
    if (info.load && info.load[1] > ncpu * 1.5) {
        warnings.push('Load (5 min) ' + info.load[1] + ' on ' + ncpu + ' CPU');
    }
    if (memTotalKb && memAvailableKb / memTotalKb < 0.15) {
        warnings.push('Low memory: ' + formatBytes(memAvailableKb * 1024) + ' available');
    }
    disks.filter(disk => !disk.isTmp && disk.usePct >= 85).forEach(disk => warnings.push('Disk ' + disk.mount + ' ' + disk.usePct + '% full'));
    info.temps.filter(temp => temp.celsius >= 75).forEach(temp => warnings.push('Temperature ' + temp.celsius + ' °C'));
    services.filter(service => !service.running && /Node-RED|dbus-serialbattery|VE.Bus|System calc/.test(service.name))
        .forEach(service => warnings.push(service.name + ' is not running'));

    return {
        updatedAt: new Date().toISOString(),
        sampledAt: info.date || '',
        host: info.host || '',
        user: info.user || '',
        model: info.model || '',
        venus: info.venus || '',
        kernel: info.kernel || '',
        uptimeText: formatDuration(info.uptimeSec),
        cpu: {
            usagePct: cpuUsagePct,
            ncpu,
            model: info.cpuModel || '',
            load: info.load || [0, 0, 0],
            runnable: info.runnable || '',
            level: cpuUsagePct >= 85 ? 'critical' : (cpuUsagePct >= 60 ? 'warning' : 'ok')
        },
        memory: {
            totalText: formatBytes(memTotalKb * 1024),
            usedText: formatBytes(memUsedKb * 1024),
            availableText: formatBytes(memAvailableKb * 1024),
            usedPct: memUsedPct,
            cachedText: formatBytes(((mem.Cached || 0) + (mem.Buffers || 0)) * 1024),
            swapText: swapTotalKb ? formatBytes(swapUsedKb * 1024) + ' of ' + formatBytes(swapTotalKb * 1024) : 'none',
            level: memUsedPct >= 85 ? 'critical' : (memUsedPct >= 70 ? 'warning' : 'ok')
        },
        temps: info.temps,
        disks,
        interfaces,
        tcp: {
            total: info.tcp.length,
            established: stateCounts.ESTABLISHED || 0,
            listen: stateCounts.LISTEN || 0,
            timeWait: stateCounts.TIME_WAIT || 0,
            other: info.tcp.length - (stateCounts.ESTABLISHED || 0) - (stateCounts.LISTEN || 0) - (stateCounts.TIME_WAIT || 0),
            listening,
            loopback: loopbackCount,
            connections: external.slice(0, 40),
            connectionsHidden: Math.max(0, external.length - 40)
        },
        processes: {
            count: processes.length,
            threads: threadCount,
            topCpu,
            topMem
        },
        services,
        warnings
    };
}

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
