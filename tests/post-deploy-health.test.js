'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadNode } = require('./harness.js');
const { evaluate, logStats, readLog, runWindow, sampleRemote, sourceLabels, validate } = require('../tools/gx/post-deploy-health.js');

const config = validate(require('../config/health-checks.json'));
const flows = require('../flows.json');
const owned = sourceLabels(flows);
const MIN = 60000;
const startedAt = Date.UTC(2026, 10, 25);
const now = startedAt + 30 * MIN;
const view = { at: now - 1000, state: 'HEATING', outAvg: -10, outHeld: false, heatCurve: { p23: 30, p24: 4 } };
const hp = { state: 'CONNECTED', lastData: now - 1000, dps: { 133: '30', 134: 4 } };
const deploy = { id: '1-1', tab: 'target-tab', version: 'd#243', startedAt, windowStartedAt: startedAt, endsAt: startedAt + 60 * MIN };
const baseline = { at: startedAt - 1000, line: '[info] Started flows' };
const event = (min, line) => ({ at: startedAt + min * MIN, line });
const lifecycle = (min, text) => event(min, `[info] ${text}`);
const getCheck = id => config.checks.find(check => check.id === id);

function check(id, values, state = {}, previous) {
    const definition = getCheck(id);
    const sources = [].concat(definition.source);
    return evaluate({ checks: [definition] }, new Map(sources.map((source, i) => [source, values[i]])),
        { now, restartedAt: startedAt, owned, ...state }, previous)[0];
}

test('tick freshness requires a post-restart tick and becomes a failure after grace', () => {
    const restartedAt = now - MIN;
    assert.equal(check('tick', [now - 1000], { restartedAt }).level, 'OK');
    assert.equal(check('tick', [restartedAt - 1], { restartedAt }).level, 'WAIT');
    assert.equal(check('tick', [now - 2 * MIN - 1]).level, 'FAIL');
    assert.equal(check('tick', [now + 1]).level, 'FAIL');
});

test('outdoor recovery accepts freezing temperatures and fails at the configured grace boundary', () => {
    assert.equal(check('outdoor', [view]).level, 'OK');
    const missing = { ...view, outAvg: null };
    assert.equal(check('outdoor', [missing], { restartedAt: now - 20 * MIN + 1 }).level, 'WAIT');
    assert.equal(check('outdoor', [missing], { restartedAt: now - 20 * MIN }).level, 'FAIL');
    assert.equal(check('outdoor', [{ ...view, at: startedAt - 1 }]).level, 'FAIL');
});

test('curve compares both live coefficients, exempts DHW and defrost, and verifies a heating override', () => {
    const mismatch = { ...hp, dps: { ...hp.dps, 134: 5 } };
    const override = { boost: 1, curveCmd: { p23: 30, p24: 5 } };
    assert.equal(check('curve', [view, hp, null]).level, 'OK');
    assert.equal(check('curve', [view, mismatch, null]).level, 'FAIL');
    assert.equal(check('curve', [{ ...view, state: 'DHW' }, mismatch, null]).level, 'SKIP');
    assert.equal(check('curve', [{ ...view, outHeld: true }, mismatch, null]).level, 'SKIP');
    assert.match(check('curve', [view, mismatch, override]).detail, /active heating override/);
    assert.equal(check('curve', [view, { ...mismatch, lastData: startedAt }, override]).level, 'FAIL');
    assert.equal(check('curve', [view, mismatch, { ...override, curveCmd: { p23: 31, p24: 5 } }]).level, 'FAIL');
    assert.equal(check('curve', [view, { ...hp, dps: { 133: '', 134: 4 } }, null]).level, 'FAIL');
});

test('unconfirmed curve state must persist beyond its threshold; a new request resets it', () => {
    const ownerCurveResult = { ok: false, text: 'heat pump did not confirm both coefficients', requestId: 'private-id' };
    const unconfirmed = { ...view, ownerCurveResult };
    const first = check('curve-confirmation', [unconfirmed]);
    assert.equal(first.level, 'WAIT');
    assert.equal(check('curve-confirmation', [unconfirmed], {}, [{ ...first, since: now - 10 * MIN }]).level, 'WAIT');
    const prior = [{ ...first, since: now - 10 * MIN - 1 }];
    assert.equal(check('curve-confirmation', [unconfirmed], {}, prior).level, 'FAIL');
    assert.equal(check('curve-confirmation', [{ ...unconfirmed, ownerCurveResult: { ...ownerCurveResult, requestId: 'new' } }], {}, prior).level, 'WAIT');
    assert.equal(check('curve-confirmation', [{ ...unconfirmed, ownerCurveResult: { ...ownerCurveResult, ok: true } }], {}, prior).level, 'OK');
});

