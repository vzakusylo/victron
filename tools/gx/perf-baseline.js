'use strict';

const { spawnSync } = require('node:child_process');

const INTERVAL_S = 10;

function parseStat(line) {
    // comm is parenthesized and can contain spaces and closing parentheses.
    const open = line.indexOf(' (');
    const close = line.lastIndexOf(') ');
    const fields = line.slice(close + 2).trim().split(/\s+/);
    const pid = Number(line.slice(0, open));
    const [parent, user, system, start] = [1, 11, 12, 19].map(i => Number(fields[i]));
    if (open < 1 || close < open || pid < 1 ||
        ![pid, parent, user, system, start].every(n => Number.isSafeInteger(n) && n >= 0)) {
        throw new Error('Invalid /proc stat record');
    }
    return { pid, name: line.slice(open + 2, close), parent, cpuTicks: user + system, id: `${pid}:${start}` };
}

function descendants(processes, root) {
    const children = new Map();
    for (const p of processes) {
        if (!children.has(p.parent)) children.set(p.parent, []);
        children.get(p.parent).push(p);
    }
    const pending = [root];
    const found = [];
    while (pending.length) {
        for (const p of children.get(pending.pop()) || []) {
            pending.push(p.pid);
            found.push(p.id);
        }
    }
    return found;
}

async function sampleRemote(durationS, intervalS) {
    const fs = require('node:fs');
    const http = require('node:http');
    const { execFileSync } = require('node:child_process');
    const { performance } = require('node:perf_hooks');
    const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    if (!Number.isSafeInteger(hz) || hz <= 0) throw new Error('Cannot determine Linux clock tick frequency');
    const port = Number(process.env.VICTRON_API_PORT) || 1880;
    function probe() {
        return new Promise((resolve, reject) => {
            const start = performance.now();
            const req = http.get({ host: '127.0.0.1', port, path: '/flows', headers: { 'Node-RED-API-Version': 'v2' } }, res => {
                const ms = performance.now() - start;
                res.on('error', reject);
                res.resume();
                res.on('end', () => {
                    if (res.statusCode !== 200) reject(new Error(`Node-RED admin GET /flows returned ${res.statusCode}`));
                    else resolve(ms);
                });
            });
            const timer = setTimeout(() => req.destroy(new Error('Node-RED admin request timed out')), 5000);
            req.on('close', () => clearTimeout(timer));
            req.on('error', reject);
        });
    }
    const samples = [];
    const started = performance.now();
    let nodeRed;
    for (let offset = 0; offset <= durationS; offset += intervalS) {
        const delay = started + offset * 1000 - performance.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        const atS = (performance.now() - started) / 1000;
        const processes = fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap(pid => {
            try { return [parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))]; }
            catch (err) {
                if (!['ENOENT', 'ESRCH'].includes(err.code)) throw err;
                return [];
            }
        });
        if (!nodeRed) {
            const matches = processes.filter(p => p.name === 'node-red');
            if (matches.length !== 1) throw new Error(`Expected one node-red process, found ${matches.length}`);
            nodeRed = matches[0];
        }
        const p = processes.find(p => p.id === nodeRed.id);
        if (!p) throw new Error('Node-RED restarted or exited during the baseline');
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'));
        if (!rss) throw new Error('Missing VmRSS for Node-RED');
        samples.push({ atS, cpuTicks: p.cpuTicks, rssKiB: Number(rss[1]), children: descendants(processes, p.pid),
            adminTtfbMs: await probe() });
    }
    return { hz, samples };
}

function parseSamples(text) {
    const { hz, samples } = JSON.parse(text);
    if (!Number.isSafeInteger(hz) || hz <= 0 || !Array.isArray(samples) || samples.length < 2 ||
        samples.some((p, i) => !p || ![p.atS, p.cpuTicks, p.rssKiB, p.adminTtfbMs].every(n => Number.isFinite(n) && n >= 0) ||
            !Array.isArray(p.children) || p.children.some(id => !/^\d+:\d+$/.test(id)) ||
            (i > 0 && (p.atS <= samples[i - 1].atS || p.cpuTicks < samples[i - 1].cpuTicks)))) {
        throw new Error('Invalid GX performance samples');
    }
    return { hz, samples };
}

function summarize({ hz, samples }) {
    const first = samples[0];
    const last = samples.at(-1);
    const durationS = last.atS - first.atS;
    const seen = new Set(samples.flatMap(p => p.children));
    const observedSpawns = seen.size - new Set(first.children).size;
    const latencies = samples.map(p => p.adminTtfbMs).sort((a, b) => a - b);
    const percentile = p => latencies[Math.ceil(p * latencies.length) - 1];
    return {
        durationS, intervalS: INTERVAL_S, sampleCount: samples.length,
        cpuPct: 100 * (last.cpuTicks - first.cpuTicks) / hz / durationS,
        rssMeanMiB: samples.reduce((sum, p) => sum + p.rssKiB, 0) / samples.length / 1024,
        rssMaxMiB: Math.max(...samples.map(p => p.rssKiB)) / 1024,
        observedSpawns, observedSpawnsPerHour: observedSpawns * 3600 / durationS,
        adminTtfbMsP50: percentile(0.5), adminTtfbMsP95: percentile(0.95)
    };
}

function collect(durationMin, env, exec = spawnSync) {
    const host = env.GX_SSH_HOST;
    const key = env.GX_SSH_KEY_PATH;
    if (!host || !/^[a-zA-Z0-9][-a-zA-Z0-9_.]*@[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(host) || !key) {
        throw new Error('Set GX_SSH_HOST (user@host) and GX_SSH_KEY_PATH (private key file path)');
    }
    const durationS = durationMin * 60;
    if (!Number.isSafeInteger(durationMin) || durationMin < 1 || durationMin > 120) {
        throw new Error('Duration must be a whole number of minutes from 1 to 120');
    }
    const script = `${parseStat}\n${descendants}\n${sampleRemote}\n` +
        `sampleRemote(${durationS}, ${INTERVAL_S}).then(r => console.log(JSON.stringify(r)), err => {\n` +
        `console.error(err.message); process.exitCode = 1;\n});\n`;
    const result = exec('ssh', ['-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', host, 'node -'],
    { input: script, encoding: 'utf8', timeout: (durationS + 30) * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`GX sampler failed: ${String(result.stderr || result.signal).trim()}`);
    const data = parseSamples(result.stdout);
    if (data.samples.length !== durationS / INTERVAL_S + 1) throw new Error('Incomplete GX baseline');
    return { summary: summarize(data), ...data };
}

function markdown(s) {
    const row = [s.cpuPct, s.rssMeanMiB, s.rssMaxMiB, s.observedSpawnsPerHour, s.adminTtfbMsP50, s.adminTtfbMsP95];
    return '| CPU % | RSS mean MiB | RSS max MiB | Observed spawns/h | Admin TTFB p50 ms | Admin TTFB p95 ms |\n' +
        '|---:|---:|---:|---:|---:|---:|\n' + `| ${row.map(n => n.toFixed(2)).join(' | ')} |`;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length && (args.length !== 2 || args[0] !== '--minutes' || !/^\d+$/.test(args[1]))) {
            throw new Error('Usage: node tools/gx/perf-baseline.js [--minutes 15]');
        }
        const data = collect(args.length ? Number(args[1]) : 15, process.env);
        console.log(JSON.stringify(data, null, 2));
        console.error(markdown(data.summary));
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

module.exports = { collect, descendants, markdown, parseSamples, parseStat, summarize };
