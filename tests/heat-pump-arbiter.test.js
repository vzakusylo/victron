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
    return { heat, tick, warm };
}

test('a pending owner group does not interrupt an already queued warm-up', () => {
    const f = fixture();
    const call = f.warm(NOW + 20 * MIN);
    assert.deepEqual(setters(call), [set(134, 9)]);
    const apply = f.heat.run({ topic: 'ui', payload: { action: 'ownerCurve', p23: 30, p24: 4 } }, { now: NOW + 20 * MIN + 100 });
    assert.deepEqual(setters(apply), []);
    step(call, 1500);
    assert.deepEqual(setters(call), [set(134, 9), set(133, 40)]);
    assert.equal(f.heat.flow.get('hpWriterShadow').owners.curve.writer, 'heat');
    assert.equal(f.heat.flow.get('hpWriterShadow').disagreements || 0, 0);
});

test('DHW supersedes the whole heating curve: drops its unsent tail and suppresses stale verification', () => {
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
    assert.deepEqual(setters(call), [set(134, 9), set(133, 0)]);
    assert.match(call.sent.find(m => /dropped \(superseded generation\)/.test(m[5]?.event?.text))?.[5].event.text, /P23 40/);
    step(call, 15000);
    assert.match(call.logs.find(line => line.startsWith('HP shadow verify')), /DP 134=9 .*superseded generation/);
    assert.ok(call.sent.some(m => m[5]?.event?.verificationSuperseded && /P24 9/.test(m[5].event.text)));
    assert.ok(!call.sent.some(m => m[5]?.event?.kind === 'fail'));
});

test('a later intent from the same writer is counted separately from ownership disagreements', () => {
    const f = fixture();
    const t = NOW + 20 * MIN;
    const first = f.warm(t);
    assert.deepEqual(setters(first), [set(134, 9)]);
    step(first, 1500);
    f.heat.run({ topic: 'ui', payload: { action: 'heatWarm', on: false } }, { now: t + 2000 });
    f.tick(t + 3000, { 133: 40, 134: 9 });
    step(first, 15000);
    const shadow = f.heat.flow.get('hpWriterShadow');
    assert.equal(shadow.sameWriterSupersessions, 1);
    assert.equal(shadow.disagreements || 0, 0);
    assert.ok(!first.logs.some(line => line.startsWith('HP shadow')));
    const model = f.tick(t + 4000, { 133: 40, 134: 9 }).result[0].payload;
    assert.equal(model.shadowDisagreements, 0);
    assert.equal(model.shadowSameWriterSupersessions, 1);
});

test('a denied warm-up leaves dispatch bookkeeping untouched and retries only after expiry', () => {
    const f = fixture();
    const t = NOW + 20 * MIN;
    f.heat.context.set('hpCurveLease', { writer: 'dhw', priority: 4, generation: 1, until: t + MIN });
    assert.deepEqual(setters(f.warm(t)), []);
    assert.equal(f.heat.context.get('heat').warmApplied || 0, 0);
    assert.deepEqual(f.heat.context.get('queue'), []);
    const accepted = f.tick(t + MIN);
    assert.deepEqual(setters(accepted), [set(134, 9)]);
    assert.equal(f.heat.context.get('heat').warmApplied || 0, 0, 'the first coefficient is not the whole request');
    step(accepted, 1500);
    assert.deepEqual(setters(accepted), [set(134, 9), set(133, 40)]);
    assert.equal(f.heat.context.get('heat').warmApplied, 5);
});

test('cancelling a partial warm-up restores even a coefficient not yet reflected in readback', () => {
    const f = fixture();
    const t = NOW + 20 * MIN;
    const call = f.warm(t);
    assert.deepEqual(setters(call), [set(134, 9)]);
    f.heat.run({ topic: 'ui', payload: { action: 'heatWarm', on: false } }, { now: t + 300 });
    f.tick(t + 1000); // cached telemetry still shows the owner curve
    step(call, 1500);
    step(call, 1500, 1);
    assert.deepEqual(setters(call), [set(134, 9), set(134, 7), set(133, 39)]);
});

test('DHW deploy recovery sends P22, P24, and P23 in order under one curve generation', () => {
    const f = fixture('live');
    const call = f.tick(NOW + 20 * MIN, { 132: '0', 133: 0, 134: 12 });
    const lease = f.heat.context.get('hpCurveLease');
    assert.equal(lease.writer, 'dhw');
    assert.deepEqual(setters(call), [set(132, '1')]);
    assert.deepEqual(f.heat.context.get('queue').map(item => [item.dps, item.modeGeneration]),
        [[134, lease.generation], [133, lease.generation]]);
    step(call, 1500);
    step(call, 1500, 1);
    assert.deepEqual(setters(call), [set(132, '1'), set(134, 7), set(133, 39)]);
});