test('curve health checks the actual pump target against the configured cap, even for an acknowledged override', () => {
    const pump = { ...hp, dps: { 133: 40, 134: 7 } };
    const stored = { ...view, heatCurve: { p23: 26, p24: 6 }, heat: { cfg: { maxCurveOffset: 3.6 } } };
    const safe = { ...pump, dps: { 133: 32, 134: 6 } };
    assert.equal(check('curve-offset', [stored, safe]).level, 'OK');
    assert.equal(check('curve-offset', [stored, pump]).level, 'FAIL');
    assert.equal(check('curve-offset', [{ ...stored, state: 'DHW' }, pump]).level, 'SKIP');
    assert.equal(check('curve-offset', [{ ...stored, outHeld: true }, pump]).level, 'SKIP');
    assert.equal(check('curve-offset', [{ ...stored, outAvg: null }, pump]).level, 'FAIL');
    assert.equal(check('curve-offset', [{ ...stored, outAvg: -100 }, pump]).level, 'OK', 'both targets clamp at 60 °C');
});

test('BMS watchdog must be OK and recent and SerialBattery must be connected independently', () => {
    const watchdog = { status: 'ok', checkedAt: new Date(now - MIN).toISOString() };
    assert.equal(check('bms', [watchdog]).level, 'OK');
    assert.equal(check('bms', [{ ...watchdog, status: 'warning' }]).level, 'FAIL');
    assert.equal(check('bms', [{ ...watchdog, checkedAt: new Date(startedAt).toISOString() }]).level, 'FAIL');
    assert.equal(check('battery', [1]).level, 'OK');
    assert.equal(check('battery', [0]).level, 'FAIL');
    assert.equal(check('battery', [undefined], { restartedAt: now - MIN }).level, 'WAIT');
});

test('only new owned-node errors count and only the meter reachability exception is WARN', () => {
    const meter = '[tuya-smart-device:SA1 power meter (heat pump)]';
    const rows = [baseline, { ...baseline, line: '[error] [function:Heat pump automations] predeploy' },
        event(1, '[error] [function:Unowned] ignored'), event(2, `[error] ${meter} EHOSTUNREACH private-data`)];
    const stats = () => logStats(config, rows, startedAt, now);
    assert.deepEqual(check('node-errors', [stats()]), {
        id: 'node-errors', name: 'Owned Node-RED errors', level: 'WARN', detail: '0 owned error(s), 1 classified warning(s)'
    });
    rows.push(event(3, `[error] ${meter} authentication issue`));
    rows.push(event(4, '[error] [function:Heat pump automations] EHOSTUNREACH'));
    assert.match(check('node-errors', [stats()]).detail, /^2 owned error/);
    assert.equal(check('node-errors', [stats()]).level, 'FAIL');
    assert.equal(check('node-errors', [logStats(config, rows.slice(2), startedAt, now)]).level, 'FAIL');
});

test('the first health-file read can warn before the monitor writes any history', () => {
    const prefix = '[error] [file in:Read saved health history] Error: ';
    const file = '/data/home/nodered/post-deploy-health.json';
    const rows = [baseline, event(1, `${prefix}ENOENT: no such file or directory, open '${file}'`)];
    const sample = () => check('node-errors', [logStats(config, rows, startedAt, now)]);
    assert.equal(sample().level, 'WARN');
    rows.push(event(2, `${prefix}EACCES: permission denied, open '${file}'`));
    assert.equal(sample().level, 'FAIL');
});

test('notification health fails only on new errors from the GX notification output', () => {
    const error = "[error] [victron-output-custom:GX notification output] TypeError: Cannot read properties of undefined (reading 'disabled')";
    const rows = [baseline, { ...baseline, line: error }, event(1, '[error] [function:Heat pump automations] unrelated')];
    const sample = () => check('gx-notification', [logStats(config, rows, startedAt, now)]);
    assert.equal(sample().level, 'OK');
    rows.push(event(2, error));
    assert.equal(sample().level, 'FAIL');
    assert.equal(sample().detail, '1 node error(s)');
});

test('downtime includes the interval through Started flows and sums repeated restarts', () => {
    const rows = [baseline, lifecycle(1, 'Stopping flows'), lifecycle(2, 'Starting flows'), lifecycle(3, 'Started flows')];
    assert.equal(check('downtime', [logStats(config, rows, startedAt, now)]).level, 'OK');
    assert.equal(check('starts', [logStats(config, rows, startedAt, now)]).level, 'OK');
    rows.push(lifecycle(4, 'Stopping modified nodes'), lifecycle(4.5, 'Starting modified nodes'), lifecycle(5, 'Started modified nodes'));
    const stats = logStats(config, rows, startedAt, now);
    assert.equal(stats.restartedAt, startedAt + 5 * MIN);
    assert.match(check('downtime', [stats]).detail, /180\.0 s/);
    assert.equal(check('downtime', [stats]).level, 'WARN');
    assert.equal(check('starts', [stats]).level, 'WARN');
    rows.push(lifecycle(25, 'Stopping flows'));
    assert.equal(logStats(config, rows, startedAt, now).downtime, 8 * MIN);
});

