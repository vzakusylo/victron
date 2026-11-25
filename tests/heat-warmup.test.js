'use strict';
// P3: "Warm up the house" raises the followed heating point by deltaC for a while, then the owner's curve comes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const NOW = new Date(2026, 10, 14, 20, 10).getTime();
const GX_HEAT = { lagUp: 1, overC: 0, gapMax: 3, stepMin: 12, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 1, kickSec: 60 };

function heating({ heatMode = 'live', master = true, saved = {}, pump0 = {} } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify(Object.assign({
        master, modes: { dhw: 'off', heat: heatMode, df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: GX_HEAT, dhw: { showerForce: false }, heatCurve: { p23: 38, p24: 4, at: NOW - H }, dhwLastEnd: NOW - 5 * H
    }, saved)) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    const pump = Object.assign({ 133: 38, 134: 4 }, pump0);
    function tick(t, over = {}) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 31, 102: 36, 103: -2, 104: 60, 108: 47, 112: 3, 115: 69, 116: 596,
                125: 36, 132: '1'
            }, pump, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        const call = node.run({ topic: 'tick' }, { now: t });
        for (const timer of call.timers) if (timer.ms === 1500) timer.cb();
        for (const m of call.sent) {
            if (m && m[1] && m[1].payload && m[1].payload.operation === 'SET') {
                writes.push({ t, dps: m[1].payload.dps, set: m[1].payload.set });
                pump[m[1].payload.dps] = m[1].payload.set;   // the pump accepts the write
            }
        }
        return call;
    }
    const ui = (payload, t = NOW) => node.run({ topic: 'ui', payload: Object.assign({ action: 'heatWarm' }, payload) }, { now: t });
    const run = (from, to, step = 10 * S) => { for (let t = from; t <= to; t += step) tick(t); };
    const view = () => node.flow.get('dhwView').heat;
    const settings = () => node.context.get('settings');
    return { node, tick, ui, run, view, settings, writes, pump };
}

test('warm-up raises the followed point and writes a raised curve at once', () => {
    const c = heating();
    c.run(NOW, NOW + 5 * MIN);
    assert.deepEqual(c.writes, [], 'on the curve: nothing written');
    c.ui({ on: true, deltaC: 2, hours: 1 }, NOW + 5 * MIN);
    c.run(NOW + 5 * MIN, NOW + 7 * MIN);
    assert.equal(c.view().target, 36.8, 'owner point 36 + available P23 headroom');
    assert.ok(c.writes.length > 0, 'raised curve written without waiting for a 10-min step');
    assert.ok(c.pump[133] > 38 || c.pump[134] > 4, 'pump curve above the owner curve');
    assert.equal(c.view().warm.active, true);
    assert.deepEqual(c.settings().heatCurve, { p23: 38, p24: 4, at: NOW - H }, 'raised curve is never stored as the owner curve');
});

test('warm-up ends by itself and the owner curve is written back', () => {
    const c = heating();
    c.ui({ on: true, deltaC: 2, hours: 0.5 });
    c.run(NOW, NOW + 3 * MIN);
    c.writes.length = 0;
    c.run(NOW + 31 * MIN, NOW + 36 * MIN);   // writes are paced: one confirmed write at a time
    assert.equal(c.settings().heatWarm, null);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
    assert.equal(c.view().warm.active, false);
    assert.equal(c.view().target, 36);
});

test('cancel writes the owner curve back on the next tick', () => {
    const c = heating();
    c.ui({ on: true, deltaC: 3, hours: 2 });
    c.run(NOW, NOW + 2 * MIN);
    c.ui({ on: false }, NOW + 2 * MIN);
    c.run(NOW + 2 * MIN + 10 * S, NOW + 7 * MIN);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
});

test('controller Off during a warm-up puts the owner curve back', () => {
    const c = heating();
    c.ui({ on: true, deltaC: 2, hours: 1 });
    c.run(NOW, NOW + 2 * MIN);
    c.node.run({ topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'off' } }, { now: NOW + 2 * MIN });
    c.run(NOW + 2 * MIN + 10 * S, NOW + 7 * MIN);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
});

test('warm-up in Test mode or with local control OFF explains the mode before the curve limit', () => {
    for (const opt of [{ heatMode: 'dry' }, { master: false }]) {
        const c = heating(opt);
        c.ui({ on: true, deltaC: 2, hours: 1 });
        c.run(NOW, NOW + 3 * MIN);
        assert.deepEqual(c.writes, [], JSON.stringify(opt));
        assert.equal(c.view().warm.note, 'warm-up needs the heating controller On and local control ON', JSON.stringify(opt));
    }
});

