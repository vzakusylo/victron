'use strict';
// The checks made on the GX after the d#180 deploy of 14 Nov 2026, as tests:
// - a redeployed automations node waits for a new outdoor average and takes no samples around a defrost
// - once it has one, an ordinary cycle starts and follows the logged sequence (curve 0, valve, 90 s, boiler curve)
// - Er03 in the cycle ends it at once, blocks new starts, and "Allow DHW again" clears the block
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S;
const NOW = new Date(2026, 10, 14, 19, 0).getTime();

// A node right after a deploy: settings loaded from the file, empty DHW context.
function redeployed({ lastDefrost = NOW - 60 * MIN } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw: 'live', heat: 'off', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        dhw: { showerForce: false }, heatCurve: { p23: 38, p24: 4, at: NOW - 3600000 }, dhwLastEnd: NOW - 5 * 3600000
    }) }, { now: NOW });
    node.context.set('lastDefrost', lastDefrost);
    function tick(t, over = {}, valve = false, bypass = false, modeAt = 0) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 36, 103: -2, 104: 60, 108: 40, 112: 3, 115: 60, 116: 550,
                125: 36, 132: '1', 133: 38, 134: 4
            }, over), dpObservedAt: { 2: modeAt } },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: valve } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: bypass } }
        });
        return node.run({ topic: 'tick' }, { now: t });
    }
    const dhw = () => node.context.get('dhw');
    return { node, tick, dhw };
}

// Ticks every 30 s from `from` until the state changes or `limit` ticks passed; returns the time reached.
function until(c, from, state, over, valve, limit = 20) {
    let t = from;
    for (let i = 0; i < limit && c.dhw().state !== state; i++) { t += 30 * S; c.tick(t, over, valve); }
    assert.equal(c.dhw().state, state, 'expected state ' + state + ', why: ' + c.dhw().why);
    return t;
}

test('a redeployed node has no outdoor average and does not start DHW on a cold tank', () => {
    const c = redeployed({ lastDefrost: NOW - 5 * MIN });
    for (let i = 0; i < 6; i++) c.tick(NOW + i * 30 * S);
    assert.equal(c.dhw().state, 'HEATING');
    assert.equal(c.dhw().outAvg, null);
    assert.match(c.dhw().why, /no outdoor value yet/);
    assert.match(c.dhw().why, /defrost now or < 15 min ago/);
});

test('no outdoor sample is taken during a defrost', () => {
    const c = redeployed();
    // fan 0 with the compressor running is a defrost; the outdoor sensor reads 30-47 °C then
    for (let i = 0; i < 4; i++) c.tick(NOW + i * 30 * S, { 116: 0, 115: 60, 103: 40 });
    assert.equal(c.dhw().outAvg, null);
    assert.equal(c.dhw().state, 'HEATING');
});

test('after the quiet time the average returns and the cycle follows the logged sequence', () => {
    const c = redeployed({ lastDefrost: NOW - 5 * MIN });
    c.tick(NOW);
    assert.equal(c.dhw().outAvg, null);

    // 16 min after the defrost: samples are taken again, and three good ticks start the cycle
    let t = NOW + 11 * MIN;
    c.tick(t);
    assert.equal(c.dhw().outAvg, -2);
    t = until(c, t, 'STOP');
    const startedAt = t;
    assert.equal(c.dhw().live, true);
    assert.equal(c.dhw().startTank, 40);

    // compressor stopped for 20 s -> valve to the tank
    t = until(c, t, 'VALVE', { 115: 0, 133: 0 }, false);
    assert.ok(t - startedAt >= 20 * S);
    const valveAt = t;

    // the boiler curve is set only after the 90 s valve travel
    c.tick(valveAt + 60 * S, { 115: 0, 133: 0 }, true);
    assert.equal(c.dhw().state, 'VALVE');
    t = until(c, valveAt + 60 * S, 'DHW', { 115: 0, 133: 0 }, true);
    assert.ok(t - valveAt >= 90 * S);
    assert.equal(c.dhw().p24Cmd, 12);
    assert.ok(c.dhw().p23Cmd > 0 && c.dhw().p23Cmd <= c.dhw().goal);
});

