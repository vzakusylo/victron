'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { loadNode } = require('./harness');
const flows = require('../flows.json');

const now = new Date(2026, 10, 25, 12).getTime();
const day = '2026-11-25';
const logs = '/data/home/nodered/grid-control-logs';
const load = (name, modules) => loadNode(name, undefined, undefined, modules);

function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr8-history-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const local = file => path.join(root, file.replace(/^\/data\/home\/nodered\//, ''));
    for (const [file, contents] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(local(file)), { recursive: true });
        fs.writeFileSync(local(file), contents);
    }
    const opened = [];
    return { local, opened, modules: { zlib, fs: { promises: {
        readdir: (file, options) => fs.promises.readdir(local(file), options),
        open: (file, flags) => { opened.push(file); return fs.promises.open(local(file), flags); },
        stat: file => fs.promises.stat(local(file)),
        unlink: file => fs.promises.unlink(local(file))
    } } } };
}

test('whole-file history paths no longer go through exec', () => {
    const formerExecs = ['Read selected summary file', 'Read heat pump history', 'Read automation log',
        'Read payback data', 'Read month energy history'];
    assert.ok(!flows.some(n => n.type === 'exec' && formerExecs.includes(n.name)));
    const month = flows.find(n => n.name === 'Read month energy history');
    assert.deepEqual(month.wires, [['grid-bookkeeping-01', '3e942ddd06fba83c']]);
});

test('selected day reads the legacy fallback and only its rows from the monthly CSV', async t => {
    const fallback = day + ' 09:00 | Grid 100Wh | AC 200Wh | Sol 3Wh\n';
    const csv = day + ' 09,120,240,4\n' + day + ' 10,180,360,5';
    const { modules, opened } = fixture(t, { [`${logs}/energy-${day}.log`]: fallback,
        [`${logs}/energy-2026-11.csv`]: 'hour,grid_wh\n2026-11-24 09,0,0,0\n' + csv });
    const resolver = load('18 Resolve selected summary day.js', modules);
    const call = resolver.run({ topic: 'dashboard-refresh' }, { now });
    assert.equal(call.sent[0][1].topic, 'selected-day-summary-loading');
    const [result] = await call.result;
    assert.equal(result.payload, fallback + csv + '\n');
    const model = loadNode('14 Build dashboard hourly widgets.js', undefined, resolver.flow);
    model.run(result, { now });
    assert.equal(model.flow.get('dashboardSelectedSummary').totalGrid, 300);
    assert.deepEqual(opened.map(file => file.slice(logs.length + 1)), [
        `summary-${day}.log`, `energy-${day}.log`, 'energy-2026-11.csv'
    ]);
});

test('heat pump streams mixed gzip/plain hour files and skips cached days for summary', async t => {
    const section = (dayKey, hour, rows) => `#hp1 ${dayKey} ${hour} cols=101,102,103,108,115,116\n${rows.join('\n')}\n`;
    const first = section(day, '08', ['0,C,C,26,30,6,47,40,500', '30,C,C,26,31,6,47,42,500']);
    const second = section(day, '09', ['0,C,C,26,32,5,47,44,500']);
    const motion = JSON.stringify({ t: now, id: 'motion', source: 'local', dps: { 101: 'pir' } });
    const old = '2026-11-24';
    const { modules, opened } = fixture(t, {
        [`${logs}/heatpump/${day}/08.csv.gz`]: zlib.gzipSync(first),
        [`${logs}/heatpump/${day}/09.csv`]: second,
        [`${logs}/heatpump/${old}/15.csv`]: section(old, '15', ['0,C,C,26,32,5,47,44,500']),
        [`${logs}/sensor-events/${day}.jsonl`]: motion
    });
    const stream = load('38 Build heat pump history.js', modules);
    const model = load('38 Build heat pump history.js', modules);
    for (const n of [stream, model]) n.flow.set('motionSensorId', 'motion');
    const input = { topic: 'day', day };
    const result = await stream.run(input, { now }).result;
    const previous = model.run({ ...input, payload: '#day ' + day + '\n' + first + second + '#motion available\n' + motion }, { now }).result;
    assert.deepEqual(result, previous);
    assert.equal(result.payload.chart.motion.count, 1);
    stream.flow.set('hpDayCache2', { [old]: { cachedTest: true } });
    opened.length = 0;
    const summary = await stream.run({ topic: 'summary' }, { now }).result;
    assert.deepEqual(summary.payload.days.map(d => d.day), [day, old]);
    assert.equal(summary.payload.days[1].cachedTest, true);
    assert.ok(!opened.some(file => file.includes(old) || file.includes('sensor-events')));
});

test('heat-pump history reports corrupt gzip instead of treating it as an empty day', async t => {
    const { modules } = fixture(t, { [`${logs}/heatpump/${day}/08.csv.gz`]: 'not gzip' });
    const reader = load('38 Build heat pump history.js', modules);
    const call = reader.run({ topic: 'day', day, utcp: 'get_event_lane' }, { now });
    const [, response] = await call.result;
    assert.match(call.warnings[0], /Heat pump history:/);
    assert.deepEqual(response.payload, { error: 'Could not read heat pump history' });
});

test('automation log groups streamed events, counts terminated lines and prunes old files', async t => {
    const events = [
        { t: now, kind: 'start', rule: 'dhw', cloud: 'DHW controller', run: '1:dhw', live: true, text: 'start' },
        { t: now + 1000, kind: 'write', rule: 'dhw', run: '1:dhw', live: true, text: 'set P23' }
    ];
    const stale = `${logs}/automations/2024-01-01.jsonl`;
    const { modules, local } = fixture(t, {
        [stale]: '{}\n', [`${logs}/automations/${day}.jsonl`]: events.map(JSON.stringify).join('\n') + '\n{partial'
    });
    fs.utimesSync(local(stale), new Date(2024, 0, 1), new Date(2024, 0, 1));
    const log = load('42 Automation log.js', modules);
    const [read] = await log.run({ topic: 'ui', payload: { action: 'open' } }, { now }).result;
    assert.equal(read.payload, null, 'Dashboard should not keep the rendered log in currentValues');
    assert.deepEqual(read.log.days, [{ day, count: 2 }]);
    assert.equal(read.log.note, '1 unreadable lines skipped');
    assert.equal(read.log.items[0].steps.length, 2);
    assert.ok(!fs.existsSync(local(stale)));
    const live = log.run({ topic: 'log', event: { t: now + 2000, kind: 'done', run: '1:dhw', live: true } }, { now: now + 2000 });
    assert.equal(live.result[0].log.items[0].status, 'ok');
});

test('payback and month restore prefer CSV values over the same legacy hour', async t => {
    const csv = day + ' 09,1000,2000,300,1000\n';
    const legacy = day + ' 09:00 | Grid 3000Wh | AC 4000Wh | Sol 123Wh\n';
    const { modules } = fixture(t, { [`${logs}/energy-${day}.log`]: legacy, [`${logs}/energy-2026-11.csv`]: csv });
    const month = await load('68 Read month energy history.js', modules).run({ monthKey: '2026-11' }, { now }).result;
    assert.equal(month.payload, legacy + csv);
    const daily = load('17 Update daily summary.js').run(month, { now }).result[1].summary;
    assert.deepEqual(daily.hours, [{ hour: '09:00', gridWh: 1000, acWh: 2000, solarWh: 300 }]);
    const [payback] = await load('48 Payback model.js', modules).run({ topic: 'tick' }, { now }).result;
    assert.equal(payback.payload.hoursCount, 1);
    assert.equal(payback.payload.gridKWh, 1);
    assert.equal(payback.payload.loadKWh, 2);
});
