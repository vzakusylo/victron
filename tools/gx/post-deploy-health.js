'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');

const HEALTH_MIN = 60000;
const RESULT_FILE = '/data/home/nodered/post-deploy-health.json';
const LOG_FILE = '/var/log/node-red-venus/current';
const CONTEXT = /^context\/(flow\/|node\/[\w-]+\/)([\w-]+)(?:\.([\w.]+))?$/;
const DBUS = /^dbus:([\w.]+)(\*)?(\/[\w/]+)$/;

function logTime(line) {
    const m = /^@([0-9a-f]{16})([0-9a-f]{8}) /.exec(line);
    return m ? Number(BigInt('0x' + m[1]) - (1n << 62n) - 10n) * 1000 +
        Math.floor(parseInt(m[2], 16) / 1e6) : null;
}

function readLog(file) {
    const dir = path.dirname(file);
    const rotated = fs.readdirSync(dir).filter(name => /^@[0-9a-f]{24}\.[su]$/.test(name));
    const lines = [...rotated.sort(), path.basename(file)].flatMap(name => {
        try {
            return fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n');
        } catch (error) {
            if (error.code === 'ENOENT' && name !== path.basename(file)) return []; // Rotation during the read.
            throw error;
        }
    });
    return lines.map(line => ({ at: logTime(line), line })).filter(row => row.at !== null).sort((a, b) => a.at - b.at);
}

function logStats(config, rows, started, now) {
    const [stop, starting, startedPattern] = ['stop', 'starting', 'started'].map(key => new RegExp(config.log[key], 'i'));
    let stoppedAt = null, restartedAt = started, starts = 0, downtime = 0, sawStarting = false;
    const entries = rows.filter(row => row.at >= started && row.at <= now);
    for (const { line, at } of entries) {
        if (stop.test(line)) {
            stoppedAt ??= at;
            restartedAt = at;
            sawStarting = false;
        } else if (starting.test(line)) {
            starts++;
            restartedAt = at;
            sawStarting = true;
        } else if (startedPattern.test(line)) {
            if (!sawStarting) starts++; // Starts with no preceding line (e.g. runtime log level).
            if (stoppedAt !== null) downtime += at - stoppedAt;
            stoppedAt = null;
            restartedAt = at;
            sawStarting = false;
        }
    }
    return { entries, restartedAt, starts, downtime: downtime + (stoppedAt === null ? 0 : now - stoppedAt),
        covered: rows.some(row => row.at <= started) };
}

function ownedErrors(entries, check, owned) {
    const pattern = new RegExp(check.pattern);
    const warningSources = check.warningSources.map(rule => ({ ...rule, pattern: new RegExp(rule.pattern) }));
    let failures = 0, warnings = 0;
    for (const { line } of entries) {
        const match = pattern.exec(line);
        if (!match) continue;
        const nodes = owned.filter(n => (!check.node || n.id === check.node) && n.labels.includes(match[1]));
        if (!nodes.length) continue;
        if (nodes.every(node => warningSources.some(rule => rule.node === node.id && rule.pattern.test(match[2])))) warnings++;
        else failures++;
    }
    return { failures, warnings };
}

function numeric(value) {
    return typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
}

const sources = check => Array.isArray(check.source) ? check.source : [check.source];
const ok = detail => ({ level: 'OK', detail });
const failed = (check, detail) => ({ level: check.severity, detail });
const fresh = (at, age, state) => Number.isFinite(at) && at >= state.restartedAt &&
    state.now - at <= age * HEALTH_MIN && at <= state.now;

