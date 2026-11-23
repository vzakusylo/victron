'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const NOW = Date.UTC(2026, 10, 23, 12);
const reading = (dps, role = 'hp') => ({ topic: role, payload: { data: { dps } } });

test('a five-second burst builds only once, merging every reading before the build', () => {
    const state = loadNode('34 Heat pump state.js');
    const first = state.run(reading({ 102: 31, 101: 28 }), { now: NOW });
    const next = state.run(reading({ 102: 32 }), { now: NOW + 1000 });
    const last = state.run(reading({ 1: true }, 'valve'), { now: NOW + 4900 });
    assert.equal(first.result ?? null, null);
    assert.equal(next.result ?? null, null);
    assert.equal(last.result ?? null, null);
    assert.deepEqual(first.timers.map(t => t.ms), [5000]);
    assert.equal(next.timers.length + last.timers.length, 0);
    assert.equal(state.flow.get('heatPumpModel'), undefined);
    assert.equal(state.flow.get('heatPump').hp.dpObservedAt['102'], NOW + 1000);
    assert.equal(state.flow.get('heatPump').valve.dps['1'], true);
    first.timers[0].cb();
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0][0].payload.summary.supply, 32);
    assert.equal(first.sent[0][0].payload.summary.ret, 28);
    assert.equal(first.sent[0][0].payload.summary.valveToDhw, true);
    assert.equal(state.run(reading({ 102: 33 }), { now: NOW + 5001 }).timers.length, 1);
});

test('the Tuya connection-only branch never merges a data packet', () => {
    const state = loadNode('34 Heat pump state.js');
    const initial = state.run(reading({ 102: 32 }), { now: NOW });
    state.run(reading({ 102: 99 }, 'hp-status'), { now: NOW + 100 });
    state.run({ topic: 'hp-status', payload: { state: 'DISCONNECTED' } }, { now: NOW + 200 });
    assert.equal(state.flow.get('heatPump').hp.dpObservedAt['102'], NOW);
    assert.equal(state.flow.get('heatPump').hp.state, 'DISCONNECTED');
    initial.timers[0].cb();
    assert.equal(initial.sent[0][0].payload.summary.supply, 32);
    assert.equal(initial.sent[0][0].payload.devices[0].state, 'DISCONNECTED');
});

test('without a supply reading, the status label identifies the last role in the batch', () => {
    const state = loadNode('34 Heat pump state.js');
    const first = state.run(reading({ 101: 30 }), { now: NOW });
    state.run({ topic: 'meter-status', payload: { state: 'DISCONNECTED' } }, { now: NOW + 100 });
    first.timers[0].cb();
    assert.equal(first.status.text, 'meter: DISCONNECTED');
});

function dashboard() {
    const node = loadNode('66 Heat pump page updates.js');
    const model = {
        updated: new Date(NOW).toISOString(),
        devices: [{ role: 'hp', state: 'CONNECTED', lastData: NOW, ageSeconds: 1 }],
        controls: { curve: true },
        summary: { supply: 32, meterDps: [{ dp: '6', value: 'sample' }] },
        curveChart: { table: [{ out: 0, set: 35 }], svg: { line: '0,1 2,3', now: { x: 4 } } },
        dhwChart: { table: [{ out: 0, set: 48 }], svg: { line: '0,1 2,3', now: { x: 4 } } },
        items: [{ dp: '102', value: 32 }], unknown: []
    };
    const next = () => {
        node.flow.set('heatPumpModel', model);
        return node.run({ payload: model }).result ?? null;
    };
    const event = (socketid, payload, name) => node.run({ payload, socketid, name }).result ?? null;
    return { model, next, event };
}

test('no viewer means no send, including after disconnect or leaving the page', () => {
    const gx = dashboard();
    assert.equal(gx.next(), null);
    assert.equal(gx.event('a', 'connect'), null);
    assert.equal(gx.event('a', 'change', 'Energy'), null);
    gx.model.summary.supply++;
    assert.equal(gx.next(), null);
    gx.event('a', 'change', 'Heat Pump');
    gx.event('a', 'change', 'Energy');
    gx.model.summary.supply++;
    assert.equal(gx.next(), null);
    gx.event('b', 'change', 'Heat Pump data');
    gx.event('b', 'lost');
    gx.model.items[0].value++;
    assert.equal(gx.next(), null);
});

test('new viewers get a targeted full snapshot, then only meaningful changes', () => {
    const gx = dashboard();
    gx.next();
    const [[a]] = gx.event('a', 'change', 'Heat Pump');
    assert.equal(a.socketid, 'a');
    assert.equal(a.payload.summary.supply, 32);
    assert.deepEqual(a.hpStatic.curveChart.table, [{ out: 0, set: 35 }]);
    assert.equal(a.hpStatic.dhwChart.svg.line, '0,1 2,3');
    gx.model.updated = new Date(NOW + 5000).toISOString();
    gx.model.devices[0].ageSeconds += 5;
    assert.equal(gx.next(), null);
    gx.model.devices[0].stale = true;
    assert.equal(gx.next()[0][0].payload.devices[0].stale, true);
    const [[b]] = gx.event('b', 'change', 'Heat Pump');
    assert.equal(b.socketid, 'b');
    assert.deepEqual(b.hpStatic, a.hpStatic);
    const [, [c]] = gx.event('c', 'change', 'Heat Pump data');
    assert.equal(c.socketid, 'c');
    assert.deepEqual(c.payload.items, gx.model.items);
    assert.deepEqual(c.payload.summary.meterDps, gx.model.summary.meterDps);
    gx.model.summary.supply++;
    const [[aLive, bLive], data] = gx.next();
    assert.equal(data, null);
    assert.deepEqual([aLive.socketid, bLive.socketid], ['a', 'b']);
    assert.equal(aLive.payload.summary.supply, 33);
    assert.equal(aLive.hpStatic, undefined);
    assert.equal(aLive.payload.curveChart.svg.now.x, 4);
    assert.equal(aLive.payload.items, undefined);
    gx.model.curveChart = null;
    const [[changed]] = gx.next();
    assert.equal(changed.hpStatic.curveChart, null, 'clear the previous table and chart');
});
