'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadHeatPumpState } = require('./harness');

const NOW = Date.parse('2026-11-22T12:00:00Z');

test('heat pump state merges partial DPs and publishes the model on the first output only', () => {
    const gx = loadHeatPumpState();
    gx.run({ topic: 'hp', payload: { data: { dps: {
        1: true, 2: 'mute', 5: 'heat', 15: 1, 101: 30, 102: 35, 108: 44, 112: 4, 115: 45, 116: 0, 999: 'extra'
    } } } }, { now: NOW });
    const { result, status } = gx.run({ topic: 'hp', payload: { data: { dps: { 102: 36 } } } }, { now: NOW + 1000 });
    const model = gx.flow.get('heatPumpModel');
    assert.deepEqual(result, [{ payload: model }, null, null]);
    assert.deepEqual(Object.keys(model), ['updated', 'readOnly', 'controls', 'devices', 'summary', 'curveChart',
        'dhwChart', 'heatCtl', 'status', 'items', 'unknown']);
    assert.deepEqual(model.devices.map(device => device.role), ['hp', 'valve', 'bypass', 'meter', 'acc', 'plate']);
    const { supply, ret, tank, compressorPowerW, mode, workMode, faults, defrostSign } = model.summary;
    assert.deepEqual({ supply, ret, tank, compressorPowerW, mode, workMode, faults, defrostSign }, {
        supply: 36, ret: 30, tank: 44, compressorPowerW: 880, mode: 'Silent', workMode: 'Heating', faults: ['Er03'], defrostSign: true
    });
    assert.deepEqual(model.unknown, [{ dp: '999', value: 'extra' }]);
    assert.deepEqual(status, { fill: 'yellow', shape: 'dot', text: 'out 36° tank 44° 45 Hz' });
    assert.equal(gx.flow.get('heatPump').hp.lastData, NOW + 1000);
    assert.equal(gx.flow.get('heatPump').hp.dps['101'], 30);
});

test('heat pump meter readings age out without erasing the retained meter state', () => {
    const gx = loadHeatPumpState();
    const packet = Buffer.alloc(8);
    packet.writeUInt16BE(2305, 0);
    packet.writeUIntBE(1975, 2, 3);
    packet.writeUIntBE(420, 5, 3);
    const { result: [{ payload: { summary } }] } = gx.run({ topic: 'meter',
        payload: { data: { dps: { 1: 1234, 6: packet.toString('base64') } } } }, { now: NOW });
    const power = ({ powerW, powerV, powerA, powerEnergyKwh, powerSource }) => [powerW, powerV, powerA, powerEnergyKwh, powerSource];
    assert.deepEqual(power(summary), [420, 230.5, 1.975, 12.34, 'DP 6']);
    const { result: [{ payload: stale }] } = gx.run({ topic: 'meter', payload: { state: 'DISCONNECTED' } },
        { now: NOW + 5 * 60000 + 1000 });
    assert.deepEqual(power(stale.summary), [null, null, null, null, 'DP 6']);
    assert.equal(stale.devices.find(device => device.role === 'meter').ageSeconds, 301);
    assert.equal(gx.flow.get('heatPump').meter.reading.powerW, 420);
});
