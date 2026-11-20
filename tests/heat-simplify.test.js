'use strict';
// d#201: one band around the curve point (Silent ⇄ Smart ⇄ curve boost), DHW gap after a finished cycle,
// DHW start after a defrost, and the one status line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const NOW = new Date(2026, 10, 14, 20, 10).getTime();

function plant({ heat = {}, dhw = {}, dhwMode = 'off', extra = {}, mode = 'mute' } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify(Object.assign({
        master: true, modes: { dhw: dhwMode, heat: 'live', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: Object.assign({ stepMin: 10, kickMin: 0 }, heat), dhw: Object.assign({ showerForce: false, minIntervalH: 0 }, dhw),
        heatCurve: { p23: 38, p24: 4, at: NOW - H }, dhwLastEnd: NOW - 5 * H
    }, extra)) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    const pump = { 2: mode, 133: 38, 134: 4 };
    let supply = 36, tank = 47;
    function tick(t, over = {}) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 15: 0, 101: supply - 5, 102: supply, 103: -2, 104: 60, 108: tank, 112: 3, 115: 69, 116: 596, 125: 36, 132: '1'
            }, pump, over) },
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
    const run = (from, to, over) => { for (let t = from; t <= to; t += 10 * S) tick(t, over); };
    return { node, tick, run, writes, pump, setSupply: (v) => { supply = v; }, setTank: (v) => { tank = v; },
        view: () => node.flow.get('dhwView'), logs: () => node.sent ? node.sent : [] };
}

test('heating band: below the lower limit Silent → Smart, at the point back to Silent', () => {
    const c = plant({ heat: { bandDown: 1.5, bandUp: 1 } });
    c.setSupply(34);   // 2 °C below the point 36
    c.run(NOW, NOW + 11 * MIN);
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'smart']]);
    c.setSupply(36.6);   // back to Silent only from lag ≥ up / 2 = 0.5
    c.run(NOW + 11 * MIN + 10 * S, NOW + 25 * MIN);
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'smart'], [2, 'mute']]);
});

test('heating band: inside the band nothing is written, also in Smart with the supply below the point', () => {
    const c = plant({ heat: { bandDown: 1.5, bandUp: 1 }, mode: 'smart' });
    c.setSupply(35);   // −1 °C: inside; Smart stays until the supply is at the point
    c.run(NOW, NOW + 25 * MIN);
    assert.deepEqual(c.writes, []);
});

test('heating band: above the upper limit the boost comes down first, then the mode', () => {
    const c = plant({ heat: { bandDown: 1.5, bandUp: 1 }, mode: 'smart' });
    c.setSupply(38);   // +2 °C above the point 36
    c.run(NOW, NOW + 11 * MIN);
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'mute']]);
});

test('heating band: below the lower limit in Smart the curve goes up by 1 °C steps', () => {
    const c = plant({ heat: { bandDown: 1, bandUp: 1 }, mode: 'smart' });
    c.setSupply(33);
    c.run(NOW, NOW + 11 * MIN);
    assert.ok(c.writes.length > 0 && c.writes.every((w) => [133, 134].includes(w.dps)), JSON.stringify(c.writes));
    assert.equal(c.node.context.get('heat').boost, 1);
});

test('old saved lagUp / overC become the band limits, also when the old band was on', () => {
    const a = plant({ heat: { lagUp: 2.3, overC: 0.6, gapMax: 4 } });
    const ca = a.node.context.get('settings').heat;
    assert.equal(ca.bandDown, 2.5);
    assert.equal(ca.bandUp, 0.5);
    assert.equal('lagUp' in ca || 'overC' in ca || 'gapMax' in ca, false);
    const b = plant({ heat: { band: true, bandDown: 0, bandUp: 2, lagUp: 1.5, overC: 1 } });
    const cb = b.node.context.get('settings').heat;
    assert.equal(cb.band, true);
    assert.equal(cb.bandDown, 1.5);
    assert.equal(cb.bandUp, 1);
    assert.ok(b.node.context.get('log').some((e) => /heating settings migrated: lagUp 1.5 → band down 1.5, overC 1 → band up 1/.test(e.text)));
    b.run(NOW, NOW + 6 * MIN, { 121: 5 });
    assert.deepEqual([...new Set(b.writes.filter((w) => w.dps === 121).map((w) => w.set))], [2.5], 'DP 121 = max(2, up + down) of the migrated band');
});

