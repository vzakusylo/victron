'use strict';
// d#195: the curve of the pump is computed from a steady ambient value, not from its live sensor DP 103.
// 20 Nov 07:00-09:00 (GX recorder): heating set DP 125 = 36 °C at P23 39 / P24 4 the whole time = outdoor -1 °C,
// while DP 103 read -8 .. -3 °C with the compressor running, +21 .. +50 °C in a defrost and +8 .. +16 °C after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadNode, ROOT } = require('./harness');

const S = 1000, MIN = 60 * S;
const NOW = new Date(2026, 10, 20, 7, 0).getTime();
const FILE = '40 Heat pump automations.js';

// the pure helper, taken from the node source
const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const helperSrc = (source.match(/function pumpOutdoor\([\s\S]*?\n\}/) || [])[0];
const pumpOutdoor = helperSrc ? new Function(helperSrc + '\nreturn pumpOutdoor;')() : null;

test('pumpOutdoor: the outdoor value behind the pump\'s reported set point', () => {
    assert.ok(pumpOutdoor, 'pumpOutdoor() exists in ' + FILE);
    assert.equal(pumpOutdoor(39, 4, 36), -1);
    assert.equal(pumpOutdoor(38, 4, 36), -2);
    // 19 Nov DHW start: 13 - 17 / 1.2
    assert.ok(Math.abs(pumpOutdoor(13, 12, 37) - -1.2) < 0.06);
});

test('pumpOutdoor is null for a curve that is off, P24 0, a clamped set point or a missing value', () => {
    assert.equal(pumpOutdoor(39, 4, 36, false), null, 'P22 off');
    assert.equal(pumpOutdoor(39, 0, 36), null, 'P24 0');
    assert.equal(pumpOutdoor(39, 4, 20), null, 'clamped at 20');
    assert.equal(pumpOutdoor(39, 4, 60), null, 'clamped at 60');
    assert.equal(pumpOutdoor(39, 4, NaN), null);
    assert.equal(pumpOutdoor(NaN, 4, 36), null);
    assert.equal(pumpOutdoor(39, 4, 36, true), -1);
});

// A node with the saved settings; hp / valve / bypass dps as the pump reports them.
function rig({ dhw = 'off', heat = 'off', heatCfg = { kickMin: 1, kickSec: 60 }, heatCurve = { p23: 39, p24: 4, at: NOW - 3600000 } } = {}) {
    const node = loadNode(FILE);
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw, heat, df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: heatCfg, dhw: { showerForce: false }, heatCurve, dhwLastEnd: NOW - 5 * 3600000
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const writes = [];
    function tick(t, over = {}, valve = false, bypass = false) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 36, 103: -7, 104: 60, 108: 49, 112: 3, 115: 40, 116: 550,
                125: 36, 132: '1', 133: 39, 134: 4
            }, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: valve } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: bypass } }
        });
        const call = node.run({ topic: 'tick' }, { now: t });
        for (const m of call.sent) {
            for (const [port, device] of [[1, 'pump'], [3, 'bypass'], [4, 'valve']]) {
                if (m && m[port] && m[port].payload && m[port].payload.operation === 'SET') writes.push({ t, device, dps: m[port].payload.dps, set: m[port].payload.set });
            }
        }
        return call;
    }
    return { node, tick, writes, dhw: () => node.context.get('dhw'), pumpOut: () => node.context.get('pumpOut') };
}

// 20 Nov rows: [minutes since the previous row, DP 103, fan, Hz]. Fan 0 with > 30 Hz is a defrost.
const ROWS = [
    [0, -8, 550, 40], [1, -7, 550, 40], [1, -3, 550, 40], [1, -8, 550, 40], [1, -7, 550, 40],
    [1, 0, 0, 60], [1, 7, 0, 60], [1, 21, 0, 60], [1, 35, 0, 60], [1, 44, 0, 60], [1, 50, 0, 60],
    [1, 16, 550, 40], [1, 10, 550, 40], [1, 4, 550, 40],
    [16, -5, 550, 40], [1, -6, 550, 40]
];

test('20 Nov replay: the pump outdoor value stays -1 °C while DP 103 swings -8 .. +50 °C, defrost rows are ignored', () => {
    const c = rig();
    let t = NOW;
    const seen = [];
    for (const [gap, out, fan, hz] of ROWS) {
        t += gap * MIN;
        // the pump's set point is disturbed while it defrosts and just after: those rows must not be used
        const disturbed = out > 0 || (gap === 1 && out === 4);
        c.tick(t, { 103: out, 116: fan, 115: hz, 125: disturbed ? 31 : 36 });
        seen.push(c.pumpOut());
    }
    assert.equal(seen[0], undefined, 'nothing before P23 / P24 were stable for 2 min');
    assert.equal(seen[2].v, -1);
    const latchedAt = seen[4].at;
    for (let i = 5; i <= 13; i++) {
        assert.equal(seen[i].v, -1, 'row ' + i + ' (DP 103 ' + ROWS[i][1] + ') keeps -1');
        assert.equal(seen[i].at, latchedAt, 'row ' + i + ' is a defrost / quiet row: not re-latched');
    }
    assert.ok(seen[14].at > latchedAt, '16 min after the defrost the value is taken again');
    assert.equal(seen[15].v, -1);
});

