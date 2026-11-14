'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadNode } = require('./harness');
const MIN = 60000;
const NOW = new Date(2026, 10, 13, 12, 0).getTime();

function controller({ now = NOW, enabled = true, mode = 'live', motion = true, history = [] } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true, modes: { dhw: mode, heat: 'off', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        dhw: { showerForce: enabled }, heatCurve: { p23: 38, p24: 4, at: now - 3600000 },
        dhwLastEnd: now - 5 * MIN, showerHistory: history
    }) }, { now });
    const d = node.context.get('dhw');
    Object.assign(d, { state: 'HEATING', since: now - 3600000, outAvg: 1, outS: [[now - MIN, 1]], lastEnd: now - 5 * MIN });
    node.context.set('lastDefrost', now - 3600000);
    node.context.set('shower', { samples: [[now - 2 * MIN, 50], [now - MIN, 50]],
        lastValve: false, valveAt: now - 10 * MIN, episode: null, demand: null, dropC: null });
    if (motion) node.flow.set('bathroomMotion', { source: 'local', value: 'pir', t: now - 1000, seen: now - 1000, lastMotionAt: now - 1000 });
    function tick(t = now, over = {}, valve = false, bypass = false) {
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: Object.assign({
                1: true, 2: 'mute', 15: 0, 101: 32, 102: 35, 103: 1, 104: 60, 108: 49, 112: 3, 115: 60, 116: 550,
                125: 35, 132: '1', 133: 38, 134: 4
            }, over) },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: valve } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: bypass } }
        });
        return node.run({ topic: 'tick' }, { now: t });
    }
    return { node, tick };
}

test('local PIR bridge rejects cached/merged motion and retains the positive timestamp after clear', () => {
    const node = loadNode('46 Heat pump local sensors.js');
    const reading = (t, fields) => node.run({ payload: JSON.stringify({
        kind: 'reading', id: 'bfaf117b85c74f0e4cyniz', role: 'dev', t, ...fields
    }) + '\n' }, { now: t });
    reading(NOW, { cached: true, reportedDps: { 101: 'pir' } });
    reading(NOW, { cached: false, dps: { 101: 'pir' }, reportedDps: { 102: 'high' } });
    reading(NOW, { cached: false, dps: { 101: 'pir' } });
    assert.equal(node.flow.get('bathroomMotion'), undefined);
    reading(NOW + 1000, { cached: false, reportedDps: { 101: 'pir' } });
    reading(NOW + 41000, { cached: false, reportedDps: { 101: 'none' } });
    assert.deepEqual(node.flow.get('bathroomMotion'), {
        id: 'bfaf117b85c74f0e4cyniz', t: NOW + 41000, seen: NOW + 41000, value: 'none', source: 'local', lastMotionAt: NOW + 1000
    });
});

test('recorder includes exact motion time and shower demand in the existing delta dataset', () => {
    const node = loadNode('36 Record heat pump data.js');
    node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: NOW, dps: { 108: 49 } } });
    node.flow.set('bathroomMotion', { value: 'none', t: NOW, lastMotionAt: NOW - 40000, source: 'local' });
    node.flow.set('dhwView', { at: NOW, shower: { state: 'requested', enabled: true, requested: true, dropC: 1, expectedAt: NOW + 30 * MIN } });
    const payload = node.run({}, { now: NOW }).result[0].payload.trim().split('\n');
    const columns = payload[0].split('cols=')[1].split(',');
    const values = Object.fromEntries(columns.map((key, i) => [key, payload[1].split(',')[i]]));
    assert.equal(values.motion_state, 'none');
    assert.equal(values.motion_at_ms, String(NOW - 40000));
    assert.equal(values.motion_report_ms, String(NOW));
    assert.equal(values.shower_control_ms, String(NOW));
    assert.equal(values.shower_demand, '1');
    assert.equal(values.shower_drop_c, '1');
});