test('a running warm-up survives a restart; malformed ones are dropped', () => {
    const kept = heating({ saved: { heatWarm: { at: NOW - 10 * MIN, until: NOW + 50 * MIN, deltaC: 2 } } });
    kept.run(NOW, NOW + 2 * MIN);
    assert.equal(kept.view().target, 36.8);
    assert.ok(kept.writes.length > 0);
    for (const bad of [{ at: NOW, until: NOW + H, deltaC: 9 }, { at: NOW, until: NOW - 1, deltaC: 2 }, { at: NOW, until: NOW + 7 * H, deltaC: 2 }, { at: 'x' }]) {
        const c = heating({ saved: { heatWarm: bad } });
        assert.equal(c.settings().heatWarm, null, JSON.stringify(bad));
    }
});

test('out-of-range requests are refused', () => {
    const c = heating();
    for (const p of [{ on: true, deltaC: 0 }, { on: true, deltaC: 6 }, { on: true, hours: 0.1 }, { on: true, hours: 7 }, { on: 'yes' }]) {
        assert.equal(c.ui(p).result, null, JSON.stringify(p));
        assert.equal(c.settings().heatWarm || null, null);
    }
});

// boost the curve by 1 on top of a warm-up (supply well below the point), then let supply rise well above it: one step down to 0
function boostThenStepDown() {
    const c = heating({ saved: { heatCurve: { p23: 30, p24: 4, at: NOW - H } }, pump0: { 133: 30, 134: 4, 125: 33 } });
    c.ui({ on: true, deltaC: 2, hours: 2 });
    c.run(NOW, NOW + 3 * MIN);
    const warm = { p23: c.pump[133], p24: c.pump[134] };
    assert.notDeepEqual(warm, { p23: 30, p24: 4 }, 'warm-up curve written');
    let t = NOW + 3 * MIN;
    while (c.node.context.get('heat').boost < 1 && t < NOW + 40 * MIN) { t += 10 * S; c.tick(t, { 2: 'smart', 102: 25, 101: 23 }); }
    assert.equal(c.node.context.get('heat').boost, 1, 'boosted by 1 on top of the warm-up');
    assert.notDeepEqual({ p23: c.pump[133], p24: c.pump[134] }, warm, 'boost curve written');
    let stepAt = null, text = '';
    const boostAt = c.node.context.get('heat').lastStep;
    while (stepAt === null && t < NOW + 80 * MIN) {
        t += 10 * S; c.tick(t, { 2: 'smart', 102: 42, 101: 39 });
        const h = c.node.context.get('heat');
        if (h.lastStep !== boostAt) { stepAt = t; text = h.why; }
    }
    assert.ok(stepAt, 'the boost stepped down to 0');
    return { c, warm, stepAt, text };
}

test('a boost step-down during a warm-up keeps the warm-up curve bookkept (PR #65 review)', () => {
    const { c, warm, stepAt } = boostThenStepDown();
    const after = c.node.context.get('heat');
    assert.equal(after.boost, 0);
    assert.equal(after.warmApplied, 2, 'warm-up still counted as written');
    assert.deepEqual(after.curveCmd, warm, 'curveCmd keeps the warm-up curve (owner + warm-up), not null');
    assert.deepEqual(c.settings().heatCurve, { p23: 30, p24: 4, at: NOW - H });
    // 2+ min after the step the bookkeeping is re-checked: it must not restart the warm-up (no new write, samples kept)
    const writes = c.writes.length;
    for (let t = stepAt + 10 * S; t <= stepAt + 5 * MIN; t += 10 * S) {
        c.tick(t, { 2: 'smart', 102: 42, 101: 39 });
        assert.equal(c.node.context.get('heat').warmApplied, 2);
    }
    assert.deepEqual({ p23: c.pump[133], p24: c.pump[134] }, warm);
    assert.equal(c.writes.length, writes, 'no second warm-up write');
    assert.ok(c.node.context.get('heat').samples.length >= 15, 'samples collected, not cleared by a restarted warm-up');
});

test('boost step-down log names the warm-up curve, not "yours" (PR #65 review)', () => {
    const { text } = boostThenStepDown();
    assert.match(text, /curve back to warm-up \+2 °C \(P23 \d+ \/ P24 \d+\)/);
    assert.doesNotMatch(text, /curve back to yours/);
});