const conditions = {
    fresh(check, [at], state) {
        return fresh(at, check.maxAgeMin, state) ? ok('Tick is fresh') : failed(check, 'Tick is missing or stale');
    },
    finite(check, [view], state) {
        return fresh(view?.at, check.maxAgeMin, state) && Number.isFinite(view[check.field])
            ? ok(`Outdoor average: ${view[check.field]} °C`) : failed(check, 'No fresh outdoor average');
    },
    ownerCurve(check, [view, hp, heat], state) {
        if (!fresh(view?.at, check.maxAgeMin, state) || typeof view.state !== 'string' || typeof view.outHeld !== 'boolean') {
            return failed(check, 'No fresh heating or defrost state');
        }
        if (view.state !== 'HEATING' || view.outHeld) return { level: 'SKIP', detail: 'DHW or defrost/recovery active' };
        const owner = view.heatCurve;
        if (![owner?.p23, owner?.p24].every(Number.isFinite)) return failed(check, 'No stored owner curve');
        if (hp?.state !== 'CONNECTED' || !fresh(hp.lastData, check.deviceMaxAgeMin, state)) return failed(check, 'No fresh heat pump data');
        const p23 = numeric(hp.dps?.['133']), p24 = numeric(hp.dps?.['134']);
        if (![p23, p24].every(Number.isFinite)) return failed(check, 'P23 or P24 unavailable');
        if (p23 === owner.p23 && p24 === owner.p24) return ok('P23/P24 match the owner curve');
        if (check.allowHeatingOverride && (heat?.boost > 0 || heat?.warmApplied > 0) &&
            p23 === heat.curveCmd?.p23 && p24 === heat.curveCmd?.p24) return ok('P23/P24 match the active heating override');
        return failed(check, `P23/P24 ${p23}/${p24} do not match owner ${owner.p23}/${owner.p24}`);
    },
    confirmed(check, [view], state) {
        if (!fresh(view?.at, check.maxAgeMin, state)) return failed(check, 'No fresh curve confirmation state');
        const result = view.ownerCurveResult;
        if (result?.ok !== false || !new RegExp(check.pattern, 'i').test(result.text)) return ok('No unconfirmed curve change');
        // The view does not timestamp confirmation results. Age the observed state, not the original request.
        const key = createHash('sha256').update(String(result.requestId)).digest('hex');
        const since = state.prior?.key === key ? state.prior.since : state.now;
        const resultState = state.now - since > check.holdMin * HEALTH_MIN ? failed(check, 'Curve change stayed unconfirmed')
            : { level: 'WAIT', detail: 'Curve change not confirmed yet' };
        return { ...resultState, since, key };
    },
    watchdogOk(check, [watchdog], state) {
        return watchdog?.status === 'ok' && fresh(Date.parse(watchdog.checkedAt), check.maxAgeMin, state)
            ? ok('Watchdog OK') : failed(check, 'Watchdog not OK or stale');
    },
    equals(check, [actual]) {
        return actual === check.expected ? ok('SerialBattery connected') : failed(check, 'SerialBattery not connected');
    },
    ownedErrors(check, [log], state) {
        const { failures, warnings } = ownedErrors(log.entries, check, state.owned);
        const counts = check.node ? `${failures} node error(s)` : `${failures} owned error(s), ${warnings} classified warning(s)`;
        if (!log.covered) return failed(check, `${counts}; log does not cover the full deploy window`);
        return failures ? failed(check, counts) : warnings ? { level: 'WARN', detail: counts } : ok(counts);
    },
    stoppedTime(check, [log]) {
        const detail = `Flows stopped for ${(log.downtime / 1000).toFixed(1)} s`;
        if (!log.covered) return failed(check, `${detail} observed; incomplete log coverage`);
        return log.downtime > check.limitMin * HEALTH_MIN ? failed(check, detail) : ok(detail);
    },
    startCount(check, [log]) {
        const detail = `${log.starts} flow start(s)`;
        if (!log.covered) return failed(check, `${detail} observed; incomplete log coverage`);
        return log.starts > check.limit ? failed(check, detail) : ok(detail);
    }
};

function evaluate(config, values, state, previous = []) {
    return config.checks.map(check => {
        const input = sources(check).map(source => values.get(source));
        const prior = previous.find(row => row.id === check.id);
        let result = input.includes(undefined) ? failed(check, 'Source unavailable')
            : conditions[check.condition](check, input, { ...state, prior });
        if (result.level === check.severity && state.now - state.restartedAt < check.graceMin * HEALTH_MIN) {
            result = { ...result, level: 'WAIT', detail: `${result.detail} (restart grace)` };
        }
        return { id: check.id, name: check.name, ...result };
    });
}

