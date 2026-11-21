'use strict';
// H0 / H11: why the compressor is idle: cause per tick (status line, log, recorder column), the
// log lines "Idle: …" / "running again after N min", and the event lane of the history (38).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const NOW = new Date(2026, 10, 21, 13, 0).getTime();

function plant({ heatMode = 'live', hp = {}, lastDefrost = NOW - 60 * MIN, dhwEnd = NOW - 5 * H, hpAt = null } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw: 'off', heat: heatMode, df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        heat: { bandDown: 1.5, bandUp: 1, stepMin: 10, ampPct: 85, allowPowerful: false, maxBoost: 4, kickMin: 0, kickSec: 60 },
        heatCurve: { p23: 27, p24: 5, at: NOW - H }, dhwLastEnd: dhwEnd
    }) }, { now: NOW });
    node.context.set('lastDefrost', lastDefrost);
    const dps = (over) => Object.assign({ 1: true, 2: 'smart', 15: 0, 101: 26, 102: 29, 103: 6, 104: 60, 108: 47, 112: 0, 115: 0, 116: 0, 121: 3, 125: 36, 132: '1', 133: 27, 134: 5 }, hp, over);
    const tick = (t, over, lastData) => {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: lastData === undefined ? (hpAt === null ? t : hpAt) : lastData, dps: dps(over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } }, bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } } });
        return node.run({ topic: 'tick' }, { now: t });
    };
    const view = () => node.flow.get('dhwView').idle;
    const log = () => node.context.get('log').filter((e) => e.rule === 'hp_idle').map((e) => e.text);
    return { node, tick, view, log };
}
const cause = (opts, over) => { const p = plant(opts); p.tick(NOW, over); p.tick(NOW + 10 * S, over); return p.view().code; };

test('idle cause: a lastDefrost that only marks the node start is not reported as a defrost', () => {
    const p = plant({ lastDefrost: NOW - 2 * MIN });
    p.node.context.set('startedAt', NOW - 2 * MIN);
    p.tick(NOW, { 102: 27 }); p.tick(NOW + 10 * S, { 102: 27 });
    assert.equal(p.view().code, 9);
});

test('idle cause: each reason gets its own code, the first matching one wins', () => {
    assert.equal(cause({}, { 102: 27 }), 9, 'below the restart level, compressor not starting');
    assert.equal(cause({ lastDefrost: NOW - 5 * MIN }), 5, 'quiet period after a defrost');
    assert.equal(cause({ dhwEnd: NOW - 3 * MIN }), 6, 'after a DHW cycle');
    assert.equal(cause({}, { 1: false }), 2, 'pump off');
    assert.equal(cause({}, { 15: 1 }), 3, 'pump fault');
    assert.equal(cause({ heatMode: 'off' }), 4, 'controller Off');
    assert.equal(cause({}, { 102: 31 }), 7, 'supply at the curve point of the pump (P23 27 / P24 5 at 6 °C ≈ 30.5)');
    assert.equal(cause({}, { 102: 29 }), 8, 'inside the hysteresis: the pump waits for set − hysteresis');
});

test('idle cause: a stale heat pump during an idle period is reported as stale', () => {
    const p = plant();
    p.tick(NOW); p.tick(NOW + 10 * S);
    for (let t = NOW + 30 * S; t <= NOW + 40 * MIN; t += 30 * S) p.tick(t, {}, NOW + 10 * S);
    assert.equal(p.view().code, 1);
});

test('idle log: one "Idle:" line per period after 60 s, one "running again after N min" line at its end', () => {
    const p = plant();
    for (let t = NOW; t <= NOW + 5 * MIN; t += 10 * S) p.tick(t, { 102: 27 });
    const lines = p.log();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /^Idle: supply below the restart level, compressor not starting \(supply 27, point .*outdoor 6, pump stops at 30\.5, mode Smart, hysteresis 3\)$/);
    p.tick(NOW + 5 * MIN + 10 * S, { 115: 40, 112: 4, 116: 500 });
    const all = p.log();
    assert.equal(all.length, 2);
    assert.match(all[0], /^running again after 5 min \(reason was supply below the restart level/);
    for (let t = NOW + 6 * MIN; t <= NOW + 8 * MIN; t += 10 * S) p.tick(t, { 115: 40, 112: 4, 116: 500 });
    assert.equal(p.log().length, 2, 'nothing more while it runs');
});

test('idle log: a stop shorter than a minute is not logged', () => {
    const p = plant();
    p.tick(NOW); p.tick(NOW + 20 * S);
    p.tick(NOW + 30 * S, { 115: 40, 112: 4, 116: 500 });
    assert.deepEqual(p.log(), []);
});