test('warm-up and band consume the total budget before boost without rounding above the cap', () => {
    const c = heating({ saved: { heat: { ...GX_HEAT, lagUp: undefined, overC: undefined, band: true, bandUp: 2, bandDown: 0 },
        heatCurve: { p23: 26, p24: 6, at: NOW - H } }, pump0: { 121: 2, 133: 26, 134: 6 } });
    c.ui({ on: true, deltaC: 2, hours: 2 });
    for (let t = NOW; t <= NOW + 45 * MIN; t += 10 * S) {
        c.tick(t, { 2: 'smart', 102: 19, 101: 17 });
    }
    assert.equal(c.node.context.get('heat').boost, 0);
    assert.equal(c.node.context.get('heat').warmApplied, 3.6);
    assert.deepEqual(c.writes.filter(w => [133, 134].includes(w.dps)).map(w => [w.dps, w.set]), [[133, 32]]);
    assert.equal(c.settings().heatCurve.p23, 26);
});

test('on restart the controller accounts for the live offset before adding a boost', () => {
    const c = heating({ saved: { heat: { maxCurveOffset: 4, maxBoost: 4, kickMin: 0 },
        heatCurve: { p23: 26, p24: 6 }, dhwBlock: { at: NOW - H, why: 'Er03' } },
    pump0: { 133: 32, 134: 6 } });
    for (let t = NOW; t <= NOW + 45 * MIN; t += 10 * S) {
        c.tick(t, { 2: 'smart', 102: 22, 101: 19, 103: -9 });
    }
    assert.equal(c.node.context.get('heat').boost, 3.6);
    assert.deepEqual(c.writes, [], 'no stacked boost or slipped higher slope');
});

test('a warm-up that expired while stopped is removed rather than reclassified as boost', () => {
    const c = heating({ saved: { heatCurve: { p23: 26, p24: 6 },
        heatWarm: { at: NOW - 2 * H, until: NOW - H, deltaC: 3 } }, pump0: { 133: 31, 134: 6 } });
    c.run(NOW, NOW + MIN);
    assert.equal(c.node.context.get('heat').boost, 0);
    assert.deepEqual(c.writes.filter(w => [133, 134].includes(w.dps)).map(w => [w.dps, w.set]), [[133, 26]]);
});

test('restart lowers a legacy steepened curve but heating never raises a lower reported P24', () => {
    for (const [slope, expected] of [[7, [[134, 6], [133, 32]]], [5, [[133, 32]]]]) {
        const c = heating({ saved: { heatCurve: { p23: 26, p24: 6 } }, pump0: { 133: 40, 134: slope } });
        c.run(NOW, NOW + 5 * MIN);
        assert.deepEqual(c.writes.filter(w => [133, 134].includes(w.dps)).map(w => [w.dps, w.set]), expected);
    }
});

test('a DHW cycle that ended during a warm-up: the warm-up curve is written only after the hold clears', () => {
    const c = heating({ saved: { dhwLastEnd: NOW - 2 * MIN } });   // hold: "DHW cycle ended < 10 min ago" until NOW + 8 min
    c.ui({ on: true, deltaC: 2, hours: 2 });
    c.run(NOW, NOW + 7 * MIN);
    assert.deepEqual(c.writes, [], 'nothing written while the DHW hold is active');
    assert.match(c.view().why, /DHW cycle ended/);
    c.run(NOW + 8 * MIN + 10 * S, NOW + 10 * MIN);
    assert.ok(c.writes.length > 0, 'warm-up curve written once the hold clears');
    assert.ok(c.pump[133] > 38 || c.pump[134] > 4);
});

test('switching On → Test during a warm-up puts the owner curve back (PR #65 review)', () => {
    const c = heating();
    c.ui({ on: true, deltaC: 2, hours: 1 });
    c.run(NOW, NOW + 3 * MIN);
    c.node.run({ topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'dry' } }, { now: NOW + 3 * MIN });
    c.run(NOW + 3 * MIN + 10 * S, NOW + 8 * MIN);
    assert.equal(c.pump[133], 38);
    assert.equal(c.pump[134], 4);
});

test('a warm-up without a stored curve says why it waits (PR #65 review)', () => {
    const c = heating({ saved: { heatCurve: null } });
    c.ui({ on: true, deltaC: 2, hours: 1 });
    c.run(NOW, NOW + MIN);
    assert.match(c.view().warm.note, /warm-up waits/);
    assert.deepEqual(c.writes.filter(w => w.dps === 133 || w.dps === 134), []);
});
