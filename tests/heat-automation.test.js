'use strict';
// The checks made on the GX after the d#180 deploy of 14 Nov 2026 for the heating power controller, as tests:
// - with the settings of the GX and the supply on the owner's curve it stays in Silent and writes nothing
// - a redeployed node first collects a full 10-min window, then makes one step
// - the stuck-supply kick with the saved kickMin 1 / kickSec 60: Smart for a minute, at most every 2 min
// - it holds during a DHW cycle and 10 min after it, and starts its window again afterwards
// - a DHW cycle aborted by Er03 puts the owner's heating curve back
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S;
const NOW = new Date(2026, 10, 14, 20, 10).getTime();
// Settings read from the GX on 14 Nov 20:10 (heat controller On, owner's curve P23 38 / P24 4).
const GX_HEAT = { lagUp: 1, overC: 0, gapMax: 3, stepMin: 12, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 1, kickSec: 60 };

function heating({ dhw = 'off', dhwLastEnd = NOW - 5 * 3600000, cfg = GX_HEAT, modes = {},
    heatCurve = { p23: 38, p24: 4, at: NOW - 3600000 } } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    const load = node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: Object.assign({ dhw, heat: 'live', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' }, modes),
        heat: cfg, dhw: { showerForce: false }, heatCurve, dhwLastEnd
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    function tick(t, over = {}, valve = false, bypass = false) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 31, 102: 36, 103: -2, 104: 60, 108: 47, 112: 3, 115: 69, 116: 596,
                125: 36, 132: '1', 133: 38, 134: 4
            }, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: valve } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: bypass } }
        });
        const call = node.run({ topic: 'tick' }, { now: t });
        for (const m of call.sent) {
            for (const [port, device] of [[1, 'pump'], [3, 'bypass'], [4, 'valve']]) {
                if (m && m[port] && m[port].payload && m[port].payload.operation === 'SET') {
                    writes.push({ t, device, dps: m[port].payload.dps, set: m[port].payload.set });
                }
            }
        }
        return call;
    }
    const heat = () => node.context.get('heat');
    return { node, load, tick, heat, writes };
}

test('heating controller with the GX settings keeps Silent and writes nothing while the supply is on the curve', () => {
    const c = heating();
    for (let i = 0; i <= 90; i++) c.tick(NOW + i * 10 * S);
    assert.deepEqual(c.writes, []);
    const view = c.node.flow.get('dhwView').heat;
    assert.equal(view.mode, 'live');
    assert.equal(view.target, 36, 'owner curve P23 38 / P24 4 at the outdoor average of -2 °C');
    assert.equal(view.lag, 0);
    assert.equal(view.pumpMode, 'Silent');
    assert.equal(view.boost, 0);
    assert.deepEqual(view.cfg, { bandDown: 1, bandUp: 0, stepMin: 12, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 1, kickSec: 60, offCurveC: 1, offCurveMin: 45, band: false },
        'saved lagUp / overC become the band limits; gapMax is gone; the P6 pump band ships off');
});

test('a redeployed heating controller collects a full window before its first and only step', () => {
    // kick off (kickMin 0), so only the controller itself can write
    const c = heating({ cfg: Object.assign({}, GX_HEAT, { kickMin: 0 }) });
    let mode = 'mute';
    // supply 3 °C below the curve from the first tick: below the band (−1)
    for (let i = 0; i <= 70; i++) {
        c.tick(NOW + i * 10 * S, { 102: 33, 101: 31, 2: mode });
        if (c.writes.length) mode = c.writes[c.writes.length - 1].set;   // the pump follows the command
    }
    assert.deepEqual(c.writes.map((w) => [w.dps, w.set]), [[2, 'smart']]);
    assert.ok(c.writes[0].t - NOW >= 9 * MIN, 'no step before 9 min of samples');
    assert.ok(c.heat().samples.length < 20, 'the window starts again after a step');
});

test('with the GX kick settings a supply stuck below the curve gets Smart for about a minute, at most every 2 min', () => {
    // kickMin 1 / kickSec 60 as saved on the GX; supply flat 3 °C below the curve, inside a wide band (no step)
    const c = heating({ cfg: Object.assign({}, GX_HEAT, { lagUp: undefined, bandDown: 5 }) });
    let mode = 'mute';
    for (let i = 0; i <= 72; i++) {
        c.tick(NOW + i * 10 * S, { 102: 33, 101: 30, 2: mode });
        if (c.writes.length) mode = c.writes[c.writes.length - 1].set;
    }
    assert.ok(c.writes.every((w) => w.dps === 2), 'only the pump mode is written, never the curve');
    const smart = c.writes.filter((w) => w.set === 'smart'), mute = c.writes.filter((w) => w.set === 'mute');
    assert.ok(smart.length >= 2 && smart.length <= 6, 'kicks: ' + smart.length);
    for (let i = 1; i < smart.length; i++) assert.ok(smart[i].t - smart[i - 1].t >= 2 * MIN, 'at most one kick per 2 x kickMin');
    for (const k of smart.slice(0, mute.length)) {
        const back = mute.find((w) => w.t > k.t);
        assert.ok(back && back.t - k.t >= 60 * S && back.t - k.t <= 90 * S, 'Silent again after kickSec');
    }
    assert.equal(mode === 'mute' || c.node.context.get('kick').phase === 'smart', true, 'never left in Smart outside a kick');
});