test('fresh motion and the first 1 C tank fall start immediately despite cycle interval and hysteresis', () => {
    const { node, tick } = controller();
    tick();
    const d = node.context.get('dhw');
    assert.equal(d.state, 'STOP');
    assert.equal(d.showerStart.type, 'drop');
    assert.match(d.showerStart.reason, /local motion/);
    assert.equal(node.context.get('settings').dhwLastEnd, NOW - 5 * MIN);
});

test('without recent local motion, only a stronger 2 C fall requests early hot-water heating', () => {
    const small = controller({ motion: false });
    small.tick();
    assert.equal(small.node.context.get('dhw').state, 'HEATING');
    const strong = controller({ motion: false });
    strong.tick(NOW, { 108: 48 });
    assert.equal(strong.node.context.get('dhw').state, 'STOP');
    assert.match(strong.node.context.get('dhw').showerStart.reason, /2 °C/);
    const cloud = controller({ motion: false });
    cloud.node.flow.set('bathroomMotion', { source: 'cloud', lastMotionAt: NOW - 1000 });
    cloud.tick();
    assert.equal(cloud.node.context.get('dhw').state, 'HEATING');
});

test('disabled assistance and already hot tanks do not force a cycle', () => {
    const disabled = controller({ enabled: false });
    disabled.tick();
    assert.equal(disabled.node.context.get('dhw').state, 'HEATING');
    const hot = controller();
    hot.tick(NOW, { 108: 50 });
    assert.equal(hot.node.context.get('dhw').state, 'HEATING');
});

test('early preparation requires at least a 1 C deficit at the exact boundary', () => {
    for (const [tank, expected] of [[49.01, 'HEATING'], [49, 'STOP'], [48.99, 'STOP']]) {
        const { node, tick } = controller({ motion: false });
        node.context.get('shower').demand = { id: 'preheat-boundary', type: 'preheat', until: NOW + 10 * MIN, reason: 'learned window' };
        for (let i = 0; i < 8 && node.context.get('dhw').state === 'HEATING'; i++) tick(NOW + i * 10000, { 108: tank });
        assert.equal(node.context.get('dhw').state, expected, String(tank));
        if (expected === 'HEATING') assert.match(node.context.get('dhw').why, /shower minimum 1/);
        assert.equal(node.flow.get('dhwView').shower.minDeficitC, 1);
    }
});

test('hot deployment supplies opt-in defaults without replacing existing settings', () => {
    const { node, tick } = controller();
    delete node.context.get('settings').dhw.showerForce;
    delete node.context.get('settings').dhw.showerLeadMin;
    tick();
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.flow.get('dhwView').cfg.showerForce, false);
    assert.equal(node.flow.get('dhwView').cfg.showerLeadMin, 30);
});

test('shower demand keeps defrost, fault, aborted-cycle and heating-priority gates', () => {
    for (const condition of ['defrost', 'recent', 'season', 'fault', 'blocked', 'heating-lag']) {
        const { node, tick } = controller();
        const over = {};
        if (condition === 'defrost') over[116] = 0;
        if (condition === 'recent') node.context.set('lastDefrost', NOW - MIN);
        if (condition === 'season') node.context.get('settings').defrostStarts = [NOW - 85 * MIN];
        if (condition === 'fault') over[15] = 1;
        if (condition === 'blocked') node.context.get('settings').dhwBlock = { at: NOW - MIN, why: 'Er03' };
        if (condition === 'heating-lag') {
            over[103] = -15; over[108] = 38;
            Object.assign(node.context.get('dhw'), { outAvg: -15, outS: [[NOW - MIN, -15]],
                lagS: Array.from({ length: 21 }, (_, i) => [NOW - (20 - i) * MIN, -4]) });
        }
        tick(NOW, over);
        assert.equal(node.context.get('dhw').state, 'HEATING', condition);
    }
    const cold = controller();
    Object.assign(cold.node.context.get('dhw'), { outAvg: -15, outS: [[NOW - MIN, -15]], lagS: [] });
    cold.tick(NOW, { 103: -15, 108: 38 });
    assert.equal(cold.node.context.get('dhw').state, 'STOP', 'only the 3 h cold interval may be bypassed');
});

