'use strict';
// P6: pump set = point + up, pump hysteresis DP 121 = max(2, up + down); the controller band itself is tested in heat-simplify.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const NOW = new Date(2026, 10, 14, 20, 10).getTime();
const GX_HEAT = { lagUp: 1, overC: 0, gapMax: 3, stepMin: 12, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 0, kickSec: 60 };

function heating({ heat = {}, heatMode = 'live', saved = {}, hyst = 5, wholeHyst = false } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify(Object.assign({
        master: true, modes: { dhw: 'off', heat: heatMode, df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: Object.assign({}, GX_HEAT, heat), dhw: { showerForce: false }, heatCurve: { p23: 38, p24: 4, at: NOW - H }, dhwLastEnd: NOW - 5 * H
    }, saved)) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    const pump = { 121: hyst, 133: 38, 134: 4 };
    let supply = 36;
    function tick(t) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: supply - 5, 102: supply, 103: -2, 104: 60, 108: 47, 112: 3, 115: 69, 116: 596,
                125: 36, 132: '1'
            }, pump) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        const call = node.run({ topic: 'tick' }, { now: t });
        for (const m of call.sent) {
            if (m && m[1] && m[1].payload && m[1].payload.operation === 'SET') {
                writes.push({ t, dps: m[1].payload.dps, set: m[1].payload.set });
                pump[m[1].payload.dps] = wholeHyst && m[1].payload.dps === 121 ? Math.trunc(m[1].payload.set) : m[1].payload.set;
            }
        }
    }
    const run = (from, to, step = 10 * S) => { for (let t = from; t <= to; t += step) tick(t); };
    const set = (cfg, t) => node.run({ topic: 'ui', payload: { action: 'heatSet', cfg } }, { now: t });
    const settings = () => node.context.get('settings');
    return { node, run, set, settings, writes, pump, setSupply: (v) => { supply = v; } };
}

test('band is off by default and writes nothing', () => {
    const c = heating();
    c.run(NOW, NOW + 15 * MIN);
    assert.deepEqual(c.writes, []);
    assert.equal(c.settings().heat.band, false);
});

test('a fractional band (up + down = 2.5) writes a whole-degree hysteresis once; a pump that keeps whole degrees is not rewritten every 2 min', () => {
    const c = heating({ wholeHyst: true, heat: { band: true, bandDown: 2.5, bandUp: 0, lagUp: undefined, overC: undefined } });
    c.run(NOW, NOW + 30 * MIN);
    const hyst = c.writes.filter((w) => w.dps === 121);
    assert.deepEqual(hyst.map((w) => w.set), [3], JSON.stringify(hyst));
    assert.equal(c.pump[121], 3);
});

test('band 0 / 2: pump set at point + 2, hysteresis 2, your hysteresis saved', () => {
    const c = heating({ heat: { band: true, bandDown: 0, bandUp: 2, lagUp: undefined, overC: undefined } });
    c.run(NOW, NOW + 6 * MIN);
    assert.equal(c.pump[121], 2, 'restart 2 °C below the stop point = at the curve point');
    assert.ok(c.pump[133] > 38 || c.pump[134] > 4, 'pump curve raised by up');
    assert.equal(c.settings().heatBandSaved, 5);
    assert.deepEqual(c.settings().heatCurve, { p23: 38, p24: 4, at: NOW - H }, 'band curve is not stored as yours');
});

test('a supply inside the band does not make the controller step up or down', () => {
    const c = heating({ heat: { band: true, bandDown: 0, bandUp: 2 } });
    c.setSupply(37);                       // band 36…38, centre 37
    c.run(NOW, NOW + 30 * MIN);
    assert.ok(!c.writes.some(w => w.dps === 2), 'no pump mode change');
    assert.equal(c.node.context.get('heat').boost, 0);
});

test('band off: your curve and hysteresis come back', () => {
    const c = heating({ heat: { band: true, bandDown: 0, bandUp: 2 } });
    c.run(NOW, NOW + 6 * MIN);
    c.set({ band: false }, NOW + 6 * MIN);
    c.run(NOW + 6 * MIN + 10 * S, NOW + 14 * MIN);
    assert.equal(c.pump[121], 5);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
    assert.equal(c.settings().heatBandSaved, null);
});

test('controller Off: your hysteresis comes back', () => {
    const c = heating({ heat: { band: true, bandDown: 0, bandUp: 2 } });
    c.run(NOW, NOW + 6 * MIN);
    c.node.run({ topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'off' } }, { now: NOW + 6 * MIN });
    c.run(NOW + 6 * MIN + 10 * S, NOW + 14 * MIN);
    assert.equal(c.pump[121], 5);
    assert.equal(c.pump[133], 38);
});

test('the band sliders accept 0…5 as they are; out-of-range values are ignored; the pump hysteresis is at least 2', () => {
    const c = heating();
    c.set({ band: true, bandDown: 1, bandUp: 0.5 }, NOW);
    assert.equal(c.settings().heat.bandUp, 0.5);
    assert.equal(c.settings().heat.bandDown, 1);
    c.set({ bandDown: 9, bandUp: 20 }, NOW);
    assert.equal(c.settings().heat.bandDown, 1);
    assert.equal(c.settings().heat.bandUp, 0.5);
    c.run(NOW, NOW + 6 * MIN);
    assert.equal(c.pump[121], 2, 'up + down 1.5 → the pump minimum 2');
});

test('band in Test mode writes nothing', () => {
    const c = heating({ heat: { band: true }, heatMode: 'dry' });
    c.run(NOW, NOW + 10 * MIN);
    assert.deepEqual(c.writes, []);
});

test('a saved hysteresis survives a restart and is restored after the band is turned off', () => {
    const c = heating({ heat: { band: false }, saved: { heatBandSaved: 6 }, hyst: 2 });
    c.run(NOW, NOW + 3 * MIN);
    assert.equal(c.pump[121], 6);
    for (const bad of [1, 19, 'x']) {
        const b = heating({ saved: { heatBandSaved: bad } });
        assert.equal(b.settings().heatBandSaved, null, String(bad));
    }
});

test('switching On → Test puts your hysteresis and curve back (PR #66 review)', () => {
    const c = heating({ heat: { band: true, bandDown: 0, bandUp: 2 } });
    c.run(NOW, NOW + 6 * MIN);
    assert.equal(c.pump[121], 2);
    c.node.run({ topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'dry' } }, { now: NOW + 6 * MIN });
    c.run(NOW + 6 * MIN + 10 * S, NOW + 14 * MIN);
    assert.equal(c.pump[121], 5);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
});
