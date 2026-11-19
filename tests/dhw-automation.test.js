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
    function tick(t, over = {}, valve = false, bypass = false) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 36, 103: -2, 104: 60, 108: 40, 112: 3, 115: 60, 116: 550,
                125: 36, 132: '1', 133: 38, 134: 4
            }, over) },
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

// 19 Nov 23:30: a stale outdoor average (−6 °C) while the pump read −1 °C; P23 8 gave the pump 30.8 °C,
// below the 32 °C water, and the compressor never started.
function staleOutdoorCycle() {
    const c = redeployed({ lastDefrost: NOW - 60 * MIN });
    const dps = { 101: 32, 102: 32, 103: -1, 108: 31, 115: 0, 116: 0 };
    c.tick(NOW, dps, true);
    Object.assign(c.dhw(), { state: 'VALVE', since: NOW - 100 * S, run: NOW + ':dhw', live: true, startAt: NOW - 3 * MIN,
        startTank: 30, outS: [[NOW - MIN, -6]], outAvg: -6, p23Cmd: 0, p24Cmd: null, rampAt: 0, prot: null });
    // keep the average stale: a recent defrost stops new outdoor samples, exactly as on the GX
    c.node.context.set('lastDefrost', NOW - 10 * MIN);
    return { c, dps };
}
const curve = (p23, p24, x) => Math.max(20, Math.min(60, 20 + p24 / 10 * (p23 - x)));

test('the DHW start curve uses the pump\'s live outdoor value, not a stale average', () => {
    const { c, dps } = staleOutdoorCycle();
    c.tick(NOW + 30 * S, dps, true);
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    const target = curve(c.dhw().p23Cmd, c.dhw().p24Cmd, -1);   // what the pump computes
    assert.ok(target >= 32 + 6, 'pump target ' + target + ' °C must be at least 6 °C above the 32 °C water');
});

test('while the compressor is off the ramp may ask startGap above the water, and only gap once it runs', () => {
    const { c, dps } = staleOutdoorCycle();
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

test('an implausible live outdoor reading falls back to the average', () => {
    const { c, dps } = staleOutdoorCycle();
    c.tick(NOW + 30 * S, Object.assign({}, dps, { 103: 40 }), true);
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    // water 32 + startGap 7 = 39 °C at the −6 °C average: P23 = round(−6 + 19 / 1.2) = 10 (with 40 °C it would be 40)
    assert.equal(c.dhw().p23Cmd, 10);
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