test('expected_fail TH3: a running DHW cycle should not qualify for a stuck-supply kick', t => {
    const c = heating({ dhw: 'live', cfg: { bandDown: 5, kickMin: 1, kickSec: 60 } });
    for (let i = 0; i < 30; i++) c.tick(NOW + i * 10 * S, { 108: 49 });

    const at = NOW + 5 * MIN;
    const d = c.node.context.get('dhw');
    Object.assign(d, { state: 'DHW', since: at - 30 * S, startAt: at - 3 * MIN, startTank: 44,
        run: (at - 3 * MIN) + ':dhw', live: true, pumpLatch: -2,
        p23Cmd: 22, p24Cmd: 12, goal: 25, p24Goal: 12, tickAt: at - 30 * S });
    c.node.context.set('dhw', d);
    for (let i = 0; i <= 6; i++) {
        c.tick(at + i * 10 * S, { 108: 44, 133: 22, 134: 12, 102: 45, 101: 41 }, true);
        assert.equal(c.node.context.get('dhw').state, 'DHW');
    }

    const kick = c.node.context.get('kick');
    assert.equal(kick.phase, 'smart', 'unexpected pass: remove expected_fail after fixing TH3');
    assert.ok(c.writes.some(w => w.t === kick.at && w.device === 'pump' && String(w.dps) === '2' && w.set === 'smart'),
        'the undesired kick must reach the pump output');
    t.skip('expected_fail TH3: kickTick accepts a running DHW cycle and kicks against the boiler curve');
});

test('heating controller holds during a DHW cycle and for 10 min after it', () => {
    const c = heating({ dhw: 'live' });
    for (let i = 0; i < 30; i++) c.tick(NOW + i * 10 * S, { 108: 49 });   // tank warm: no DHW start
    assert.ok(c.heat().samples.length > 20);

    // a running cycle: valve on the tank, boiler curve set
    const at = NOW + 5 * MIN;
    const d = c.node.context.get('dhw');
    Object.assign(d, { state: 'DHW', since: at - 30 * S, startAt: at - 3 * MIN, startTank: 44, run: (at - 3 * MIN) + ':dhw', live: true,
        p23Cmd: 22, p24Cmd: 12, goal: 25, p24Goal: 12, tickAt: at - 30 * S });
    c.node.context.set('dhw', d);
    c.tick(at, { 108: 44, 133: 22, 134: 12, 102: 45, 101: 41 }, true);
    assert.equal(c.node.context.get('dhw').state, 'DHW');
    assert.match(c.heat().why, /^waiting: DHW cycle running/);
    assert.deepEqual(c.heat().samples, [], 'samples from before the cycle are dropped');

    // the cycle is over: valve on heating, owner's curve back
    const end = NOW + 8 * MIN;
    const e = c.node.context.get('dhw');
    Object.assign(e, { state: 'HEATING', run: null, lastEnd: end });
    c.node.context.set('dhw', e);
    c.tick(NOW + 12 * MIN, { 108: 49 });
    assert.match(c.heat().why, /DHW cycle ended < 10 min ago/);
    c.tick(NOW + 19 * MIN, { 108: 49 });
    assert.doesNotMatch(c.heat().why, /^waiting/);
    assert.ok(c.writes.every((w) => w.dps !== 2), 'the heating controller made no mode step meanwhile');
});

test('DHW controller starts a cycle after three fresh tank-demand ticks', () => {
    const c = heating({ dhw: 'live' });
    for (let i = 0; i < 3; i++) c.tick(NOW + i * 10 * S, { 108: 25 });
    assert.equal(c.node.context.get('dhw').state, 'STOP');
    assert.ok(c.writes.some(w => w.device === 'pump' && String(w.dps) === '133' && w.set === 0),
        'the pump curve is set to P23 0 before the valve moves');
});