// The valve is on the tank, water is 32 °C, and the raw outdoor sensor reads −1 °C.
// During recovery the controller uses the pre-defrost outdoor average instead.
function valveCycle({ outAvg = -6, recentDefrost = true } = {}) {
    const c = redeployed({ lastDefrost: NOW - 60 * MIN });
    const dps = { 101: 32, 102: 32, 103: -1, 108: 31, 115: 0, 116: 0 };
    c.tick(NOW, dps, true);
    Object.assign(c.dhw(), { state: 'VALVE', since: NOW - 100 * S, run: NOW + ':dhw', live: true, startAt: NOW - 3 * MIN,
        startTank: 30, outS: [[NOW - MIN, outAvg]], outAvg, p23Cmd: 0, p24Cmd: null, rampAt: 0, prot: null });
    if (recentDefrost) c.node.context.set('lastDefrost', NOW - 10 * MIN);
    return { c, dps };
}
// water 32 + startGap 7 = 39 °C at −1 °C with P24 12: P23 = round(−1 + 19 / 1.2) = 15 (pump target 39.2 °C)
const P23_START = 15;
const curve = (p23, p24, x) => Math.max(20, Math.min(60, 20 + p24 / 10 * (p23 - x)));

function silentRetryCycle() {
    const c = redeployed();
    c.tick(NOW);
    Object.assign(c.dhw(), { state: 'DHW', since: NOW, run: 'initial-dhw', live: true,
        startAt: NOW, startTank: 30, outS: [[NOW, -2]], p23Cmd: 22, p24Cmd: 12, rampAt: NOW });
    const logs = [];
    function tick(min, mode = 'smart', outdoor = -2, fresh = true) {
        const t = NOW + min * MIN;
        const dps = { 2: mode, 102: 55, 103: outdoor, 108: 31, 134: 12 };
        const call = c.tick(t, dps, true, false, t);
        for (let i = 0; i < call.timers.length; i++) {
            if (call.timers[i].ms === 1500) call.timers[i].cb();
        }
        // A report after the SET, not merely the cached observation used by the tick.
        if (fresh) c.node.flow.get('heatPump').hp.dpObservedAt[2] = t + S;
        for (const timer of call.timers) if (timer.ms === 15000) timer.cb();
        logs.push(...call.sent.map(m => m[5]?.event?.text).filter(Boolean));
        return call.sent.filter(m => m[1]?.payload?.dps === 2 && m[1].payload.set === 'mute').length;
    }
    return { c, tick, logs };
}

test('ordinary DHW Silent retries pause after three unconfirmed writes and log once', () => {
    const { tick, logs } = silentRetryCycle();
    assert.deepEqual([tick(1), tick(2, 'smart', -2, false), tick(3), tick(4), tick(7), tick(9), tick(10)],
        [1, 1, 1, 0, 0, 1, 0]);
    assert.equal(logs.filter(line => line.includes('mode Silent retry paused')).length, 1);
});

test('fresh Silent or a new DHW run resets the pause; cold protection bypasses it', () => {
    for (const reset of ['fresh Silent', 'new run', 'cold protection']) {
        const { c, tick } = silentRetryCycle();
        assert.deepEqual([tick(1), tick(2), tick(3), tick(4)], [1, 1, 1, 0]);
        if (reset === 'fresh Silent') assert.equal(tick(4.5, 'mute'), 0);
        else if (reset === 'new run') Object.assign(c.dhw(), { since: NOW + 4 * MIN, run: 'next-dhw' });
        else c.dhw().outS = [[NOW + 4 * MIN, -20]];
        assert.equal(tick(5, 'smart', reset === 'cold protection' ? -20 : -2), 1, reset);
    }
});

test('a routine Silent SET already in the queue is dropped and logged during backoff', () => {
    const { c, tick, logs } = silentRetryCycle();
    assert.deepEqual([tick(1), tick(2), tick(3)], [1, 1, 1]);
    c.node.context.set('hpModeLease', { generation: 4, until: NOW + 5 * MIN });
    c.node.context.set('queue', [{ role: 'hp', dps: 2, set: 'mute', rule: 'dhw', modeGeneration: 4,
        run: c.dhw().run, silentPhase: c.dhw().since, text: 'mode Silent' }]);
    c.node.context.set('pumping', true);
    c.node.context.set('pumpAt', NOW - 10 * MIN);
    assert.equal(tick(4), 0);
    assert.ok(logs.includes('queued mode Silent write dropped (retry paused)'));
    assert.equal(c.node.context.get('queue').length, 0);
});

