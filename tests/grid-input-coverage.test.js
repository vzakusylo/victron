'use strict';
process.env.TZ = 'Europe/Oslo';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadNode } = require('./harness');

const at = Date.parse('2026-11-12T14:00:00+01:00');
const makeController = () => loadNode('01 Battery + Grid Controller.js');
const send = (control, topic, payload, elapsed = 0) => control.run({ topic, payload }, { now: at + elapsed });
const tick = (control, elapsed = 0) => send(control, 'grid-control-tick', undefined, elapsed).result[7].tick;

test('invalid sensor payloads and unrelated topics do not replace readings or refresh arrivals', () => {
    const control = makeController();
    assert.equal(send(control, 'GRID CT import power', ' -450 ').result, null);
    for (const payload of [true, [], [12], {}, null, undefined, '', ' \t ', NaN, Infinity, 'Infinity', 'not numeric']) {
        assert.equal(send(control, 'GRID CT import power', payload, 1000).result, null);
    }
    assert.equal(send(control, 'unrelated', 1234, 1000).result, null);
    assert.equal(control.context.get('gridPowerW'), -450);
    assert.deepEqual(control.context.get('gridInputArrivals'), { gridPowerW: at });
    assert.deepEqual(Object.keys(control.context.data).sort(), ['gridInputArrivals', 'gridPowerW']);
});

test('a falling CT step compares against the last decision, not the last stored sample', () => {
    const control = makeController();
    send(control, 'battery-voltage', 53);
    send(control, 'battery-consumed-ah', 0);
    const withoutCt = tick(control);
    assert.equal(withoutCt.hasDcPowerReading, false);
    assert.equal(control.context.get('gridLastDecisionPowerW'), undefined);
    assert.equal(send(control, 'grid-power', 1400, 1000).result, null);
    tick(control, 2000);
    assert.equal(send(control, 'grid-power', 400, 2500).result, null);
    const immediate = send(control, 'grid-power', 399, 3000).result;
    assert.equal(immediate[7].tick.gridPowerSignedW, 399);
    assert.equal(control.context.get('gridLastDecisionPowerW'), 399);
});

test('bookkeeping integrates previous nonnegative import and PV, not signed DC or the new sample', () => {
    const control = makeController();
    for (const [topic, value] of [['grid-power', -500], ['ac-load-power', -100], ['pv-charger-power', -10], ['dc-power', -750]]) {
        assert.equal(send(control, topic, value).result, null);
    }
    assert.equal(control.context.get('acLoadPowerW'), 0);
    assert.equal(control.context.get('pvChargerPowerW'), 0);
    const initial = tick(control);
    assert.deepEqual(initial.accountingPower, { gridW: 0, acW: 0, solarW: 0 });
    assert.deepEqual([initial.hasDcPowerReading, initial.storedDcPowerW, initial.gridPowerSignedW], [true, -750, -500]);
    for (const [topic, value] of [['grid-power', 500], ['ac-load-power', 200], ['pv-charger-power', 300]]) {
        send(control, topic, value, 1000);
    }
    assert.deepEqual(tick(control, 2000).accountingPower, initial.accountingPower);
    assert.deepEqual(tick(control, 4000).accountingPower, { gridW: 500, acW: 200, solarW: 300 });
});

test('a legacy hour seeds prior power and reasserts the unchanged VE.Bus limit at rollover', () => {
    const control = makeController();
    const now = Date.parse('2026-11-12T07:00:00+01:00');
    const hourBudget = { hourKey: '2026-11-12 06', usedWh: 300 };
    for (const [key, value] of Object.entries({
        hourBudget, batteryVoltage: 53, batteryConsumedAh: 0, gridPowerW: 450, acLoadPowerW: 600, pvChargerPowerW: 125
    })) control.context.set(key, value);
    const steady = control.run({ topic: 'grid-control-tick' }, { now: now - 1000 }).result[7].tick;
    control.context.set('gridControlHourKey', undefined);
    control.context.set('gridAccountingPower', undefined);
    const rolled = control.run({ topic: 'grid-control-tick' }, { now }).result;
    assert.equal(rolled[7].tick.decision.gridCurrentLimitA, steady.decision.gridCurrentLimitA);
    assert.equal(rolled[7].tick.sendGridCurrentLimit, true);
    assert.deepEqual(rolled[7].tick.accountingPower, { gridW: 450, acW: 600, solarW: 125 });
    assert.deepEqual(rolled[7].tick.legacy, { hourBudget });
});

test('manual enable bypasses missing consumed Ah but not missing voltage; invalid commands preserve state', () => {
    const control = makeController();
    const enable = send(control, 'manual-discharge', { active: true, source: 'coverage' }).result[7].tick;
    assert.equal(enable.waiting, 'WAITING FOR BATTERY VOLTAGE');
    send(control, 'battery-voltage', 55, 1000);
    const invalid = send(control, 'manual-discharge', 'invalid', 2000).result[7].tick;
    assert.equal(invalid.waiting, '');
    assert.deepEqual(control.context.get('manualDischarge'), { active: true, startedAt: new Date(at).toISOString(), source: 'coverage' });
    const disable = send(control, 'manual-discharge', false, 3000).result[7].tick;
    assert.equal(disable.waiting, 'WAITING FOR BMS CONSUMED AH');
    assert.deepEqual(control.context.get('manualDischarge'), { active: false, startedAt: '', source: 'inject' });
});

test('a manual stop voltage only persists within the inclusive 50–60 V range', () => {
    const control = makeController();
    const set = payload => send(control, 'manual-discharge-stop-voltage', payload).result[7].tick.manualDischargeStopVoltage;
    assert.equal(set('50'), 50);
    assert.equal(set(49.99), 50);
    assert.equal(set(60), 60);
    assert.equal(set(60.01), 60);
    assert.equal(set('invalid'), 60);
    assert.equal(control.context.get('manualDischargeStopVoltage'), 60);
});
