//! Node 29: Build the device status view.
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
