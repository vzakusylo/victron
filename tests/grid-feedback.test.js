'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadNode } = require('./harness');
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'grid', 'feedback.js'), 'utf8');
const [advance, notice] = new Function(source + '\nreturn [advanceGridFeedback, gridFeedbackNotice];')();

function channel(gap = 10100) {
    let state;
    return (now, value = 100, reading, options = {}) => {
        const result = advance(state, { now, value, reading, gap, tolerance: 0.01, ...options });
        state = result.state;
        return result;
    };
}

test('a matching read verifies the write without a retry or alarm', () => {
    const step = channel();
    assert.equal(step(0).write, 100);
    assert.equal(step(3999).read, undefined);
    assert.equal(step(4000).read, true);
    assert.equal(step(4001, 100, { value: 100.005 }).state.phase, 'verified');
    assert.equal(step(10000).write, undefined);
});

test('a brief target change cannot strand a mismatching write', () => {
    const step = channel();
    step(0);
    step(4000);
    step(4001, 200, { value: 50 });
    assert.equal(step(10100, 100).write, 100);
    step(14100);
    assert.match(step(14101, 100, { value: 50 }).alarm, /expected 100.*read 50/);
});

test('an hourly reassertion can recover a failed limit without reopening the retry budget', () => {
    const step = channel(0);
    step(0);
    step(4000);
    assert.equal(step(4001, 100, { value: 50 }).write, 100);
    step(8001);
    step(8002, 100, { value: 50 });
    assert.equal(step(9000).write, undefined);
    assert.equal(step(3600000, 100, undefined, { reassert: true }).write, 100);
    step(3604000);
    const result = step(3604001, 100, { value: 50 }, { reassert: false });
    assert.equal(result.state.phase, 'failed');
    assert.equal(result.alarm, undefined);
});

test('node 01 paces real ESS output and does not send a new decision while reading', async () => {
    const held = [];
    const bus = {
        connection: Object.assign(new EventEmitter(), { stream: { end() {} } }),
        listNames: callback => callback(null, ['com.victronenergy.vebus.test']),
        invoke: (request, callback) => {
            if (request.path === '/Settings/CGwacs/AcPowerSetPoint') held.push(callback);
            else callback(null, ['v', [request.path === '/DeviceInstance' ? 276 : 0]]);
        }
    };
    const control = loadNode('01 Battery + Grid Controller.js', undefined, undefined, { dbus: { systemBus: () => bus } });
    const start = new Date(2026, 10, 16, 21, 59, 40).getTime();
    const tick = ms => control.run({ topic: 'grid-control-tick' }, { now: start + ms }).result;
    control.context.set('batteryVoltage', 54);
    control.context.set('batteryConsumedAh', 40);
    const first = tick(0)[1].payload;
    assert.equal(tick(2000)[1], null);
    assert.equal(tick(4000)[1], null);
    assert.equal(held.length, 1);
    held.shift()(null, ['v', [first]]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tick(10000)[1], null);
    assert.equal(tick(12000)[1].payload, first);
    assert.equal(tick(16000)[1], null);
    const pending = tick(24000);
    assert.notEqual(pending[7].tick.decision.finalGridSetpoint, first);
    assert.equal(pending[1], null);
    held.shift()(null, ['v', [first]]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tick(26000)[1].payload, pending[7].tick.decision.finalGridSetpoint);
});

test('an ignored write is retried once, without bypassing the output gate', () => {
    const step = channel();
    step(0);
    step(4000);
    assert.equal(step(4001, 100, { value: 50 }).write, undefined);
    assert.equal(step(10100).write, 100);
    assert.equal(step(14100).read, true);
    assert.match(step(14101, 100, { value: 50 }).alarm, /expected 100.*read 50/);
    assert.equal(step(20100).write, undefined);
    assert.equal(step(25000).read, true);
    assert.equal(step(25001, 100, { error: 'D-Bus timeout' }).alarm, undefined);
    assert.equal(step(36000).read, true);
    assert.equal(step(36001, 100, { value: 100 }).state.fault, undefined);
});

test('a newer decision replaces an obsolete retry at the next permitted write', () => {
    const step = channel();
    step(0);
    step(4000);
    assert.equal(step(4001, 200, { value: 50 }).alarm, undefined);
    assert.equal(step(10100, 200).write, 200);
    assert.equal(step(14100, 200).read, true);
    assert.equal(step(14101, 200, { value: 200 }).state.phase, 'verified');
});

test('one alert per incident and a 15 minute gap between incidents', () => {
    const faults = ['VE.Bus: expected 10; read 25'];
    const step = (state, activeFaults, now) => notice(state, activeFaults, now, 0);
    const first = step(undefined, faults, 0);
    assert.match(first.text, /grid not following setpoint: VE.Bus/);
    assert.equal(step(first.state, faults, 3600000).text, undefined);
    const recovered = step(first.state, [], 10);
    assert.equal(step(recovered.state, faults, 20).text, undefined);
    assert.match(step(recovered.state, faults, 900000).text, /VE.Bus/);
});

test('persisted notice stamps outside the current process lifetime start a cooldown once', () => {
    const faults = ['VE.Bus: expected 10; read 25'];
    const clockStart = 1000000;
    const now = clockStart + 2000;
    for (const lastAlertElapsed of [100, now + 10000000]) {
        const restored = notice({ lastAlertElapsed }, faults, now, clockStart);
        assert.equal(restored.text, undefined);
        assert.equal(notice(restored.state, faults, now + 899999, clockStart).text, undefined);
        assert.match(notice(restored.state, faults, now + 900000, clockStart).text, /VE.Bus/);
    }
});
