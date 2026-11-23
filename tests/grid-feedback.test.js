'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'grid', 'feedback.js'), 'utf8');
const [advance, notice] = new Function(source + '\nreturn [advanceGridFeedback, gridFeedbackNotice];')();

function channel(gap = 10100) {
    let state;
    return (now, value = 100, reading) => {
        const result = advance(state, { now, value, reading, gap, tolerance: 0.01 });
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
    const first = notice(undefined, faults, 0);
    assert.match(first.text, /grid not following setpoint: VE.Bus/);
    assert.equal(notice(first.state, faults, 3600000).text, undefined);
    const recovered = notice(first.state, [], 10);
    assert.equal(notice(recovered.state, faults, 20).text, undefined);
    assert.match(notice(recovered.state, faults, 900000).text, /VE.Bus/);
});
