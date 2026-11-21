'use strict';
// P1: heating stuck in Silent — step up when the pump left the controller's mode, log every blocked step up.
// P2: "not following the curve" monitor (status line, Automation log, daily count).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const NOW = new Date(2026, 10, 14, 20, 10).getTime();

function plant({ heat = {}, mode = 'mute' } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw: 'off', heat: 'live', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: Object.assign({ stepMin: 10, kickMin: 0, bandDown: 1.5, bandUp: 1 }, heat), dhw: { showerForce: false, minIntervalH: 0 },
        heatCurve: { p23: 38, p24: 4, at: NOW - H }, dhwLastEnd: NOW - 5 * H
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    const pump = { 2: mode, 133: 38, 134: 4 };
    let supply = 36, amp = 3;
    function tick(t) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 15: 0, 101: supply - 5, 102: supply, 103: -2, 104: 60, 108: 47, 112: amp, 115: 69, 116: 596, 125: 36, 132: '1'
            }, pump) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        const call = node.run({ topic: 'tick' }, { now: t });
        for (const m of call.sent) {
            if (m && m[1] && m[1].payload && m[1].payload.operation === 'SET') {
                writes.push({ t, dps: m[1].payload.dps, set: m[1].payload.set });
                pump[m[1].payload.dps] = m[1].payload.set;
            }
        }
    }
    const run = (from, to) => { for (let t = from; t <= to; t += 10 * S) tick(t); };
    const log = () => node.context.get('log') || [];
    return { node, run, writes, pump, log, setSupply: (v) => { supply = v; }, setAmp: (v) => { amp = v; },
        view: () => node.flow.get('dhwView') };
}
const modes = (c) => c.writes.filter((w) => w.dps === 2).map((w) => w.set);

test('P1: lagging supply steps Silent → Smart → Powerful (allowed), one step per stepMin', () => {
    const c = plant({ heat: { allowPowerful: true } });
    c.setSupply(33);
    c.run(NOW, NOW + 11 * MIN);
    assert.deepEqual(modes(c), ['smart']);
    c.run(NOW + 11 * MIN + 10 * S, NOW + 22 * MIN);
    assert.deepEqual(modes(c), ['smart', 'strong']);
});

test('P1: Powerful not allowed → curve +1 °C after Smart, never Powerful', () => {
    const c = plant();
    c.setSupply(33);
    c.run(NOW, NOW + 22 * MIN);
    assert.deepEqual(modes(c), ['smart']);
    assert.ok(c.writes.some((w) => w.dps === 133 || w.dps === 134), JSON.stringify(c.writes));
});

test('P1: pump reverted to Silent after the controller set Smart → step again without the stepMin wait', () => {
    const c = plant({ heat: { stepMin: 30 } });
    c.setSupply(33);
    c.run(NOW, NOW + 11 * MIN);
    assert.deepEqual(modes(c), ['smart']);
    const t0 = c.writes[0].t;
    c.pump[2] = 'mute';   // a cloud scene / the app put Silent back
    c.run(NOW + 11 * MIN + 10 * S, t0 + 13 * MIN);
    // the samples were cleared after the step, so the next decision needs a full 10-min window, but not stepMin from the
    // revert: Smart again at the first full window, before lastStep + stepMin + window
    assert.deepEqual(modes(c), ['smart', 'smart']);
    assert.ok(c.log().some((e) => /pump mode is Silent, the controller set Smart → step again now/.test(e.text)));
});

test('P1: at the boost cap a wanted step up is logged once as blocked, with the reason', () => {
    const c = plant({ heat: { maxBoost: 0 }, mode: 'smart' });
    c.setSupply(33);
    c.run(NOW, NOW + 40 * MIN);
    const blocked = c.log().filter((e) => /^step up blocked:/.test(e.text));
    assert.equal(blocked.length, 1, JSON.stringify(blocked));
    assert.match(blocked[0].text, /Powerful not allowed/);
    assert.match(blocked[0].text, /boost cap \+0/);
});

test('P1: high current in Silent blocks the step up and says so (no silent stuck)', () => {
    const c = plant();
    c.setSupply(33); c.setAmp(9.5);
    c.run(NOW, NOW + 25 * MIN);
    assert.deepEqual(c.writes, []);
    assert.ok(c.log().some((e) => /step up blocked: current 9\.5 A/.test(e.text)));
    assert.match(c.view().heat.blocked, /current 9\.5 A/);
});

test('P2: supply below band down + 1 for offCurveMin → one warning, status line and daily count', () => {
    const c = plant({ heat: { maxBoost: 0, offCurveMin: 30 }, mode: 'smart' });
    c.setSupply(33);   // 3 °C below the point: below −(1.5 + 1)
    c.run(NOW, NOW + 60 * MIN);
    const warn = c.log().filter((e) => /^not following the curve/.test(e.text));
    assert.equal(warn.length, 1);
    assert.match(warn[0].text, /point 36 °C, supply 33 °C/);
    const v = c.view();
    assert.equal(v.heat.offCurve.warned, true);
    assert.equal(v.heat.offCurve.today, 1);
    assert.match(v.status.text, /NOT following the curve since/);
    c.setSupply(36);
    c.run(NOW + 60 * MIN + 10 * S, NOW + 75 * MIN);
    assert.ok(c.log().some((e) => /following the curve again/.test(e.text)));
    assert.equal(c.view().heat.offCurve.warned, false);
});

test('P2: inside the band, or below it only briefly, gives no warning', () => {
    const c = plant({ heat: { offCurveMin: 45 } });
    c.setSupply(35);   // −1 °C: inside the band
    c.run(NOW, NOW + 70 * MIN);
    assert.equal(c.log().filter((e) => /not following the curve/.test(e.text)).length, 0);
    assert.equal(c.view().heat.offCurve.today, 0);
});

test('P2: the limits are saved from the page and range-checked', () => {
    const c = plant();
    c.node.run({ topic: 'ui', payload: { action: 'heatSet', cfg: { offCurveC: 2, offCurveMin: 60 } } }, { now: NOW });
    assert.equal(c.node.context.get('settings').heat.offCurveC, 2);
    assert.equal(c.node.context.get('settings').heat.offCurveMin, 60);
    c.node.run({ topic: 'ui', payload: { action: 'heatSet', cfg: { offCurveC: 9, offCurveMin: 1 } } }, { now: NOW });
    assert.equal(c.node.context.get('settings').heat.offCurveC, 2);
    assert.equal(c.node.context.get('settings').heat.offCurveMin, 60);
});
