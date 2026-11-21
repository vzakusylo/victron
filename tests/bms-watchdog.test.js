'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadNode } = require('./harness');

const t0 = Date.UTC(2026, 10, 16, 12);
const serial = 'com.victronenergy.battery.ttyTEST';

test('a serial driver restart sends one repair notification, suppresses repeats and clears the fault on recovery', () => {
    const watchdog = loadNode('30 BMS watchdog.js');
    const report = (seconds, fields) => watchdog.run({
        topic: 'bms-watchdog-exec',
        payload: Object.entries(fields).map(([field, value]) => `@@${field} ${value}`).join('\n')
    }, { now: t0 + seconds * 1000 }).result;
    const active = { ACTIVE: serial, SETTING: 289, CONNECTED: 1, BATT: serial };
    const [save] = report(0, active);
    assert.equal(save.bmsWatchdogStep, 'save-good');
    assert.deepEqual(report(30, { ACTIVE: '[]', SETTING: -1, GOOD: 289 }), [null, null]);
    const missing = { ...active, ACTIVE: '[]', SETTING: -1, GOOD: 289 };
    assert.deepEqual(report(60, missing), [null, null]);
    const [repair, alert] = report(90, missing);
    assert.equal(repair.bmsWatchdogStep, 'repair');
    assert.match(repair.payload, /BmsInstance SetValue %289/);
    assert.deepEqual(alert.notification, {
        title: 'BMS watchdog', type: 'warning',
        message: 'Controlling BMS was lost (-1); restored automatically to the SerialBattery.'
    });
    for (const seconds of [120, 150, 180]) {
        assert.deepEqual(report(seconds, { ...missing, SETTING: 289 }), [null, null]);
    }
    assert.deepEqual(report(210, { ...active, GOOD: 289 }), [null, null]);
    const state = watchdog.flow.get('bmsWatchdogState');
    assert.equal(state.status, 'ok');
    assert.equal(state.missingCount, 0);
});