test('no latch while the curve is off, the valve is on the tank, the bypass is on, or P23 just changed', () => {
    const cases = [
        ['curve off', { 132: '0' }, false, false],
        ['valve on DHW', {}, true, false],
        ['bypass on', {}, false, true],
        ['clamped set 20', { 125: 20 }, false, false]
    ];
    for (const [name, over, valve, bypass] of cases) {
        const c = rig();
        for (let i = 0; i < 6; i++) c.tick(NOW + i * MIN, over, valve, bypass);
        assert.equal(c.pumpOut(), undefined, name);
    }
    const c = rig();
    for (let i = 0; i < 4; i++) c.tick(NOW + i * MIN);
    assert.equal(c.pumpOut().v, -1);
    c.node.context.set('pumpOut', undefined);
    c.tick(NOW + 4 * MIN, { 133: 38 });
    c.tick(NOW + 5 * MIN, { 133: 38 });
    assert.equal(c.pumpOut(), undefined, 'P23 changed 1 min ago: the pump may not have reported the new set yet');
    c.tick(NOW + 6 * MIN, { 133: 38 });
    assert.equal(c.pumpOut().v, -2);
});

test('a latched value older than 3 h is not used', () => {
    const c = rig({ heat: 'live' });
    for (let i = 0; i < 4; i++) c.tick(NOW + i * MIN);
    assert.equal(c.node.flow.get('dhwView').pumpOut.v, -1);
    // valve on the tank for hours: nothing re-latches
    for (let i = 0; i < 4; i++) c.tick(NOW + 4 * MIN + i * 70 * MIN, {}, true);
    assert.equal(c.node.flow.get('dhwView').pumpOut, null);
});

// ---- heating controller ---------------------------------------------------------------
test('heating controller: with DP 103 -7 and the pump at 36 °C the lag is against 36, not 38, and nothing is kicked or boosted', () => {
    const c = rig({ heat: 'live', heatCurve: { p23: 38, p24: 4, at: NOW - 3600000 },
        heatCfg: { lagUp: 1.5, overC: 1, gapMax: 4, stepMin: 10, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 1, kickSec: 60 } });
    // the pump shows P23 38 / P24 4 / set 36 -> outdoor -2; the sensor reads -7 (curve 38 °C at -7)
    const dpsH = { 102: 35, 101: 32, 103: -7, 133: 38, 134: 4, 125: 36 };
    for (let i = 0; i <= 150; i++) {
        c.tick(NOW + i * 10 * S, dpsH);
        if (i === 15) c.writes.length = 0;   // the first 2 min have no latched value yet (a restart): old behaviour
    }
    const view = c.node.flow.get('dhwView');
    assert.equal(view.pumpOut.v, -2);
    assert.equal(view.heat.target, 36);
    assert.equal(view.heat.lag, -1);
    assert.equal(view.heat.outSrc, 'pump');
    assert.deepEqual(c.writes, [], 'no Smart kick, no boost');
    assert.ok(c.dhw().lagS.length > 20 && c.dhw().lagS.every((x) => x[1] >= -3.01));
    const lag = c.dhw().lagS[c.dhw().lagS.length - 1][1];
    assert.ok(Math.abs(lag - -1) < 0.01, 'DHW "heating lags" check also measures against 36: ' + lag);
});

test('heating controller without a pump value yet falls back to the sensor average and says so', () => {
    const c = rig({ heat: 'live' });
    for (let i = 0; i <= 8; i++) c.tick(NOW + i * 10 * S, { 133: 40, 125: 20 });   // set 20 is clamped: never valid
    assert.equal(c.pumpOut(), undefined);
    assert.equal(c.node.flow.get('dhwView').heat.outSrc, 'sensor');
    assert.equal(c.node.flow.get('dhwView').heat.target, 38.4, 'curve at the -7 °C sensor average, as before');
});

// ---- DHW boiler curve -----------------------------------------------------------------
// A cycle in the DHW state with the compressor running; P23 20 / P24 12 is what the boiler curve asks at -1 °C.
function dhwCycle() {
    const c = rig({ dhw: 'live' });
    // heating for 4 min: latches the pump outdoor value (-1 °C), the sensor average is -1 °C as well
    let t = NOW;
    for (let i = 0; i < 5; i++, t += MIN) c.tick(t, { 103: -1 });
    t += 30 * S;
    Object.assign(c.dhw(), { state: 'DHW', since: t - 5 * MIN, startAt: t - 6 * MIN, startTank: 30, run: (t - 6 * MIN) + ':dhw', live: true,
        p23Cmd: 20, p24Cmd: 12, goal: 20, p24Goal: 12, tickAt: t - 30 * S, rampAt: t - 5 * MIN, prot: null });
    return { c, t };
}
const DHW_DPS = { 101: 40, 102: 45, 108: 31, 115: 40, 116: 550, 133: 20, 134: 12, 125: 45 };