function sourceLabels(flows) {
    const tab = flows.find(node => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    if (!tab) throw new Error('No managed d# tab in repository flows');
    return flows.filter(node => node.z === tab.id).map(node => ({
        id: node.id, labels: [node.id, ...[node.id, node.name, node.deviceName].filter(Boolean).map(label => `${node.type}:${label}`)]
    }));
}

const PYTHON_DBUS = `
import dbus, json, sys
prefix, wildcard, item = sys.argv[1:]
bus = dbus.SystemBus()
names = sorted(str(n) for n in bus.list_names())
service = next((n for n in names if (n.startswith(prefix) if wildcard else n == prefix)), None)
value = bus.get_object(service, item, introspect=False).GetValue(dbus_interface="com.victronenergy.BusItem", timeout=3) if service else None
print(json.dumps(value))
`;

async function readDbus(match) {
    const [, name, wildcard, item] = match;
    const { stdout } = await promisify(execFile)('python3', ['-c', PYTHON_DBUS, name, wildcard || '', item], { timeout: 10000 });
    return JSON.parse(stdout);
}

async function collect(config, deploy, owned, options = {}) {
    const api = options.api || (typeof createAdminApi === 'function' ? createAdminApi : require('./admin-api.js'))({ getTimeoutMs: 5000 });
    const warn = (source) => console.error(`GX health: ${source} unavailable`);
    const values = new Map(), pending = new Map();
    // The target tab ID comes from the same commit as the owned-node allowlist.
    const context = (url) => {
        if (!pending.has(url)) pending.set(url, api('GET', url).then(reply => {
            const body = JSON.parse(reply);
            return typeof body.msg === 'string' ? JSON.parse(body.msg) : body.msg;
        }));
        return pending.get(url);
    };
    const unique = [...new Set(config.checks.flatMap(sources))].filter(source => source !== 'log');
    await Promise.all(unique.map(async source => {
        try {
            const match = CONTEXT.exec(source);
            if (match) {
                const [, scope, key, field] = match;
                const url = `/context/${scope === 'flow/' ? `flow/${deploy.tab}/` : scope}${key}`;
                const value = await context(url);
                values.set(source, field ? field.split('.').reduce((value, part) => value?.[part], value) : value);
            } else {
                values.set(source, await (options.readDbus || readDbus)(DBUS.exec(source)));
            }
        } catch { warn(source); }
    }));
    const now = options.now ?? Date.now();
    let stats;
    try { stats = logStats(config, (options.readLog || readLog)(LOG_FILE), deploy.startedAt, now); }
    catch { warn('Node-RED log'); }
    values.set('log', stats);
    return { values, state: { now, restartedAt: stats?.restartedAt ?? deploy.startedAt, owned } };
}

function readHistory(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).deploys; }
    catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function statusOf(checks) {
    return ['FAIL', 'WARN', 'WAIT'].find(level => checks.some(check => check.level === level)) || 'OK';
}

async function sampleRemote(config, deploy, owned, final, options = {}) {
    const file = options.file || RESULT_FILE;
    const history = readHistory(file);
    const samples = history.find(row => row.id === deploy.id)?.samples || [];
    const prior = samples.at(-1)?.checks;
    const { values, state } = await collect(config, deploy, owned, options);
    const results = evaluate(config, values, state, prior);
    // Request IDs are for continuity on the GX only, never for public artifacts.
    const { tab, ...record } = deploy;
    const latest = { at: state.now, restartedAt: state.restartedAt, status: statusOf(results), checks: results };
    const current = { ...record, finishedAt: final ? state.now : null, samples: [...samples, latest] };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ deploys: [current, ...history.filter(row => row.id !== deploy.id)].slice(0, config.historyLimit) }),
            { flag: 'wx', mode: 0o644 });
        fs.renameSync(tmp, file);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    return { ...latest, checks: results.map(({ key, ...check }) => check) };
}

function validate(config) {
    const minutes = value => Number.isFinite(value) && value >= 0;
    if (![config.intervalMin, config.durationMin].every(value => Number.isSafeInteger(value) && value > 0) ||
        config.durationMin % config.intervalMin || !Number.isSafeInteger(config.historyLimit) || config.historyLimit < 1 ||
        !Array.isArray(config.checks) || !config.checks.length) throw new Error('Invalid health monitor schedule or history');
    const conditionsWithAges = ['fresh', 'finite', 'ownerCurve', 'confirmed', 'watchdogOk'];
    const logConditions = ['ownedErrors', 'stoppedTime', 'startCount'];
    const ids = new Set();
    for (const check of config.checks) {
        if (!/^[\w-]+$/.test(check.id || '') || ids.has(check.id) || typeof check.name !== 'string' ||
            !Object.hasOwn(conditions, check.condition) || !['FAIL', 'WARN'].includes(check.severity) || !minutes(check.graceMin) ||
            sources(check).length !== (check.condition === 'ownerCurve' ? 3 : 1) ||
            sources(check).some(source => typeof source !== 'string' ||
                !(logConditions.includes(check.condition) ? source === 'log' : CONTEXT.test(source) || DBUS.test(source))) ||
            (conditionsWithAges.includes(check.condition) && !minutes(check.maxAgeMin)) ||
            (check.condition === 'finite' && typeof check.field !== 'string') ||
            (check.condition === 'ownerCurve' && !minutes(check.deviceMaxAgeMin)) ||
            (check.condition === 'confirmed' && !minutes(check.holdMin)) ||
            (['confirmed', 'ownedErrors'].includes(check.condition) && !check.pattern) ||
            (check.condition === 'ownedErrors' && (!Array.isArray(check.warningSources) ||
                (check.node !== undefined && !/^[\w.-]+$/.test(check.node)))) ||
            (check.condition === 'equals' && !Object.hasOwn(check, 'expected')) ||
            (check.condition === 'stoppedTime' && !minutes(check.limitMin)) ||
            (check.condition === 'startCount' && !minutes(check.limit))) throw new Error(`Invalid health check: ${check.id}`);
        ids.add(check.id);
        if (check.pattern !== undefined) new RegExp(check.pattern);
        if (check.condition === 'ownedErrors') for (const rule of check.warningSources) new RegExp(rule.pattern);
    }
    for (const key of ['stop', 'starting', 'started']) {
        if (typeof config.log?.[key] !== 'string' || !config.log[key]) throw new Error(`Missing log pattern: ${key}`);
        new RegExp(config.log[key]);
    }
    return config;
}