test('stale HP data cannot force heating from a pending demand', () => {
    const { node, tick } = controller();
    tick();
    node.context.get('dhw').state = 'HEATING';
    node.context.get('shower').demand = { id: 'pending', type: 'drop', until: NOW + MIN, reason: 'test' };
    node.flow.get('heatPump').hp.lastData = NOW - 10 * MIN;
    node.run({ topic: 'tick' }, { now: NOW + 1000 });
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.match(node.context.get('dhw').waitNote, /stale/);
});

test('missing tank or safety measurements never become a zero-temperature forced start', () => {
    for (const dp of [108, 101, 102, 103, 104, 112, 115, 116]) {
        const { node, tick } = controller({ motion: false });
        tick(NOW, { 108: 50 });
        node.context.get('shower').demand = { id: 'pending', type: 'drop', until: NOW + MIN, reason: 'test' };
        node.flow.get('heatPump').hp.dps[dp] = null;
        node.run({ topic: 'tick' }, { now: NOW + 1000 });
        assert.equal(node.context.get('dhw').state, 'HEATING', String(dp));
        assert.match(node.context.get('dhw').why, /valid tank|valid cycle/, String(dp));
    }
});

test('confirmed motion-correlated drops learn a window only on three distinct days', () => {
    const now = new Date(2026, 10, 13, 19, 50).getTime();
    const history = [9, 10, 11].map(day => ({
        at: new Date(2026, 10, day, 20, 15).getTime(), motionAt: new Date(2026, 10, day, 20, 10).getTime(), dropC: 2
    }));
    const warm = controller({ now, motion: false, history });
    for (let i = 0; i < 8 && warm.node.context.get('dhw').state === 'HEATING'; i++) warm.tick(now + i * 10000);
    assert.equal(warm.node.context.get('dhw').state, 'STOP');
    assert.equal(warm.node.context.get('dhw').showerStart.type, 'preheat');
    assert.equal(warm.node.flow.get('dhwView').shower.evidenceDays, 3);
    for (const bad of [history.slice(0, 2), history.map(e => ({ ...e, at: history[0].at })), history.map(e => ({ ...e, cancelled: true }))]) {
        const wait = controller({ now, motion: false, history: bad });
        for (let i = 0; i < 8; i++) wait.tick(now + i * 10000);
        assert.equal(wait.node.context.get('dhw').state, 'HEATING');
        assert.equal(wait.node.flow.get('dhwView').shower.expectedAt, 0);
    }
});

test('a served preheat window is not started again after settings are reloaded', () => {
    const now = new Date(2026, 10, 13, 19, 50).getTime();
    const history = [9, 10, 11].map(day => ({
        at: new Date(2026, 10, day, 20, 15).getTime(), motionAt: new Date(2026, 10, day, 20, 10).getTime(), dropC: 2
    }));
    const { node, tick } = controller({ now, motion: false, history });
    for (let i = 0; i < 8 && node.context.get('dhw').state === 'HEATING'; i++) tick(now + i * 10000);
    const settings = JSON.parse(JSON.stringify(node.context.get('settings')));
    Object.assign(node.context.get('dhw'), { state: 'HEATING', showerStart: null });
    node.run({ topic: 'load', payload: JSON.stringify(settings) }, { now: now + MIN });
    for (let i = 0; i < 8; i++) tick(now + MIN + i * 10000);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.flow.get('dhwView').shower.requested, false);
});

test('learning requires actual 2 C correlated loss, not a motion event or an ordinary 1 C fall', () => {
    const { node, tick } = controller({ enabled: false });
    tick();
    assert.equal(node.context.get('settings').showerHistory.length, 0);
    tick(NOW + 10000, { 108: 48 });
    assert.equal(node.context.get('settings').showerHistory.length, 1);
    assert.equal(node.context.get('settings').showerHistory[0].dropC, 2);
    const missing = controller({ enabled: false, motion: false });
    missing.tick(NOW, { 108: 48 });
    assert.equal(missing.node.context.get('settings').showerHistory.length, 0);
});