test('DHW demand waits out the 15-minute quiet period after deploy', () => {
    const c = heating({ dhw: 'live' });
    c.node.context.set('lastDefrost', NOW);
    for (let i = 0; i < 3; i++) c.tick(NOW + i * 10 * S, { 108: 25 });
    assert.equal(c.node.context.get('dhw').state, 'HEATING');
    assert.deepEqual(c.writes, []);

    for (let i = 0; i < 3; i++) c.tick(NOW + 16 * MIN + i * 10 * S, { 108: 25 });
    assert.equal(c.node.context.get('dhw').state, 'STOP');
    assert.ok(c.writes.some(w => w.device === 'pump' && String(w.dps) === '133' && w.set === 0));
});

test('a DHW cycle aborted by Er03 writes the owner heating curve back and the heating controller resumes', () => {
    const c = heating({ dhw: 'live' });
    const d = c.node.context.get('dhw');
    Object.assign(d, { state: 'DHW', since: NOW - 30 * S, startAt: NOW - 3 * MIN, startTank: 44, run: (NOW - 3 * MIN) + ':dhw', live: true,
        outAvg: -1.9, outS: [[NOW - MIN, -1.9]], p23Cmd: 22, p24Cmd: 12, goal: 25, p24Goal: 12, tickAt: NOW - 30 * S });
    c.node.context.set('dhw', d);

    // 14 Nov 19:56: Er03, 0 Hz, valve on the tank, boiler curve P23 22 / P24 12
    const fault = { 15: 1, 115: 0, 116: 0, 101: 36, 102: 36, 108: 44, 133: 22, 134: 12 };
    c.tick(NOW, fault, true);
    assert.equal(c.node.context.get('dhw').state, 'HEATING');
    assert.equal(c.node.context.get('settings').dhwBlock.why, 'fault Er03 (water flow)');
    // the three writes leave one by one; keep ticking until the queue is empty
    for (let i = 1; i <= 12 && (c.node.context.get('queue') || []).length; i++) c.tick(NOW + i * 10 * S, fault, true);
    const queued = c.writes.concat((c.node.context.get('queue') || []).map((w) => ({ dps: w.dps, set: w.set })));
    const has = (dps, set) => queued.some((w) => String(w.dps) === String(dps) && w.set === set);
    assert.ok(has(1, false), 'valve back to heating');
    assert.ok(has(134, 4), 'owner P24');
    assert.ok(has(133, 38), 'owner P23');

    // 10 min later, pump back on the owner's curve: the heating controller decides again
    c.tick(NOW + 11 * MIN);
    assert.doesNotMatch(c.heat().why, /^waiting/);
});

function endFaultedDhw(c) {
    const d = c.node.context.get('dhw');
    Object.assign(d, { state: 'DHW', since: NOW - 30 * S, startAt: NOW - 3 * MIN,
        startTank: 44, run: (NOW - 3 * MIN) + ':dhw', live: true,
        outAvg: -2, outS: [[NOW - MIN, -2]], p23Cmd: 22, p24Cmd: 12, tickAt: NOW - 30 * S });
    c.node.context.set('dhw', d);
    c.tick(NOW, { 15: 1, 115: 0, 116: 0, 108: 44, 133: 22, 134: 12 }, true);
    assert.equal(c.node.context.get('dhw').state, 'HEATING', 'must exercise DHW exit');
    return c.writes.filter(w => w.device === 'pump')
        .concat((c.node.context.get('queue') || []).filter(w => w.role === 'hp'))
        .filter(w => [133, 134].includes(Number(w.dps))).map(w => [Number(w.dps), w.set]);
}

test('HP-SETTINGS-1: invalid saved curve must not be restored on DHW fault', () => {
    const c = heating({ dhw: 'live', heatCurve: { p23: 41, p24: 31, at: NOW - MIN } });
    assert.deepEqual(endFaultedDhw(c), []);
});

for (const [param, values] of Object.entries({ p23: [-1, 41, '38'], p24: [0, 31, '4'] })) {
    for (const value of values) {
        test(`invalid saved ${param} ${JSON.stringify(value)} is ignored and logged without device writes`, () => {
            const c = heating({ heatCurve: { p23: 38, p24: 4, [param]: value } });
            assert.equal(c.node.context.get('settings').heatCurve, null);
            assert.ok(c.load.sent.some(m => m[5]?.event?.kind === 'warn' &&
                m[5].event.text === 'stored heating curve invalid (P23 ' +
                JSON.stringify(param === 'p23' ? value : 38) + ' / P24 ' +
                JSON.stringify(param === 'p24' ? value : 4) + ') → ignored, re-captured from the pump'));
            assert.ok(c.load.sent.every(m => !m[1] && !m[3] && !m[4]));
        });
    }
}