function sshSample(host, keyFile, script) {
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', host, 'node -'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 75000 });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        child.stderr.resume(); // Remote diagnostics can include private details. Do not copy them into the run log.
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error('GX sample or result-file write failed'));
            try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        child.stdin.end(script);
    });
}

async function runWindow(config, deploy, takeSample, save, clock = Date.now, wait = sleep) {
    const interval = config.intervalMin * HEALTH_MIN;
    const samples = [];
    for (let at = deploy.windowStartedAt; at <= deploy.endsAt; at += interval) {
        if (at > clock()) await wait(at - clock());
        const final = at === deploy.endsAt;
        let sample;
        try { sample = await takeSample(final); }
        catch {
            sample = { at: clock(), status: 'FAIL', checks: config.checks.map(({ id, name }) => ({
                id, name, level: 'FAIL', detail: 'GX sample unavailable or could not be saved'
            })) };
        }
        samples.push(sample);
        save({ ...deploy, status: sample.status, finishedAt: final ? sample.at : null, samples });
    }
    return samples.at(-1).status;
}

function summary(report) {
    const latest = report.samples.at(-1);
    const iso = at => new Date(at).toISOString();
    return [`### GX post-deploy health: ${report.version} — ${report.status}`,
        `Apply: ${iso(report.startedAt)} · Last sample: ${iso(latest.at)} · ${report.samples.length} sample(s)`,
        '', '| Check | Result | Detail |', '|---|---|---|',
        ...latest.checks.map(row => `| ${row.name} | ${row.level} | ${row.detail} |`), ''].join('\n');
}

async function main(env) {
    const root = path.join(__dirname, '..', '..');
    const config = validate(JSON.parse(fs.readFileSync(path.join(root, 'config', 'health-checks.json'), 'utf8')));
    const flows = JSON.parse(fs.readFileSync('flows.json', 'utf8')); // The selected deploy commit, not the gate checkout.
    const tab = flows.find(node => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    const owned = sourceLabels(flows);
    const startedAt = Number(env.APPLY_STARTED);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || !/^\d+-\d+$/.test(env.HEALTH_RUN_ID || '')) {
        throw new Error('Missing deploy identity or timestamp');
    }
    const windowStartedAt = Date.now();
    const deploy = { id: env.HEALTH_RUN_ID, version: /d#\d+/.exec(tab.label)[0], startedAt, windowStartedAt,
        endsAt: windowStartedAt + config.durationMin * HEALTH_MIN };
    const code = fs.readFileSync(__filename, 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'admin-api.js'), 'utf8');
    const takeSample = final => sshSample(env.GX_SSH_HOST, path.join(env.HOME, '.ssh', 'key'),
        `${code}\nsampleRemote(${[config, { ...deploy, tab: tab.id }, owned, final].map(JSON.stringify).join(',')})
        .then(result => console.log(JSON.stringify(result)))
        .catch(() => { console.error('GX health sample failed'); process.exitCode = 1; });\n`);
    const status = await runWindow(config, deploy, takeSample, report => {
        fs.writeFileSync(env.HEALTH_REPORT, JSON.stringify(report, null, 2));
        const latest = report.samples.at(-1);
        console.log(`${new Date(latest.at).toISOString()} ${report.version} health: ${latest.status}`);
        if (report.finishedAt) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary(report));
    });
    return status === 'FAIL' ? 1 : 0;
}

if (require.main === module) main(process.env).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Post-deploy monitor: ${error.message}`);
    process.exitCode = 1;
});

module.exports = { logTime, readLog, logStats, evaluate, sourceLabels, runWindow, sampleRemote, validate };