test('stop removes only forced queued writes, restores heating, and supersedes old verification', () => {
    const { node, tick } = controller();
    const first = tick();
    const d = node.context.get('dhw'), run = d.run;
    node.context.get('queue').push({ run, rule: 'dhw', role: 'valve', dps: 1, set: true, text: 'pending valve ON' },
        { run: 'separate', rule: 'other', role: 'hp', dps: 125, set: 35, text: 'unrelated write' });
    node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 1000 });
    assert.equal(node.context.get('settings').modes.dhw, 'live');
    assert.equal(node.context.get('settings').dhw.showerForce, false);
    assert.ok(node.context.get('queue').some(e => e.run === 'separate'));
    assert.ok(!node.context.get('queue').some(e => e.run === run));
    tick(NOW + 10000);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.ok(node.context.get('queue').some(e => e.role === 'valve' && e.set === false), 'restore even if valve ON was not acknowledged');
    assert.ok(node.context.get('queue').some(e => e.role === 'hp' && e.dps === 133 && e.set === 38));
    first.timers.find(t => t.ms === 15000).cb();
    assert.ok(node.context.get('log').some(e => e.text.includes('verification superseded')));
});

test('rapid re-enable cannot retract an operator stop already requested', () => {
    const { node, tick } = controller();
    tick();
    node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 1000 });
    node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: true } }, { now: NOW + 2000 });
    assert.equal(node.flow.get('dhwView').shower.state, 'stopping');
    tick(NOW + 10000);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.context.get('dhw').showerStart, null);
});

test('node restart drops stale shower slopes and pending requests', () => {
    const init = loadNode('40 Heat pump automations.init.js');
    init.context.set('shower', { samples: [[NOW - MIN, 50]], episode: { at: NOW - MIN }, demand: { until: NOW + MIN } });
    init.run({}, { now: NOW });
    assert.deepEqual(init.context.get('shower'), { samples: [], episode: null, demand: null });
});

test('stop does not disable active defrost bypass or abort ordinary DHW', () => {
    const defrost = controller();
    defrost.tick();
    defrost.node.context.get('dhw').state = 'DEFROST_DHW';
    defrost.node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 1000 });
    defrost.tick(NOW + 10000, { 116: 0 }, false, true);
    assert.equal(defrost.node.context.get('dhw').state, 'HEATING');
    assert.ok(!defrost.node.context.get('queue').some(e => e.role === 'bypass' && e.set === false));
    const ordinary = controller();
    Object.assign(ordinary.node.context.get('dhw'), { state: 'DHW', live: true, since: NOW - MIN, startAt: NOW - MIN,
        p23Cmd: 30, p24Cmd: 12, rampAt: NOW, dhwMs: MIN, showerStart: null });
    ordinary.node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW });
    ordinary.tick(NOW + 1000, {}, true);
    assert.equal(ordinary.node.context.get('dhw').state, 'DHW');
});

test('lost measurements abort a forced cycle without sending stale boiler writes', () => {
    const { node, tick } = controller();
    tick();
    const run = node.context.get('dhw').run;
    node.context.get('queue').push({ run, rule: 'dhw', role: 'valve', dps: 1, set: true, text: 'old valve ON' });
    tick(NOW + 10000, { 108: null, 116: null }, false, true);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.context.get('settings').dhwBlock, null);
    assert.equal(node.context.get('settings').modes.dhw, 'live');
    assert.equal(node.context.get('settings').dhwLastEnd, NOW + 10000);
    assert.ok(node.context.get('log').some(e => e.kind === 'warn' && e.text.includes('lost valid cycle measurements')));
    assert.ok(!node.context.get('queue').some(e => e.run === run));
    assert.ok(node.context.get('queue').some(e => e.role === 'valve' && e.set === false));
    assert.ok(!node.context.get('queue').some(e => e.role === 'bypass' && e.set === false));
    node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 11000 });
    const resumeAt = NOW + 60 * MIN + 10000;
    for (let i = 0; i < 8 && node.context.get('dhw').state === 'HEATING'; i++) tick(resumeAt + i * 10000, { 108: 46 });
    assert.equal(node.context.get('dhw').state, 'STOP', 'ordinary DHW resumes after its normal interval without a manual reset');
    assert.equal(node.context.get('dhw').showerStart, null);
});

