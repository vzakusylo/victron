'use strict';
// H2 + H7: during a defrost and its recovery the outdoor sensor (DP 103) reads 30–47 °C and the pump's set point is
// disturbed. The 10-min average, the pump outdoor latch, the page and the history keep the value from before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S;
const NOW = new Date(2026, 10, 20, 7, 0).getTime();
const FILE = '40 Heat pump automations.js';

function rig() {
    const node = loadNode(FILE);
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw: 'off', heat: 'off', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: { kickMin: 1, kickSec: 60 }, dhw: { showerForce: false }, heatCurve: { p23: 39, p24: 4, at: NOW - 3600000 }, dhwLastEnd: NOW - 5 * 3600000
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    function tick(t, over = {}) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 36, 103: -7, 104: 60, 108: 49, 112: 3, 115: 40, 116: 550,
                125: 36, 132: '1', 133: 39, 134: 4
            }, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        return node.run({ topic: 'tick' }, { now: t });
    }
    return { node, tick, dhw: () => node.context.get('dhw'), pumpOut: () => node.context.get('pumpOut') };
}

// 20 Nov shape: steady heating at -7 °C, a defrost (fan 0) with DP 103 at 40 °C, then a slow recovery (> 15 min)
// with the sensor still high and the pump's set point disturbed.
test('defrost + slow recovery: the outdoor average and the pump latch stay at the pre-defrost value, then resume', () => {
    const c = rig();
    let t = NOW;
    for (let i = 0; i <= 12; i++, t += 30 * S) c.tick(t);
    assert.equal(c.dhw().outAvg, -7);
    assert.equal(c.pumpOut().v, -1);
    const latchedAt = c.pumpOut().at;

    for (let i = 0; i < 6; i++, t += 30 * S) c.tick(t, { 103: 40, 116: 0, 115: 60, 102: 25, 125: 31 });
    assert.equal(c.node.flow.get('dhwView').outHeld, true);
    // recovery: fan back, sensor still high, supply low for 25 min (past DEFROST_QUIET_MIN)
    for (let i = 0; i < 50; i++, t += 30 * S) {
        c.tick(t, { 103: 40, 116: 550, 115: 40, 102: 28, 125: 31 });
        assert.equal(c.dhw().outAvg, -7, 'recovery minute ' + (i / 2));
        assert.equal(c.pumpOut().v, -1);
        assert.equal(c.pumpOut().at, latchedAt, 'not re-latched');
    }
    assert.equal(c.node.flow.get('dhwView').outHeld, true, 'still held after 15 min, supply not back');

    // supply back: the sensor is used again
    for (let i = 0; i < 40; i++, t += 30 * S) c.tick(t, { 103: -3, 102: 36, 125: 36 });
    assert.equal(c.node.flow.get('dhwView').outHeld, false);
    assert.equal(c.dhw().outAvg, -3);
});

function page(dv, dps) {
    const node = loadNode('34 Heat pump state.js');
    if (dv) node.flow.set('dhwView', Object.assign({ at: NOW }, dv));
    return node.run({ topic: 'hp', payload: { data: { dps } } }, { now: NOW }).result[0].payload.summary;
}

test('page summary: the held average while the view says outHeld, else the sensor; the raw value stays', () => {
    const dps = { 1: true, 102: 25, 103: 40 };
    const held = page({ outAvg: -7, outHeld: true }, dps);
    assert.equal(held.outdoor, -7);
    assert.equal(held.outdoorHeld, true);
    assert.equal(held.outdoorRaw, 40);
    const live = page({ outAvg: -7, outHeld: false }, dps);
    assert.equal(live.outdoor, 40);
    assert.equal(live.outdoorHeld, false);
    assert.equal(page({ outAvg: -7, outHeld: true, at: NOW - 3600000 }, dps).outdoor, 40, 'a stale view is not used');
    assert.equal(page(null, dps).outdoor, 40, 'no view: the sensor');
});

test('history: the daily and hourly outdoor averages skip a defrost and the 15 min after it', () => {
    const node = loadNode('38 Build heat pump history.js');
    const rows = ['#day 2026-11-20', '#hp1 2026-11-20 07 cols=t,st,103,115,116', '0,CCCC,-7,40,550'];
    for (let t = 30; t < 3600; t += 30) {
        const m = t / 60;
        let row;
        if (m >= 10 && m < 13) row = [t, '', 40, 60, 0];          // defrost
        else if (m >= 13 && m < 27.5) row = [t, '', 25, 40, 550];   // 15 min after the last defrost row
        else row = [t, '', -7, 40, 550];
        rows.push(row.join(','));
    }
    const p = node.run({ topic: 'day', day: '2026-11-20', payload: rows.join('\n') }, { now: NOW }).result.payload;
    assert.equal(p.stats.outdoor.avg, -7);
    assert.equal(p.stats.outdoor.max, -7);
    assert.equal(p.hourly[7].outdoor, -7);
    assert.equal(p.stats.defrost, 1);
});
