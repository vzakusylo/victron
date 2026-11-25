'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, loadHeatPumpState } = require('./harness');

const MIN = 60_000;
const NOW = new Date(2026, 10, 24, 19, 0).getTime();

function rig(heat = {}, saved = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { heat: 'live', dhw: 'off' },
        heat: { kickMin: 1, offCurveMin: 10, ...heat }, heatCurve: { p23: 40, p24: 9 }, ...saved
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const dps = { 1: true, 2: 'smart', 15: 0, 101: 35, 102: 40, 103: -9, 108: 50, 112: 6, 115: 89, 116: 550,
        121: 6, 125: 36, 132: '1', 133: 40, 134: 9 };
    const writes = [];
    function tick(i, over = {}) {
        const t = NOW + i * 30_000;
        const device = (dps) => ({ state: 'CONNECTED', lastData: t, dps });
        node.flow.set('heatPump', { hp: device({ ...dps, ...over }), valve: device({ 1: false }), bypass: device({ 1: false }) });
        const r = node.run({ topic: 'tick' }, { now: t });
        writes.push(...r.sent.flat().filter(m => m?.payload?.operation === 'SET').map(m => m.payload));
        return node.flow.get('dhwView');
    }
    return { node, dps, tick, writes };
}

test('fixed DP 125 does not influence the heat target or the page curve point', () => {
    const c = rig();
    let dv;
    for (let i = 0; i <= 5; i++) dv = c.tick(i);
    assert.equal(dv.heat.target, 60);
    const page = loadHeatPumpState();
    page.flow.set('dhwView', dv);
    const chart = page.run({ topic: 'hp', payload: { data: { dps: { ...c.dps, 103: -6 } } } },
        { now: dv.at }).result[0].payload.curveChart;
    assert.equal(chart.target, 60);
    assert.equal(chart.sensor, -6);
    assert.equal(chart.reported, 36);
    assert.equal(chart.outdoorText, 'sensor -9 °C (10-min average)');
});

test('no outdoor average means no heat target, lag decision or dashboard curve point', () => {
    const c = rig();
    let dv;
    for (let i = 0; i <= 25; i++) dv = c.tick(i, { 103: null, 102: 24, 115: 50 });
    assert.equal(dv.heat.target, null);
    assert.equal(dv.heat.lag, null);
    assert.match(dv.heat.why, /no outdoor average/);
    assert.deepEqual(c.writes, []);
    const page = loadHeatPumpState();
    const chart = page.run({ topic: 'hp', payload: { data: { dps: c.dps } } }, { now: dv.at }).result[0].payload.curveChart;
    assert.equal(chart.target, null, 'raw sensor alone is not the average');
    assert.equal(chart.reported, 36);
});

test('at 89 Hz for 30 min, flat supply 20 °C below the target does not alarm or step up', () => {
    const c = rig();
    let dv;
    for (let i = 0; i <= 60; i++) dv = c.tick(i);
    assert.equal(dv.heat.offCurve.since, 0);
    assert.equal(dv.heat.offCurve.today, 0);
    assert.equal(dv.heat.lag, -20);
    assert.match(dv.status.text, /capacity-limited: compressor at max/);
    assert.deepEqual(c.writes, []);
});

test('capacity defers a new warm-up and band offset; a falling supply releases the gate', () => {
    const c = rig({ band: true, bandUp: 5 }, {
        heatCurve: { p23: 38, p24: 9 }, heatWarm: { at: NOW, until: NOW + 60 * MIN, deltaC: 5 }
    });
    let dv;
    for (let i = 0; i <= 6; i++) dv = c.tick(i, { 2: 'mute', 103: 0, 133: 38, 102: 39 + Math.min(i, 2) * 0.5 });
    assert.equal(dv.heat.target, 54.2, 'warm-up has not raised the target');
    assert.equal(dv.heat.warm.applied, 0);
    assert.match(dv.heat.warm.note, /capacity-limited/);
    assert.deepEqual(c.writes, []);
    dv = c.tick(7, { 2: 'mute', 103: 0, 133: 38, 102: 39 });
    assert.equal(dv.heat.target, 56);
    assert.deepEqual(c.writes.map(w => [w.dps, w.set]), [[133, 40]]);
});

test('flat supply does not kick at 85 Hz, but can kick below capacity', () => {
    const c = rig();
    for (let i = 0; i <= 4; i++) c.tick(i, { 2: 'mute', 115: 85 });
    assert.deepEqual(c.writes, []);
    let dv;
    for (let i = 5; i <= 7; i++) dv = c.tick(i, { 2: 'mute', 115: 84 });
    assert.equal(dv.heat.kick.phase, 'smart');
    assert.deepEqual(c.writes.map(w => [w.dps, w.set]), [[2, 'smart']]);
});