function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-deploy-health-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('log timestamps and coverage survive a multilog rotation', (t) => {
    const dir = temporary(t);
    const stamp = at => '@' + (BigInt(Math.floor(at / 1000)) + (1n << 62n) + 10n).toString(16) +
        ((at % 1000) * 1e6).toString(16).padStart(8, '0');
    const write = (file, at, text) => fs.writeFileSync(path.join(dir, file), `${stamp(at)} ${text}\n`);
    write(`${stamp(startedAt)}.s`, startedAt - 1, '[info] Stopping flows');
    write('current', startedAt + 154, '[info] Started flows');
    const stats = logStats(config, readLog(path.join(dir, 'current')), startedAt - 1, now);
    assert.equal(stats.covered, true);
    assert.equal(stats.downtime, 155);
    assert.equal(stats.starts, 1);
});

test('remote samples collect configured GETs and D-Bus values, persist bounded history and omit request IDs from output', async (t) => {
    const file = path.join(temporary(t), 'health.json');
    const calls = [];
    const change = { time: new Date(now - 1000).toISOString(), oslo: '2026-11-25 12:00:00',
        dp: 133, old: 24, new: 40, writer: 'heating controller' };
    const readings = {
        '/context/node/hpa-fn-01/dhw': { tickAt: now - 1000 },
        '/context/node/hpa-fn-01/heat': {},
        '/context/flow/target-tab/dhwView': { ...view, recentCurveChanges: [change],
            ownerCurveResult: { ok: false, text: 'did not confirm', requestId: 'private-id' } },
        '/context/flow/target-tab/heatPump': { hp },
        '/context/flow/target-tab/bmsWatchdogState': { status: 'ok', checkedAt: new Date(now - MIN).toISOString() }
    };
    const options = { file, now, readLog: () => [baseline], readDbus: match => {
        assert.deepEqual(match.slice(1), ['com.victronenergy.battery.tty', '*', '/Connected']);
        return 1;
    }, api: async (method, url) => {
        calls.push(url);
        assert.equal(method, 'GET');
        assert.ok(Object.hasOwn(readings, url));
        return JSON.stringify({ msg: JSON.stringify(readings[url]) });
    } };
    const first = await sampleRemote(config, deploy, owned, false, options);
    assert.equal(calls.length, 5);
    assert.equal(first.status, 'WAIT');
    assert.deepEqual(first.curveChanges, [change]);
    assert.equal(first.checks.some(c => c.level === 'FAIL' || c.key !== undefined), false);
    await sampleRemote(config, deploy, owned, true, options);
    await sampleRemote({ ...config, historyLimit: 2 }, { ...deploy, id: '2-1' }, owned, false, options);
    await sampleRemote({ ...config, historyLimit: 2 }, { ...deploy, id: '3-1' }, owned, false, options);
    const history = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(history.deploys.map(d => d.id), ['3-1', '2-1']);
    assert.deepEqual(history.deploys[0].samples[0].curveChanges, [change]);
    assert.doesNotMatch(JSON.stringify(history), /private-id|target-tab/);
});

test('monitor waits five minutes between samples, tolerates recovery, and fails on final unavailability', async () => {
    for (const finalFails of [false, true]) {
        let clock = startedAt;
        const reports = [];
        const status = await runWindow(config, deploy, async final => {
            if (clock === startedAt || (final && finalFails)) throw new Error('private SSH diagnostic');
            return { at: clock, status: 'WARN', checks: [] };
        }, r => reports.push(structuredClone(r)), () => clock, async ms => { clock += ms; });
        const report = reports.at(-1);
        assert.deepEqual(report.samples.map(s => (s.at - startedAt) / MIN), Array.from({ length: 13 }, (_, i) => i * 5));
        assert.equal(report.finishedAt, deploy.endsAt);
        assert.equal(status, finalFails ? 'FAIL' : 'WARN');
        assert.doesNotMatch(JSON.stringify(report), /private SSH diagnostic/);
    }
});

test('Health page uses the latest saved checks and exposes neither raw file errors nor internal fields', () => {
    const node = loadNode('66 Read deploy health.js');
    const r = node.run({ payload: JSON.stringify({ deploys: [{ ...deploy, finishedAt: now, samples: [
        { at: now - MIN, status: 'FAIL', checks: [] },
        { at: now, status: 'OK', checks: [{ id: 'tick', name: 'Tick', level: 'OK', detail: 'Fresh', key: 'internal' }] }
    ] }] }) }).result.payload;
    assert.equal(r.deploys[0].checks[0].level, 'OK');
    assert.equal(r.deploys[0].checks[0].key, undefined);
    assert.match(node.run({ error: { message: 'ENOENT: private path' } }).result.payload.message, /No deployments/);
    assert.doesNotMatch(JSON.stringify(node.run({ error: { message: 'EACCES: private path' } }).result), /private path/);
    const widget = flows.find(n => n.id === 'health-page-01');
    assert.deepEqual(widget.wires, [[]]);
    assert.equal(flows.find(n => n.id === 'health-file-01').type, 'file in');
});
