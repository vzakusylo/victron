'use strict';
process.env.TZ = 'Europe/Oslo';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGrid, readSource } = require('./harness');
const { additionPlan } = require('../tools/gx/node-additions');

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
    control.run({ topic: 'battery-voltage', payload: 53 }, { now });
    const { result } = control.run({ topic: 'battery-consumed-ah', payload: -200 }, { now });
    assert.deepEqual(result.slice(0, 3).map(m => m.topic), ['charge-current-limit', 'grid-setpoint', 'ac-input-current-limit']);
    assert.deepEqual(result.slice(3, 7), [null, null, null, null]);
    assert.ok(result[7].tick.decision);
});

test('the split is an additive deployment, preserving old wires and consumer destinations', () => {
    const flows = require('../flows.json');
    const source = flows.find(n => n.name === 'Battery + Grid Controller');
    const book = flows.find(n => n.name === 'Grid bookkeeping');
    const old = { ...source, outputs: 7, wires: [
        ['c1803b5fed00bfc2'], ['70b033ccd4654b3e'], ['66951950bfa6d862'], ['233d4e08d8a8fe38'],
        ['69795160ade5462a', '3e942ddd06fba83c'], ['5545bd538ffe3183', '6b9848413d671fe5', 'e55aa7c921171c88'],
        ['7a3e91c45d2b8f06']
    ] };
    const before = flows.filter(n => n.id !== book.id).map(n => n.id === old.id ? old : n);
    assert.deepEqual(source.wires.slice(0, 7), old.wires);
    assert.deepEqual(source.wires[7], [book.id]);
    assert.deepEqual(book.wires, old.wires.slice(3));
    assert.deepEqual(additionPlan(before, flows, true), { add: [book.id], wire: [source.id] });
});
