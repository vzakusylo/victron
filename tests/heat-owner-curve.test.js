'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, loadHeatPumpState } = require('./harness');

const NOW = Date.UTC(2026, 10, 24, 18);
const MIN = 60_000;
const OLD = { p23: 38, p24: 4, at: NOW - 60 * MIN };
const pair = { p23: 40, p24: 9, requestId: 'owner-edit' };
const sets = call => call.sent.flatMap(m => m[1]?.payload?.operation === 'SET' ? [m[1].payload] : []);
const groupSet = { operation: 'SET', multiple: true, data: { 133: 40, 134: 9 } };

function fixture({ liveDhw = false, lastEnd = NOW - 60 * MIN } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    const command = loadNode('37 Heat pump command.js', undefined, node.flow);
    node.run({ topic: 'load', payload: JSON.stringify({
        master: liveDhw, modes: { heat: 'off', dhw: liveDhw ? 'live' : 'off' },
        heatCurve: OLD, dhwLastEnd: lastEnd, dhw: { showerForce: false }
    }) }, { now: NOW });
    node.context.set('lastDefrost', NOW - 60 * MIN);
    const dps = { 1: true, 2: 'mute', 15: 0, 101: 31, 102: 36, 103: -2, 108: 50, 112: 3, 115: 60, 116: 550,
        125: 36, 132: '1', 133: 38, 134: 4 };
    function tick(at, { over, seen, lastData = at } = {}) {
        const dev = dps => ({ state: 'CONNECTED', lastData: at, dps });
        node.flow.set('heatPump', { hp: { ...dev({ ...dps, ...over }), lastData, dpObservedAt: seen },
            valve: dev({ 1: false }), bypass: dev({ 1: false }) });
        return node.run({ topic: 'tick' }, { now: at });
    }
    function apply(payload = pair) {
        const r = command.run({ topic: 'curve', payload }, { now: NOW });
        assert.deepEqual(r.result.slice(0, 3), [null, null, null], 'node 37 never writes the pump');
        return node.run(r.result[3], { now: NOW });
    }
    function chart(at) {
        const page = loadHeatPumpState();
        page.flow.set('dhwView', node.flow.get('dhwView'));
        const current = node.flow.get('heatPump').hp.dps;
        return page.run({ topic: 'hp', payload: { data: { dps: current } } }, { now: at }).result[0].payload.curveChart;
    }
    return { node, apply, tick, chart, settings: () => node.context.get('settings').heatCurve };
}

test('Apply queues one low-priority batch; both fresh readbacks save the owner curve', () => {
    const f = fixture();
    f.tick(NOW);
    assert.deepEqual(sets(f.apply()), []);
    const q = f.node.context.get('queue');
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].curveGroup, groupSet.data);
    assert.deepEqual(f.settings(), OLD);
    f.node.context.set('lastHpWrite', NOW);
    assert.deepEqual(sets(f.tick(NOW + 4999)), []);
    const sentAt = NOW + 5000;
    const sent = f.tick(sentAt);
    assert.deepEqual(sets(sent), [groupSet]);
    const tag = sent.sent.map(m => m[5]?.event).find(e => e?.kind === 'dispatch');
    assert.deepEqual([tag?.writer, tag?.values], ['owner', groupSet.data]);
    assert.equal(f.node.flow.get('hpWriterShadow').owners.curve.writer, 'owner');
    assert.deepEqual(sent.timers.map(t => t.ms), [5000]);
    assert.equal(f.node.context.get('queue').length, 0);
    const over = { 133: 40, 134: 9 };
    f.tick(sentAt + 1000, { over, seen: { 133: sentAt, 134: sentAt + 1 } });
    assert.deepEqual(f.settings(), OLD, 'matching cached values are insufficient');
    const confirmedAt = sentAt + 2000;
    const confirmed = f.tick(confirmedAt, { over, seen: { 133: sentAt + 1, 134: sentAt + 1 } });
    assert.deepEqual(f.settings(), { p23: 40, p24: 9, at: confirmedAt });
    assert.deepEqual(JSON.parse(confirmed.sent.find(m => m[2]?.filename)[2].payload).heatCurve, f.settings());
    assert.equal(f.chart(confirmedAt).ownerCurveResult.ok, true);
    assert.equal(f.node.flow.get('hpWriterShadow').disagreements || 0, 0);
});

test('a DHW start queued in the same tick wins over the owner group', () => {
    const f = fixture({ liveDhw: true });
    f.tick(NOW);
    assert.deepEqual(sets(f.apply()), []);
    f.node.context.get('dhw').streak = 3;
    const at = NOW + 1000;
    assert.deepEqual(sets(f.tick(at, { over: { 108: 34 } })), [{ operation: 'SET', dps: 133, set: 0 }]);
    assert.equal(f.node.context.get('dhw').state, 'STOP');
    assert.equal(f.node.flow.get('hpWriterShadow').owners.curve.writer, 'dhw');
    assert.match(f.chart(at).ownerCurveResult.text, /DHW cycle running/);
    assert.deepEqual(f.settings(), OLD);
});

test('Apply refuses invalid coefficients, DHW, its end window, P22 off and stale data', () => {
    for (const [label, { payload, lastEnd, state, over, lastData }] of Object.entries({
        'whole numbers': { payload: { ...pair, p23: 41, p24: 0 } },
        'DHW cycle': { state: 'VALVE' },
        'wait 10 minutes': { lastEnd: NOW - 2 * MIN },
        'P22 is off': { over: { 132: '0' } },
        'data stale': { lastData: NOW - 6 * MIN }
    })) {
        const f = fixture({ lastEnd });
        f.tick(NOW, { over, lastData });
        if (state) f.node.context.get('dhw').state = state;
        assert.deepEqual(sets(f.apply(payload)), []);
        assert.match(f.chart(NOW).ownerCurveResult.text, new RegExp(label));
        assert.equal(f.node.context.get('queue').length, 0);
        assert.deepEqual(f.settings(), OLD);
    }
});

test('an unconfirmed group is reported on the page and cannot become the saved baseline by capture', () => {
    const f = fixture({ liveDhw: true });
    f.tick(NOW);
    f.apply();
    const sent = f.tick(NOW + 1000);
    assert.deepEqual(sets(sent), [groupSet]);
    sent.timers[0].cb();
    const partial = { over: { 134: 9 }, seen: { 134: NOW + 2000 } };
    f.tick(NOW + 90_000, partial);
    assert.match(f.chart(NOW + 90_000).ownerCurveResult.text, /did not confirm both coefficients/);
    f.tick(NOW + 4 * MIN, partial);
    assert.deepEqual(f.settings(), OLD);
    assert.equal(f.chart(NOW + 4 * MIN).differsFromPump, true);
});

test('fresh matching owner readbacks cannot save a superseded generation', () => {
    const f = fixture({ liveDhw: true });
    f.tick(NOW);
    f.apply();
    const sentAt = NOW + 1000;
    const sent = f.tick(sentAt);
    assert.deepEqual(sets(sent), [groupSet]);
    const owner = f.node.context.get('hpCurveLease');
    f.node.context.set('hpCurveLease', { writer: 'heat', priority: 1, generation: owner.generation + 1, until: sentAt + MIN });
    f.tick(sentAt + 2000, { over: groupSet.data, seen: { 133: sentAt + 1000, 134: sentAt + 1000 } });
    assert.match(f.chart(sentAt + 2000).ownerCurveResult.text, /higher-priority/);
    assert.deepEqual(f.settings(), OLD);
    assert.equal(f.node.context.get('hpCurveLease').until, sentAt + MIN, 'owner cleanup does not release the winner');
});
