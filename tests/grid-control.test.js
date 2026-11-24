'use strict';
process.env.TZ = 'Europe/Oslo';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGrid, readSource } = require('./harness');

const { decideGrid, getConstants, sanitizeHighVoltageSettings } = new Function(
    `${readSource('01 Battery + Grid Controller.js').split('\nconst now = new Date();')[0]}
    return { decideGrid, getConstants, sanitizeHighVoltageSettings };`
)();

test('pure control returns setpoint, DVCC, VE.Bus and flags without changing inputs', () => {
    const state = Object.freeze({ manualDischarge: Object.freeze({ active: false }), voltageLimitActive: false, forceChargeLimiterActive: false });
    const base = {
        now: new Date('2026-11-12T23:00:00+01:00'), C: Object.freeze(getConstants()),
        highVoltageSettings: Object.freeze(sanitizeHighVoltageSettings({ enabled: true, start: 55.2, release: 55, full: 55.4 })),
        batteryVoltage: 53, consumedAhDeficit: 200, previousGridSetpoint: 5000,
        hasGridPowerReading: true, storedGridPowerW: 800, gridPowerSignedW: 800,
        storedAcLoadPowerW: 800, storedPvChargerPowerW: 0, solarGenerationW: 0,
        manualDischargeStopVoltage: 52, storedExportGuard: Object.freeze({})
    };
    const night = decideGrid(Object.freeze(base), state);
    assert.deepEqual([night.windowName, night.finalChargeCurrent, night.finalGridSetpoint, night.gridCurrentLimitA], ['NIGHT', 25, 6440, 31]);
    const limited = decideGrid({ ...base, batteryVoltage: 55.4 }, state);
    assert.ok(limited.voltageLimitActive);
    assert.ok(limited.limitFlags.includes('HV'));
    assert.ok(limited.finalChargeCurrent < night.finalChargeCurrent);
    assert.deepEqual(decideGrid(base, state), night);
});

test('legacy budgets and tariff context survive the split, including the first rollover', () => {
    const grid = loadGrid();
    const at = Date.parse('2026-10-25T02:00:00+02:00');
    const last = at + 3597000;
    const key = '2026-10-25 02';
    const budget = usedWh => ({ hourKey: key, usedWh, lastTs: last, startTs: at, fullHourCoverage: true });
    for (const [k, v] of Object.entries({
        batteryVoltage: 53, batteryConsumedAh: 0, gridPowerW: 1200, gridCurrentLimitA: 32,
        hourBudget: budget(1199), acLoadBudget: budget(599), solarBudget: budget(299),
        hourPeak: { hourKey: key, peakW: 1500 }, lastTraceTs: last,
        tariffDay: { dayKey: '2026-10-25', gridWh: 300, peakBillableWh: 210, peakHourKey: '2026-10-25 01' },
        tariffMonth: { monthKey: '2026-10', dayPeaks: { '2026-10-24': 1700 } },
        tariffHistoryState: { monthKey: '2026-10', loadedAt: at, hours: 2 }
    })) grid.context.set(k, v);
    const { result } = grid.run({ topic: 'grid-power', payload: 1200 }, { now: at + 3600000 });
    assert.equal(result[2].topic, 'ac-input-current-limit');
    assert.deepEqual(Object.fromEntries(['hourKey', 'gridWh', 'acWh', 'solarWh', 'peakW'].map(k => [k, result[4].payload[k]])),
        { hourKey: key, gridWh: 1199, acWh: 599, solarWh: 299, peakW: 1500 });
    assert.equal(result[5].payload.tariff.todayGridWh, 1499);
    assert.deepEqual(result[5].payload.tariff.monthTopPeaksWh, [1700, 839]);
    assert.equal(grid.bookkeeping.context.get('hourBudget').hourKey, key + '+0100');
    assert.equal(result[6], null, 'loaded history must not be re-requested');
});