test('the DHW start curve uses the held average, not the instantaneous sensor', () => {
    for (const raw of [-1, 40]) {
        const { c, dps } = valveCycle();
        c.tick(NOW + 30 * S, { ...dps, 103: raw }, true);
        assert.equal(c.dhw().state, 'DHW', c.dhw().why);
        assert.equal(c.dhw().p23Cmd, 10, '39 °C at −6 °C, rounded to the nearest P23');
    }
});

test('while the compressor is off the ramp may ask startGap above the water, and only gap once it runs', () => {
    const { c, dps } = valveCycle({ outAvg: -1, recentDefrost: false });
    let t = NOW + 30 * S;
    c.tick(t, dps, true);
    for (let i = 0; i < 15; i++) { t += MIN; c.tick(t, dps, true); }
    const off = c.dhw().p23Cmd;
    assert.ok(curve(off, c.dhw().p24Cmd, -1) <= 32 + 7 + 1.2, 'off: no more than water + startGap (one P23 step of slack)');
    assert.ok(curve(off, c.dhw().p24Cmd, -1) >= 32 + 6, 'off: at least water + 6 °C');
    // compressor running: the ordinary 5 °C gap caps the ramp, so P23 comes down to it
    for (let i = 0; i < 4; i++) { t += MIN; c.tick(t, Object.assign({}, dps, { 115: 40, 116: 550 }), true); }
    assert.ok(curve(c.dhw().p23Cmd, c.dhw().p24Cmd, -1) <= 32 + 5 + 1.2, 'running: ramp capped at water + gap');
});

// Recorded on the GX, 19 Nov: with the valve on the tank, outdoor (DP 103) −1 °C and water 32 / 32 °C, the
// compressor stayed at 0 Hz from P23 6 to 12 (pump target 29.6 → 35.6 °C) and started at 23:47:35 on P23 13
// (36.8 °C, water + 4.8). The fixed start must ask at least that much on the first command, not 17 min later.
test('19 Nov replay: the first boiler command already reaches the observed start point', () => {
    const { c, dps } = valveCycle({ outAvg: -1, recentDefrost: false });
    c.tick(NOW + 30 * S, dps, true);
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    assert.equal(c.dhw().p24Cmd, 12);
    const first = c.dhw().p23Cmd;
    assert.equal(first, P23_START, 'first P23 is the water + startGap point (the compressor started on the GX at 13)');
    // it neither climbs nor drops while the compressor is still off
    let t = NOW + 30 * S;
    for (let i = 0; i < 10; i++) { t += MIN; c.tick(t, dps, true); }
    assert.equal(c.dhw().p23Cmd, first, 'P23 holds at the start point while the compressor is off');
});

test('Er03 in an ordinary cycle ends it, blocks new starts, and Allow DHW again clears the block', () => {
    const c = redeployed({ lastDefrost: NOW - 5 * MIN });
    let t = NOW + 11 * MIN;
    c.tick(t);
    t = until(c, t, 'STOP');
    t = until(c, t, 'VALVE', { 115: 0, 133: 0 }, false);
    t = until(c, t, 'DHW', { 115: 0, 133: 0 }, true);

    // what the pump reported on 14 Nov 19:56: fault bit 0, 0 Hz, supply = return
    t += 30 * S;
    c.tick(t, { 15: 1, 115: 0, 116: 0, 101: 36, 102: 36, 133: 22, 134: 12 }, true);
    assert.equal(c.dhw().state, 'HEATING');
    assert.equal(c.dhw().run, null);
    const block = c.node.context.get('settings').dhwBlock;
    assert.equal(block.why, 'fault Er03 (water flow)');
    assert.equal(block.at, t);

    // the fault clears and the tank is still cold, but nothing starts by itself
    for (let i = 1; i <= 8; i++) c.tick(t + 2 * 3600000 + i * 30 * S);
    assert.equal(c.dhw().state, 'HEATING');
    assert.match(c.dhw().why, /blocked: the last cycle was aborted/);

    c.node.run({ topic: 'ui', payload: { action: 'dhwResume' } }, { now: t + 2 * 3600000 + 5 * MIN });
    assert.equal(c.node.context.get('settings').dhwBlock, null);
    c.tick(t + 2 * 3600000 + 6 * MIN);
    assert.doesNotMatch(c.dhw().why, /blocked/);
});
