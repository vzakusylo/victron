'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');
const MIN = 60000;
const NOW = new Date(2026, 10, 13, 12, 0).getTime();

// Same fixture as shower-dhw.test.js, but shower assistance off and no motion: only the operator forces a run.
function controller({ now = NOW, saved = {} } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify(Object.assign({
        master: true, modes: { dhw: 'live', heat: 'off', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        dhw: { showerForce: false }, heatCurve: { p23: 38, p24: 4, at: now - 3600000 }, dhwLastEnd: now - 5 * MIN
    }, saved)) }, { now });
    const d = node.context.get('dhw');
    Object.assign(d, { state: 'HEATING', since: now - 3600000, outAvg: 1, outS: [[now - MIN, 1]], lastEnd: now - 5 * MIN });
    node.context.set('lastDefrost', now - 3600000);
    node.context.set('shower', { samples: [[now - 2 * MIN, 48], [now - MIN, 48]],
        lastValve: false, valveAt: now - 10 * MIN, episode: null, demand: null, dropC: null });
    function tick(t = now, over = {}) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 35, 103: 1, 104: 60, 108: 48, 112: 3, 115: 60, 116: 550,
                125: 35, 132: '1', 133: 38, 134: 4
            }, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        return node.run({ topic: 'tick' }, { now: t });
    }
    const ui = (on, t = now) => node.run({ topic: 'ui', payload: { action: 'dhwForceRun', on } }, { now: t });
    const dhw = () => node.context.get('dhw');
    const settings = () => node.context.get('settings');
    return { node, tick, ui, dhw, settings };
}

test('without a request the cycle interval keeps the boiler idle', () => {
    const c = controller();
    c.tick();
    assert.equal(c.dhw().state, 'HEATING');
    assert.match(c.dhw().why, /last cycle 5 min ago/);
});

test('force run starts at once despite the interval and shower assistance being off', () => {
    const c = controller();
    c.ui(true);
    assert.ok(c.settings().dhwManual, 'request persisted');
    c.tick();
    assert.equal(c.dhw().state, 'STOP');
    assert.equal(c.dhw().showerStart.type, 'manual');
    assert.equal(c.settings().dhwManual, null, 'request consumed on start');
});

test('force run waits for a running defrost and starts right after it', () => {
    const c = controller();
    c.ui(true);
    c.tick(NOW, { 116: 0 });                       // fan 0 + compressor running = defrost now
    assert.equal(c.dhw().state, 'HEATING');
    assert.match(c.dhw().why, /defrost/);
    assert.ok(c.settings().dhwManual, 'still queued during the defrost');
    assert.ok(c.node.flow.get('dhwView').shower.manual.queued);
    let started = null;
    for (let m = 1; m <= 60 && !started; m++) {
        c.tick(NOW + m * MIN);
        if (c.dhw().state !== 'HEATING') started = m;
    }
    assert.ok(started, 'started after the defrost ended');
    assert.equal(c.dhw().showerStart.type, 'manual');
});

test('force run takes priority over the defrost-season window and heating lag', () => {
    const c = controller();
    c.settings().defrostStarts = [NOW - 85 * MIN];
    Object.assign(c.dhw(), { outAvg: -15, outS: [[NOW - MIN, -15]],
        lagS: Array.from({ length: 21 }, (_, i) => [NOW - (20 - i) * MIN, -4]) });
    c.ui(true);
    c.tick(NOW, { 103: -15, 108: 38 });
    assert.equal(c.dhw().state, 'STOP');
});

test('force run keeps the fault, DHW block and tank-deficit gates', () => {
    for (const condition of ['fault', 'blocked', 'hot']) {
        const c = controller();
        const over = {};
        if (condition === 'fault') over[15] = 1;
        if (condition === 'blocked') c.settings().dhwBlock = { at: NOW - MIN, why: 'Er03' };
        if (condition === 'hot') over[108] = 50;     // target 50 at 1 C outdoor: no 1 C deficit
        c.ui(true);
        c.tick(NOW, over);
        assert.equal(c.dhw().state, 'HEATING', condition);
        assert.ok(c.settings().dhwManual, condition + ': request stays queued');
    }
});

test('cancel clears a queued request', () => {
    const c = controller();
    c.ui(true);
    c.ui(false);
    assert.equal(c.settings().dhwManual, null);
    c.tick();
    assert.equal(c.dhw().state, 'HEATING');
});

test('cancel stops a running forced run; shower assistance off does not', () => {
    const c = controller();
    c.ui(true);
    c.tick();
    assert.equal(c.dhw().state, 'STOP');
    c.tick(NOW + 10000);
    assert.notEqual(c.dhw().state, 'HEATING', 'shower assistance off must not end a manual run');
    c.ui(false, NOW + 20000);
    assert.equal(c.dhw().showerStopRequested, true);
    c.tick(NOW + 30000);
    assert.equal(c.dhw().state, 'HEATING');
});

test('turning shower assistance off in the UI does not stop a running forced run', () => {
    const c = controller();
    c.ui(true);
    c.tick();
    assert.equal(c.dhw().state, 'STOP');
    c.node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 5000 });
    assert.notEqual(c.dhw().showerStopRequested, true);
    c.tick(NOW + 10000);
    assert.notEqual(c.dhw().state, 'HEATING');
});

test('a request that cannot start expires after 3 hours', () => {
    const c = controller();
    c.settings().dhwBlock = { at: NOW - MIN, why: 'Er03' };
    c.ui(true);
    c.tick(NOW + 3 * 3600000 + MIN);
    assert.equal(c.settings().dhwManual, null);
    assert.equal(c.dhw().state, 'HEATING');
});

test('a queued request survives a restart; malformed ones are dropped', () => {
    const kept = controller({ saved: { dhwManual: { at: NOW - MIN, until: NOW + 60 * MIN } } });
    kept.tick();
    assert.equal(kept.dhw().state, 'STOP');
    for (const bad of [{ at: 'x', until: NOW }, { at: NOW, until: NOW - 1 }, { at: NOW, until: NOW + 5 * 3600000 }]) {
        const c = controller({ saved: { dhwManual: bad } });
        assert.equal(c.settings().dhwManual, null, JSON.stringify(bad));
    }
});

test('force run is refused while a DHW cycle is already running', () => {
    const c = controller();
    c.dhw().state = 'DHW';
    assert.equal(c.ui(true).result, null);
    assert.equal(c.settings().dhwManual, null);
});
