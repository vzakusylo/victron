//! Node 29: Parse device status sampler output.
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