test('invalid saved curve is replaced only by in-range live heating values', () => {
    const c = heating({ dhw: 'dry', heatCurve: { p23: -1, p24: 4 } });
    c.tick(NOW, { 133: 41, 134: 4 });
    assert.equal(c.node.context.get('settings').heatCurve, null);
    c.tick(NOW + 10 * S, { 133: 39, 134: 5 }, true);
    assert.equal(c.node.context.get('settings').heatCurve, null, 'valve must be on heating');
    c.tick(NOW + 20 * S, { 133: 39, 134: 5 });
    assert.deepEqual(c.node.context.get('settings').heatCurve, { p23: 39, p24: 5, at: NOW + 20 * S });
    assert.deepEqual(c.writes, []);
});

test('valid saved curves at both ends of the pump ranges are still restored on DHW fault', () => {
    for (const [p23, p24] of [[0, 30], [40, 1]]) {
        const c = heating({ dhw: 'live', heatCurve: { p23, p24 } });
        assert.deepEqual(endFaultedDhw(c), [[134, p24], [133, p23]]);
    }
});

test('pump dispatch refuses out-of-range queued curve commands and still sends a valid one', () => {
    const c = heating({ dhw: 'live' });
    c.node.context.set('queue', [[133, -1], ['134', 31], [133, 0]].map(([dps, set]) =>
        ({ rule: 'dhw', cloud: 'DHW controller', role: 'hp', dps, set })));
    c.node.context.set('pumping', true);
    c.node.context.set('pumpAt', NOW - 5 * MIN); // Resume a queue whose gap timer was lost.
    const call = c.tick(NOW);
    for (let i = 0; i < call.timers.length; i++) call.timers[i].cb();
    assert.deepEqual(call.sent.map(m => m[1]?.payload).filter(Boolean), [{ operation: 'SET', dps: 133, set: 0 }]);
    const warnings = call.sent.map(m => m[5]?.event).filter(e => e?.kind === 'warn').map(e => e.text);
    assert.ok(warnings.some(text => text.includes('DP 133') && text.includes('-1')));
    assert.ok(warnings.some(text => text.includes('DP 134') && text.includes('31')));
    assert.deepEqual(c.node.context.get('queue'), []);
});

test('DHW compressor protection steps the curve down after three sustained minutes', () => {
    const c = heating({ dhw: 'live' });
    const d = c.node.context.get('dhw');
    Object.assign(d, { state: 'DHW', since: NOW - 30 * S, startAt: NOW - 3 * MIN, startTank: 44,
        run: (NOW - 3 * MIN) + ':dhw', live: true, outAvg: -2, outS: [[NOW, -2]],
        p23Cmd: 40, p24Cmd: 12, p24Goal: 12, goal: 40, tickAt: NOW - 30 * S,
        prot: { steps: 0, hotSince: NOW - 3 * MIN, at: 0, cut: 0, reason: '' } });
    c.node.context.set('dhw', d);
    c.tick(NOW, { 2: 'smart', 104: 100, 108: 44, 112: 9, 115: 81, 133: 40, 134: 12 }, true);

    assert.equal(c.node.context.get('dhw').prot.steps, 1);
    assert.equal(c.node.context.get('dhw').prot.cut, 2);
    assert.ok(c.node.context.get('queue').some(w => w.rule === 'dhw' && String(w.dps) === '133' && w.set < 40));
});

test('defrost start turns the bypass on after three matching ticks', () => {
    const c = heating({ modes: { df_exchange_off: 'live' } });
    for (let i = 0; i < 3; i++) c.tick(NOW + i * 10 * S, { 102: 26, 103: 5, 115: 40, 116: 0 });
    assert.deepEqual(c.writes.map(w => [w.device, w.dps, w.set]), [['bypass', 1, true]]);
});

test('defrost recovery turns the bypass off after three matching ticks', () => {
    const c = heating({ modes: { df_exchange_on: 'live' } });
    for (let i = 0; i < 3; i++) c.tick(NOW + i * 10 * S, { 102: 30, 103: 5, 115: 40, 116: 596, 125: 36, 132: '1' }, false, true);
    assert.deepEqual(c.writes.map(w => [w.device, w.dps, w.set]), [['bypass', 1, false]]);
});

test('Er03 restart starts with a valve-to-heating command only after three matching ticks', () => {
    const c = heating({ modes: { hp_er03_restart: 'live' } });
    for (let i = 0; i < 3; i++) c.tick(NOW + i * 10 * S, { 15: 1 }, true);
    assert.deepEqual(c.writes.map(w => [w.device, w.dps, w.set]), [['valve', 1, false]]);
});