test('status line and idle view use the same cause text', () => {
    const p = plant({ lastDefrost: NOW - 5 * MIN });
    p.tick(NOW); p.tick(NOW + 10 * S);
    const v = p.node.flow.get('dhwView');
    assert.equal(v.idle.text, 'after a defrost (quiet period)');
    assert.equal(v.status.text, 'Idle: after a defrost (quiet period)');
});

// ---- history (38): idle and gap segments -----------------------------------------------------
const hist = (csv, day = '2026-11-21') => loadNode('38 Build heat pump history.js')
    .run({ topic: 'day', day, payload: '#day ' + day + '\n' + csv }, { now: new Date(2026, 10, 21, 23, 59).getTime() }).result.payload.chart;
const head = (cols) => '#hp1 2026-11-21 10 cols=t,st,' + cols.join(',') + '\n';
const COLS = ['115', '116', 'idl', 'mk'];

test('history: idle segments carry their cause, short stops are dropped, the legend counts them', () => {
    let csv = head(COLS) + '0,CCCCCC,40,500,0,node start d#206\n30,,,,,-\n';
    csv += '60,,0,0,9\n' + Array.from({ length: 4 }, (_, i) => String(90 + i * 30)).join('\n') + '\n';   // 60…180 s: idle, cause 9
    csv += '210,,40,500,0\n240,,0,0,5\n270,,40,500,0\n';                                              // a 30 s stop: dropped
    const c = hist(csv);
    const idle = c.events.filter((e) => e.kind === 'idle');
    assert.equal(idle.length, 1);
    assert.equal(idle[0].tip, 'Idle: supply below the restart level, compressor not starting');
    assert.equal(idle[0].from, '10:01');
    assert.equal(c.eventLegend.find((l) => l.kind === 'idle').count, 1);
});

test('history: a file without the idl column says the cause was not recorded', () => {
    const c = hist(head(['115', '116']) + '0,CCCCCC,40,500\n60,,0,0\n90\n120\n150\n');
    const idle = c.events.filter((e) => e.kind === 'idle');
    assert.equal(idle.length, 1);
    assert.match(idle[0].tip, /^Idle: cause not recorded/);
});

test('history: a hole in the records is a gap with its marker, a disconnected pump is a gap too', () => {
    let csv = head(COLS) + '0,CCCCCC,40,500,0,-\n30\n60\n';
    csv += '#hp1 2026-11-21 10 cols=t,st,115,116,idl,mk\n600,CCCCCC,40,500,0,node start d#207\n630\n';
    csv += '660,DCCCCC\n690\n720,CCCCCC\n';
    const c = hist(csv);
    const gaps = c.events.filter((e) => e.kind === 'gap');
    assert.deepEqual(gaps.map((g) => g.tip), ['Gap: recorder restarted (node start d#207)', 'Gap: heat pump disconnected']);
    assert.equal(gaps[0].from, '10:03');
    assert.equal(c.eventLegend.find((l) => l.kind === 'gap').count, 2);
});

test('history: a hole without a marker says "no records"', () => {
    const c = hist(head(COLS) + '0,CCCCCC,40,500,0,-\n30\n60\n400\n430\n');
    assert.deepEqual(c.events.filter((e) => e.kind === 'gap').map((g) => g.tip), ['Gap: no records']);
});

// ---- recorder (36): idl and mk columns ----------------------------------------------------------
test('recorder: the first row after a start carries the marker, the idle cause is a column, both are cleared after', () => {
    const node = loadNode('36 Record heat pump data.js');
    const rowsOf = (t, view) => {
        node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: t, dps: { 1: true, 115: 0 } } });
        node.flow.set('dhwView', { at: t, idle: view });
        const out = node.run({ topic: 'tick' }, { now: t }).result[0].payload.trim().split('\n');
        return out;
    };
    const first = rowsOf(NOW, { active: true, code: 9 });
    const cols = first[0].match(/cols=(.*)$/)[1].split(',');
    const cell = (line, name) => line.split(',')[cols.indexOf(name)];
    assert.equal(cell(first[1], 'idl'), '9');
    assert.equal(cell(first[1], 'mk'), 'node start');
    const second = rowsOf(NOW + 30 * S, { active: true, code: 9 });
    assert.equal(second.length, 1, 'a delta row, no new section');
    assert.equal(cell(second[0], 'mk'), '-', 'the marker is cleared once');
    const third = rowsOf(NOW + 60 * S, { active: false, code: 0 });
    assert.equal(cell(third[0], 'idl'), '0');
    assert.equal(cell(third[0], 'mk') || '', '', 'unchanged cells stay empty');
});