test('Silent ⇄ Smart does not hunt: back to Silent only at lag ≥ up / 2', () => {
    const c = plant({ heat: { bandDown: 1.5, bandUp: 1, stepMin: 10 } });
    // Silent sits 2 °C below the point, Smart 0.4 °C above it (inside the band, below up / 2)
    for (let t = NOW; t <= NOW + 3 * H; t += 10 * S) {
        c.setSupply(c.pump[2] === 'smart' ? 36.4 : 34);
        c.tick(t);
    }
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'smart']]);
    // above up / 2 it goes back
    for (let t = NOW + 3 * H + 10 * S; t <= NOW + 3 * H + 25 * MIN; t += 10 * S) { c.setSupply(36.6); c.tick(t); }
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'smart'], [2, 'mute']]);
});

test('DHW waits while the last cycle ended less than minGapH ago and logs why; Force run overrides it', () => {
    const c = plant({ dhwMode: 'live', dhw: { minGapH: 1 }, extra: { dhwLastDone: NOW - 30 * MIN } });
    c.setTank(25);
    c.run(NOW, NOW + 40 * S);
    assert.equal(c.node.context.get('dhw').state, 'HEATING');
    assert.match(c.node.context.get('dhw').why, /waits: last cycle ended \d\d:\d\d, gap 1 h/);
    assert.ok(c.writes.every((w) => w.dps !== 133 || w.set !== 0));

    const f = plant({ dhwMode: 'live', dhw: { minGapH: 1 }, extra: { dhwLastDone: NOW - 30 * MIN, dhwManual: { at: NOW, until: NOW + 3 * H } } });
    f.setTank(25);
    f.run(NOW, NOW + 40 * S);
    assert.equal(f.node.context.get('dhw').state, 'STOP');
});

test('DHW starts when the gap has passed', () => {
    const c = plant({ dhwMode: 'live', dhw: { minGapH: 1 }, extra: { dhwLastDone: NOW - 90 * MIN } });
    c.setTank(25);
    c.run(NOW, NOW + 40 * S);
    assert.equal(c.node.context.get('dhw').state, 'STOP');
});

test('start DHW after defrost: option on, tank below target → starts at once, gap and option are respected', () => {
    const afterDefrost = (opts, doneAgo) => {
        const c = plant({ dhwMode: 'live', dhw: Object.assign({ minGapH: 1, afterDefrost: false, hyst: 3 }, opts),
            extra: doneAgo ? { dhwLastDone: NOW - doneAgo } : {} });
        c.setTank(45);   // target ≈ 46.5 at −2 °C: below target but inside the hysteresis
        c.run(NOW, NOW + 40 * S);
        assert.equal(c.node.context.get('dhw').state, 'HEATING', 'no start without a defrost');
        c.node.context.set('afterDefrostAt', NOW + 50 * S);
        c.run(NOW + 50 * S, NOW + 90 * S);
        return c.node.context.get('dhw').state;
    };
    assert.equal(afterDefrost({ startAfterDefrost: true }), 'STOP');
    assert.equal(afterDefrost({ startAfterDefrost: false }), 'HEATING');
    assert.equal(afterDefrost({ startAfterDefrost: true }, 20 * MIN), 'HEATING', 'the gap still applies');
});