test('control still emits all actuator messages without running Grid bookkeeping', () => {
    const { control } = loadGrid();
    const now = new Date('2026-11-12T23:00:00+01:00');
    const cadence = { topic: 'grid-control-tick' };
    assert.equal(control.run({ topic: 'battery-voltage', payload: 53 }, { now }).result, null);
    const waiting = control.run(cadence, { now });
    assert.match(waiting.status.text, /WAITING FOR BMS/);
    assert.equal(control.run({ topic: 'battery-consumed-ah', payload: -200 }, { now }).result, null);
    const { result } = control.run(cadence, { now });
    assert.deepEqual(result.slice(0, 3).map(m => m.topic), ['charge-current-limit', 'grid-setpoint', 'ac-input-current-limit']);
    assert.deepEqual(result.slice(3, 7), [null, null, null, null]);
    assert.ok(result[7].tick.decision);
    assert.match(control.run(cadence, { now }).status.text,
        /NIGHT 6440 W .*25 A DVCC .*31 A AC/);
});

test('a failed first bookkeeping tick retries the legacy seed without overwriting stored state', () => {
    const { control, bookkeeping, flow } = loadGrid();
    const now = new Date('2026-11-12T23:15:00+01:00');
    const hourKey = '2026-11-12 23';
    const budget = { hourKey, usedWh: 240, lastTs: +now, startTs: +now - 900000, fullHourCoverage: true };
    const month = { monthKey: '2026-11', dayPeaks: { '2026-11-11': 1700 } };
    control.context.set('hourBudget', budget);
    control.context.set('tariffMonth', month);
    const tick = () => structuredClone(control.run({ topic: 'grid-control-tick' }, { now }).result[7]);
    const set = bookkeeping.context.set;
    bookkeeping.context.set = (key, value) => {
        if (key === 'tariffMonth') throw new Error('injected bookkeeping error');
        set(key, value);
    };
    assert.throws(() => bookkeeping.run(tick()), /injected bookkeeping error/);
    assert.equal(flow.get('gridBookkeepingSeeded'), undefined);
    bookkeeping.context.set = set;
    bookkeeping.context.set('hourBudget', { ...budget, usedWh: 250 });
    const retry = tick();
    assert.deepEqual(retry.tick.legacy.tariffMonth, month);
    bookkeeping.run(retry);
    assert.deepEqual(bookkeeping.context.get('tariffMonth'), month);
    assert.equal(bookkeeping.context.get('hourBudget').usedWh, 250);
    assert.equal(flow.get('gridBookkeepingSeeded'), true);
    assert.equal(tick().tick.legacy, undefined);
});

test('cadence coalesces sensor bursts, but a CT step over 1 kW runs immediately', () => {
    const now = Date.parse('2026-11-12T23:00:00+01:00');
    const run = repeats => {
        const { control } = loadGrid();
        const input = (topic, payload, ms) => control.run({ topic, payload }, { now: now + ms }).result;
        assert.equal(input('battery-voltage', 53, 0), null);
        assert.equal(input('battery-consumed-ah', -200, 0), null);
        assert.equal(input('grid-power', 1000, 0), null);
        assert.ok(input('grid-control-tick', undefined, 0)[1]);
        for (let i = 0; i < repeats; i++) {
            assert.equal(input('ac-load-power', 1500, 10 + i), null);
            assert.equal(input('grid-power', 2000, 10 + i), null);
        }
        assert.equal(input('ac-load-power', null, 150), null);
        assert.equal(control.context.get('gridInputArrivals').acLoadPowerW, now + 9 + repeats);
        assert.equal(control.context.get('acLoadPowerW'), 1500);
        const step = input('grid-power', 2001, 200);
        assert.equal(step[7].tick.gridPowerSignedW, 2001);
        assert.equal(input('grid-power', 2001, 201), null);
        const tick = input('grid-control-tick', undefined, 2000);
        return [step[0], step[1], tick[0], tick[1]];
    };
    assert.deepEqual(run(1), run(100));
});