test('DHW: the boiler P23 is computed from the latched pump outdoor value and does not follow DP 103 down while the compressor runs', () => {
    const { c, t } = dhwCycle();
    assert.equal(c.dhw().pumpLatch, -1);
    let p23At = [];
    for (let i = 1; i <= 12; i++) {
        const out = i === 1 ? -1 : -7;   // the fan pulls cold air over the sensor
        c.tick(t + i * MIN, Object.assign({}, DHW_DPS, { 103: out }), true);
        p23At.push(c.dhw().p23Cmd);
    }
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    assert.ok(p23At.every((p) => p >= 20), 'P23 never drops below 20 (old rule: about 14): ' + p23At);
    assert.match(c.dhw().why, /pump outdoor -1 °C \(from its set point\)/);
});

test('DHW start: valve settled with a latched -1 °C uses it even when the sensor and the average are far off', () => {
    const c = rig({ dhw: 'live' });
    let t = NOW;
    for (let i = 0; i < 5; i++, t += MIN) c.tick(t, { 103: -1 });
    const dps = { 101: 32, 102: 32, 103: -6, 108: 31, 115: 0, 116: 0, 133: 0, 134: 12, 125: 20 };
    c.tick(t, dps, true);
    Object.assign(c.dhw(), { state: 'VALVE', since: t - 100 * S, run: t + ':dhw', live: true, startAt: t - 3 * MIN, startTank: 30,
        outS: [[t - MIN, -6]], outAvg: -6, p23Cmd: 0, p24Cmd: null, rampAt: 0, prot: null });
    c.tick(t + 30 * S, dps, true);
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    assert.equal(c.dhw().p23Cmd, 15, 'water 32 + startGap 7 = 39 °C at -1 °C, P24 12 (19 Nov: the compressor started at P23 13)');
    assert.equal(c.dhw().p24Cmd, 12);
});

test('DHW without a valid pump value: the old live-sensor rule and a "fallback" status', () => {
    const c = rig({ dhw: 'live' });
    const dps = { 101: 32, 102: 32, 103: -1, 108: 31, 115: 0, 116: 0, 133: 0, 134: 12, 125: 20 };
    c.tick(NOW, dps, true);
    Object.assign(c.dhw(), { state: 'VALVE', since: NOW - 100 * S, run: NOW + ':dhw', live: true, startAt: NOW - 3 * MIN, startTank: 30,
        outS: [[NOW - MIN, -6]], outAvg: -6, p23Cmd: 0, p24Cmd: null, rampAt: 0, prot: null });
    c.node.context.set('lastDefrost', NOW - 10 * MIN);
    c.tick(NOW + 30 * S, dps, true);
    assert.equal(c.dhw().state, 'DHW', c.dhw().why);
    assert.equal(c.dhw().p23Cmd, 15, 'live DP 103 -1 as before (d#191)');
    c.tick(NOW + 90 * S, Object.assign({}, dps, { 133: 15 }), true);
    assert.match(c.dhw().why, /sensor -1 °C \(fallback\)/);
});

// ---- page model (34) ------------------------------------------------------------------
test('Heat Pump page: the curve point uses the pump outdoor value and says so; the sensor stays visible', () => {
    const node = loadNode('34 Heat pump state.js');
    const now = NOW;
    node.flow.set('dhwView', { at: now, state: 'HEATING', outAvg: -7, pumpOut: { v: -1, at: now - MIN } });
    const send = (dps) => node.run({ topic: 'hp', payload: { data: { dps } } }, { now });
    const dps = { 1: true, 102: 36, 103: -7, 125: 36, 132: '1', 133: 39, 134: 4 };
    const chart = send(dps).result[0].payload.curveChart;
    assert.equal(chart.outdoor, -1);
    assert.equal(chart.target, 36, 'not 38.4 (from DP 103 -7)');
    assert.equal(chart.outdoorSource, 'pump');
    assert.match(chart.outdoorText, /^pump outdoor -1 °C \(from its set point\)$/);
    assert.equal(chart.sensor, -7);

    // older than 3 h: fallback to the sensor average, and the text says so
    node.flow.set('dhwView', { at: now, state: 'HEATING', outAvg: -7, pumpOut: { v: -1, at: now - 4 * 3600000 } });
    const fb = send(dps).result[0].payload.curveChart;
    assert.equal(fb.outdoor, -7);
    assert.equal(fb.target, 38.4);
    assert.equal(fb.outdoorSource, 'sensor');
    assert.match(fb.outdoorText, /^sensor -7 °C \(fallback\)$/);
});