test('ordinary DHW never escalates power without a valid supply reading', () => {
    for (const mode of ['mute', 'smart']) {
        for (const supply of [undefined, null, '']) {
            const { node, tick } = controller({ enabled: false, motion: false });
            node.context.get('settings').dhw.allowPowerful = true;
            Object.assign(node.context.get('dhw'), { state: 'DHW', live: true, run: 'ordinary', since: NOW - MIN,
                startAt: NOW - 12 * MIN, p23Cmd: 30, p24Cmd: 12, rampAt: NOW, dhwMs: 12 * MIN,
                prog: { t: NOW - 10 * MIN, sup: 40 }, showerStart: null });
            const call = tick(NOW, { 2: mode, 102: supply }, true);
            assert.equal(node.context.get('dhw').state, 'DHW');
            assert.ok(!call.sent.some(arr => arr?.some?.(msg => msg?.payload?.operation === 'SET' && msg.payload.dps === 2)));
            assert.ok(!node.context.get('queue').some(e => e.role === 'hp' && e.dps === 2));
            assert.ok(Number.isNaN(node.context.get('dhw').prog.sup));
        }
    }
});

test('heating-lag history excludes a missing supply instead of interpreting it as zero', () => {
    for (const supply of [undefined, null]) {
        const { node, tick } = controller({ enabled: false, motion: false });
        tick(NOW, { 102: supply });
        assert.deepEqual(node.context.get('dhw').lagS, []);
    }
});

test('genuine Er03 still blocks a forced DHW cycle until allowed again', () => {
    const { node, tick } = controller();
    tick();
    node.context.get('dhw').state = 'DHW';
    tick(NOW + 10000, { 15: 1 }, true);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.match(node.context.get('settings').dhwBlock.why, /Er03/);
});

test('lost measurements during Test-mode shower DHW never affect the real cooldown', () => {
    const { node, tick } = controller({ mode: 'dry' });
    tick();
    const lastEnd = node.context.get('settings').dhwLastEnd;
    const call = tick(NOW + 10000, { 108: null });
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.context.get('settings').dhwLastEnd, lastEnd);
    assert.equal(node.context.get('settings').dhwBlock, null);
    assert.ok(!call.sent.some(arr => arr?.some?.(msg => msg?.payload?.operation === 'SET')));
});

test('stop of a Test-mode forced cycle performs no real write or real-cycle cooldown update', () => {
    const { node, tick } = controller({ mode: 'dry' });
    tick();
    assert.equal(node.flow.get('dhwView').shower.state, 'test');
    const lastEnd = node.context.get('settings').dhwLastEnd;
    node.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: false } }, { now: NOW + 1000 });
    const call = tick(NOW + 10000);
    assert.equal(node.context.get('dhw').state, 'HEATING');
    assert.equal(node.context.get('settings').dhwLastEnd, lastEnd);
    assert.ok(!call.sent.some(arr => arr?.some?.(msg => msg?.payload?.operation === 'SET')));
});

test('UI stop is immediate without confirmation and the command bridge preserves false', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '35 Heat pump page.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
    const messages = [];
    const scope = { msg: { payload: { dhwChart: { cfg: {}, shower: { enabled: true } } } },
        $watch() {}, send: msg => messages.push(msg) };
    new Function('scope', 'confirm', 'setTimeout', source)(scope, () => { throw new Error('Stop must not ask for confirmation'); }, () => {});
    scope.hpShowerForce(false);
    assert.deepEqual(messages[0], { topic: 'ui', payload: { action: 'dhwShowerForce', on: false } });
    const bridge = loadNode('37 Heat pump command.js');
    assert.equal(bridge.run(messages[0]).result[3].payload.on, false);
    assert.equal(bridge.run({ topic: 'ui', payload: { action: 'dhwShowerForce', on: 'false' } }).result, null);
});