test('one 2 s inject and six periodic Victron inputs feed the controller directly', () => {
    const flows = require('../flows.json');
    const id = 'e4766632305fb432';
    const upstream = flows.filter(node => node.wires?.flat().includes(id));
    const injects = upstream.filter(node => node.type === 'inject');
    assert.deepEqual(injects.filter(node => node.repeat || node.crontab).map(node => [node.topic, node.repeat]), [
        ['grid-control-tick', '2']
    ]);
    const inputs = upstream.filter(node => node.type.startsWith('victron-input-'));
    assert.deepEqual(inputs.map(node => node.name).sort(), [
        '', 'AC Loads power', 'Battery SmartShunt consumed Ah', 'DC System Power', 'GRID CT import power', 'PV Charger Power'
    ]);
    assert.ok(inputs.every(node => node.onlyChanges === false));
    const readings = {
        '07c74490cafdc55a': ['batteryVoltage', 53, 53],
        '0ee582b64b26e2e7': ['batteryConsumedAh', -200, 200],
        '751d13b6d943e5e5': ['gridPowerW', 1000, 1000],
        '11e303e775ec959c': ['acLoadPowerW', 1500, 1500],
        'dc7f2a1c3e8b09c4': ['dcPowerW', -100, -100],
        'pv-charger-input-01': ['pvChargerPowerW', 450, 450]
    };
    const { control } = loadGrid();
    const now = new Date('2026-11-12T23:00:00+01:00');
    const emittedTopic = node => node.name || `${node.serviceObj.name} - ${node.pathObj.name}`;
    for (const node of inputs) {
        const [key, payload, expected] = readings[node.id];
        control.run({ topic: emittedTopic(node), payload }, { now });
        assert.equal(control.context.get(key), expected, `${node.id} (${emittedTopic(node)})`);
    }
    assert.ok(control.run({ topic: 'grid-control-tick' }, { now }).result[7].tick.decision);
    const ct = inputs.find(node => node.id === '751d13b6d943e5e5');
    const { result } = control.run({ topic: emittedTopic(ct), payload: 2001 }, { now });
    assert.equal(result[7].topic, 'grid-power');
    assert.equal(result[7].tick.gridPowerSignedW, 2001);
});

test('the split is an additive deployment, preserving old wires and consumer destinations', () => {
    const flows = require('../flows.json');
    const current = flows.find(n => n.name === 'Battery + Grid Controller');
    assert.deepEqual(current.wires[3], ['233d4e08d8a8fe38', '58e14304c415b27e']);
    assert.deepEqual(current.wires[8], ['hpa-logfile-01', 'hpl-fn-01', 'hpal-fn-01']);
    // Reconstruct the historical G1 split before the G3 alarm and G4 history rewiring.
    const source = { ...current, outputs: 8, wires: current.wires.slice(0, 8).map((w, i) => i === 3 ? w.slice(0, 1) : w) };
    const group = flows.find(n => n.id === source.g);
    const book = flows.find(n => n.name === 'Grid bookkeeping');
    const old = { ...source, outputs: 7, wires: [
        ['c1803b5fed00bfc2'], ['70b033ccd4654b3e'], ['66951950bfa6d862'], ['233d4e08d8a8fe38'],
        ['69795160ade5462a', '3e942ddd06fba83c'], ['5545bd538ffe3183', '6b9848413d671fe5', 'e55aa7c921171c88'],
        ['7a3e91c45d2b8f06']
    ] };
    assert.deepEqual(source.wires.slice(0, 7), old.wires);
    assert.deepEqual(source.wires[7], [book.id]);
    assert.deepEqual(book.wires, old.wires.slice(3));
    assert.equal(book.g, source.g);
    assert.ok(group.nodes.includes(book.id));
});

test('tariff history bypasses control and the heartbeat uses the existing alarm destinations', () => {
    const flows = require('../flows.json');
    const ctl = flows.find(n => n.name === 'Battery + Grid Controller');
    const book = flows.find(n => n.name === 'Grid bookkeeping');
    const history = flows.find(n => n.id === '7a3e91c45d2b8f06');
    const health = flows.find(n => n.id === 'grid-loop-health-01');
    assert.ok(history.wires[0].includes(book.id));
    assert.ok(!history.wires.flat().includes(ctl.id));
    assert.deepEqual(health.wires[0], ctl.wires[8]);
    assert.ok(ctl.wires[3].includes(health.wires[1][0]));
});
