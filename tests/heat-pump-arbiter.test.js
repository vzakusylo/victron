'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const arbiter = require('../lib/heat-pump/arbiter');
const { loadNode } = require('./harness');

test('all writer pairs obey priority without mutating state', () => {
    const writers = ['owner', 'heat', 'kick', 'recovery', 'dhw', 'protection'];
    for (const [i, owner] of writers.entries()) {
        const { state } = arbiter.claim({}, 'mode', owner, 'first', 0);
        Object.freeze(state.mode);
        Object.freeze(state);
        for (const [j, challenger] of writers.entries()) {
            const result = arbiter.claim(state, 'mode', challenger, 'second', 1);
            assert.equal(result.state.mode.writer, j < i ? owner : challenger);
            assert.equal(result.token, j < i ? null : 2);
            assert.equal(arbiter.check(result.state, 'mode', 1, 1), j < i ? null : 'superseded generation');
        }
    }
});

test('three curve coefficients share an intent version and expiry releases only that resource', () => {
    const [p22, p23, p24] = [132, '133', 134].map(dp => arbiter.resource('hp', dp));
    const first = arbiter.claim({}, p22, 'dhw', 'curve-a', 0);
    const second = arbiter.claim(first.state, p23, 'dhw', 'curve-a', 1);
    const third = arbiter.claim(second.state, p24, 'dhw', 'curve-a', 2);
    assert.equal(first.token, second.token);
    assert.equal(first.token, third.token);
    const mode = arbiter.claim(third.state, arbiter.resource('hp', 2), 'owner', 'mode-a', 3);
    const band = arbiter.claim(mode.state, arbiter.resource('hp', 121), 'heat', 'band-a', 4);
    assert.equal(Object.keys(band.state).length, 3);
    assert.equal(arbiter.resource('valve', 2), null);
    const until = band.state.curve.until;
    assert.equal(arbiter.check(band.state, p23, first.token, until - 1), null);
    assert.equal(arbiter.check(band.state, p24, first.token, until), 'expired lease');
    const resumed = arbiter.claim(band.state, p23, 'owner', 'slider', until);
    assert.ok(resumed.token > first.token);
    assert.equal(arbiter.check(resumed.state, 'mode', mode.token, until), null);
    assert.equal(arbiter.check(resumed.state, 'hysteresis', band.token, until), null);
});

const NOW = Date.UTC(2026, 10, 22, 12);
const MIN = 60000;
const setters = call => call.sent.flatMap(msg => msg[1]?.payload?.operation === 'SET' ? [msg[1].payload] : []);
const set = (dps, value) => ({ operation: 'SET', dps, set: value });
const step = (call, ms, i = 0) => {
    const timer = call.timers.filter(t => t.ms === ms)[i];
    assert.ok(timer, `expected timer ${ms} #${i}`);
    timer.cb();
};

function fixture(dhw = 'off') {
    const heat = loadNode('40 Heat pump automations.js');
    const slider = loadNode('37 Heat pump command.js', undefined, heat.flow);
    heat.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { heat: 'live', dhw, df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: { kickMin: 0 }, dhw: { showerForce: false },
        heatCurve: { p23: 39, p24: 7 }, dhwLastEnd: NOW - 5 * 60 * MIN
    }) }, { now: NOW });
    const tick = (now, over = {}) => {
        heat.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: now, dps: {
                1: true, 2: 'mute', 15: 0, 101: 31, 102: 36, 103: -2, 104: 60, 108: 50, 112: 3, 115: 69, 116: 596,
                125: 36, 132: '1', 133: 39, 134: 7, ...over
            } },
            valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: now, dps: { 1: false } }
        });
        return heat.run({ topic: 'tick' }, { now });
    };
    const warm = now => {
        heat.run({ topic: 'ui', payload: { action: 'heatWarm', on: true, hours: 1, deltaC: 5 } }, { now });
        return tick(now);
    };
    return { heat, slider, tick, warm };
}

test('the 40/9 warm-up versus slider race is flagged without changing any outgoing SET', () => {
    const f = fixture();
    const call = f.warm(NOW + 20 * MIN);
    assert.deepEqual(setters(call), [set(134, 9)]);
    const slider = f.slider.run({ topic: 'curve', payload: { p23: 30 } }, { now: NOW + 20 * MIN + 100 });
    assert.deepEqual(slider.result, [{ payload: set(133, 30) }, null, null]);
    assert.match(slider.logs.find(line => line.startsWith('HP shadow')), /slider curve DP 133=30 owner@- vs heat@1/);
    step(call, 1500);
    assert.deepEqual(setters(call), [set(134, 9), set(133, 40)]);
    assert.equal(f.heat.flow.get('hpWriterShadow').disagreements, 1);
});

test('DHW claim supersedes an already sent and queued heating curve command without enforcing it', () => {
    const f = fixture('live');
    const t = NOW + 20 * MIN;
    const call = f.warm(t);
    assert.deepEqual(setters(call), [set(134, 9)]);

    // Prime the real DHW start condition; keep the write gap timer pending so FIFO still has the heat P23.
    const dhw = f.heat.context.get('dhw');
    Object.assign(dhw, { streak: 3, outS: [[t, -2]] });
    f.tick(t + 100, { 108: 35 });
    assert.equal(f.heat.flow.get('hpWriterShadow').owners.curve.writer, 'dhw');
    step(call, 1500);
    assert.deepEqual(setters(call), [set(134, 9), set(133, 40)]);
    assert.match(call.logs.find(line => line.startsWith('HP shadow dequeue')), /DP 133=40 .*superseded generation/);
    step(call, 15000);
    assert.match(call.logs.find(line => line.startsWith('HP shadow verify')), /DP 134=9 .*superseded generation/);
    step(call, 15000, 1);
    assert.equal(call.logs.filter(line => line.startsWith('HP shadow verify')).length, 1, 'repeats are rate limited');
    assert.equal(f.heat.flow.get('hpWriterShadow').disagreements, 3, 'suppressed lines still count');
});