test('start DHW after defrost needs the shower deficit and keeps heating first in the cold', () => {
    const start = (tank, extra) => {
        const c = plant({ dhwMode: 'live', dhw: Object.assign({ minGapH: 1, afterDefrost: false, hyst: 3, startAfterDefrost: true }, extra || {}) });
        c.setTank(tank);
        c.run(NOW, NOW + 40 * S);
        c.node.context.set('afterDefrostAt', NOW + 50 * S);
        c.run(NOW + 50 * S, NOW + 90 * S);
        return c.node.context.get('dhw');
    };
    assert.equal(start(46.5).state, 'STOP', 'deficit 1.5 °C ≥ 1 °C (target 48 at −2 °C, hysteresis 3)');
    const small = start(47.5);
    assert.equal(small.state, 'HEATING', 'deficit 0.5 °C < 1 °C');
    assert.match(small.why, /tank 47.5 °C ≥ 45 /);
    const cold = start(46.5, { coldLimit: 0 });
    assert.equal(cold.state, 'STOP', 'no lag measured: not blocked');
    const lagging = plant({ dhwMode: 'live', dhw: { minGapH: 1, afterDefrost: false, hyst: 3, startAfterDefrost: true, coldLimit: 0 } });
    lagging.setTank(46.5);
    lagging.run(NOW, NOW + 40 * S);
    const dd = lagging.node.context.get('dhw');
    dd.lagS = Array.from({ length: 30 }, (_, i) => [NOW + 40 * S - (30 - i) * MIN, -4]);   // heating lags 4 °C for 30 min (lagC default 2)
    lagging.node.context.set('afterDefrostAt', NOW + 50 * S);
    lagging.run(NOW + 50 * S, NOW + 90 * S);
    assert.equal(lagging.node.context.get('dhw').state, 'HEATING');
    assert.match(lagging.node.context.get('dhw').why, /heating lags -3\.\d °C below its curve .*\(heating first\)/);
});

test('DHW after a real defrost starts ≥ 15 min after it and logs that', () => {
    const c = plant({ dhwMode: 'live', dhw: { minGapH: 1, afterDefrost: false, hyst: 3, startAfterDefrost: true } });
    c.setTank(45);
    c.node.context.set('lastDefrost', 0);
    c.run(NOW, NOW + 20 * S);
    for (let t = NOW + 30 * S; t <= NOW + 60 * S; t += 10 * S) c.tick(t, { 115: 69, 116: 0 });   // the defrost
    const endAt = NOW + 70 * S;
    let startedAt = null;
    for (let t = endAt; t <= endAt + 30 * MIN && startedAt === null; t += 10 * S) {
        c.tick(t);
        if (c.node.context.get('dhw').state === 'STOP') startedAt = t;
    }
    assert.ok(startedAt !== null, 'cycle started');
    assert.ok(startedAt - (NOW + 60 * S) >= 15 * MIN, 'not before the 15 min quiet time: ' + (startedAt - NOW) / MIN);
    assert.ok(c.node.context.get('log').some((e) => /start DHW after defrost \(starts ≥ 15 min after it/.test(e.text)));
});

test('a defrost flag that ends by "DF safe 10min" does not arm the DHW start; the defrost end does, once', () => {
    const c = plant({ dhwMode: 'live', dhw: { startAfterDefrost: true } });
    c.node.context.set('flag', { on: true, since: NOW, by: 'test' });
    c.run(NOW, NOW + 11 * MIN);
    assert.equal(c.node.context.get('flag').on, false);
    assert.ok(c.node.context.get('log').some((e) => /DF safe 10min/.test(e.text)));
    assert.ok(!c.node.context.get('afterDefrostAt'), 'no arm from the flag timeout');
});

test('the defrost end arms the start only while the DHW controller is in heating', () => {
    const c = plant({ dhwMode: 'live', dhw: { startAfterDefrost: true } });
    c.run(NOW, NOW + 20 * S);
    c.tick(NOW + 30 * S, { 115: 69, 116: 0 });   // defrost
    assert.match(c.view().status.text, /^Defrost/);
    c.tick(NOW + 40 * S, { 115: 69, 116: 596 });   // defrost over
    assert.ok(c.node.context.get('afterDefrostAt') > 0);
});

test('status line: heating, idle with the reason, DHW', () => {
    const c = plant({ dhwMode: 'live' });
    c.run(NOW, NOW + 20 * S);
    assert.equal(c.view().status.kind, 'heating');
    assert.match(c.view().status.text, /^Heating \(Silent, point 36 °C, supply 36 °C, band −1.5\/\+1 °C, boost \+0 °C\)$/);
    c.tick(NOW + 30 * S, { 1: false });
    assert.match(c.view().status.text, /^Idle: heat pump off/);
    const i = plant({ dhwMode: 'live' });
    i.tick(NOW, { 115: 0 });
    assert.equal(i.view().status.kind, 'idle');
    const d = plant({ dhwMode: 'live' });
    d.setTank(25);
    d.run(NOW, NOW + 40 * S);
    assert.equal(d.view().status.kind, 'dhw');
    assert.match(d.view().status.text, /^DHW heating \(tank 25 → [\d.]+ °C, since \d\d:\d\d\)$/);
});
