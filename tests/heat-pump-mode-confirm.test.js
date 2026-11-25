'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runInNewContext } = require('node:vm');
const { loadNode, readSource } = require('./harness');

const START = Date.UTC(2026, 10, 22, 12), MIN = 60000, CHECK = 15000;
const setMessages = call => call.sent.map(m => m[1]?.payload).filter(p => p?.dps === 2);

function fixture(settings = {}) {
    const file = '40 Heat pump automations.js';
    const heat = loadNode(file, readSource(file).replace("if (msg.topic === 'load')",
        "if (msg.topic === 'test-pump') { pump(); return null; }\nif (msg.topic === 'load')"));
    const state = loadNode('34 Heat pump state.js', undefined, heat.flow);
    const alerts = loadNode('47 Heat pump alerts.js', undefined, heat.flow);
    heat.run({ topic: 'load', payload: JSON.stringify({ master: true,
        modes: { heat: 'live', dhw: 'live', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        ...settings }) }, { now: START });
    heat.flow.set('localSensors', { acc: START, plate: START });
    const observe = (dps, now, role = 'hp') => state.run({ topic: role, payload: { data: { dps } } }, { now });
    const tick = now => heat.run({ topic: 'tick' }, { now });
    const enqueue = (now, options = {}) => {
        heat.context.set('queue', [{ role: 'hp', dps: 2, set: 'mute', rule: 'heat', run: `run:${now}`,
            text: 'mode Silent', ...options }]);
        const call = heat.run({ topic: 'test-pump' }, { now });
        call.timers.find(t => t.ms === 1500)?.cb();
        return call;
    };
    const mail = now => alerts.run({ topic: 'tick' }, { now }).result;
    function verify(call, now) {
        const timer = call.timers.find(t => t.ms === CHECK);
        assert.ok(timer, 'a mode SET schedules a 15-second check');
        timer.cb();
        const event = call.sent.map(m => m[5]?.event).find(e => e?.modeCheck || / — (NOT confirmed|confirmed)/.test(e?.text));
        assert.ok(event, 'each dispatched mode SET logs its check');
        alerts.run({ event }, { now: now + CHECK });
        return event;
    }
    return { heat, state, alerts, observe, tick, enqueue, verify, mail };
}

test('mode verify uses only post-SET DP 2 and marks an older generation superseded', () => {
    const f = fixture();
    f.observe({ 2: 'mute', 102: 33 }, START);
    const a = f.enqueue(START + MIN);
    f.observe({ 102: 34 }, START + MIN + 1000);
    assert.equal(f.heat.flow.get('heatPump').hp.dpObservedAt['2'], START);
    assert.equal(f.heat.flow.get('heatPump').hp.dpObservedAt['102'], START + MIN + 1000);
    f.observe({ 2: 'mute' }, START + MIN);
    assert.equal(f.verify(a, START + MIN).modeCheck.outcome, 'no fresh DP 2');
    const b = f.enqueue(START + 2 * MIN);
    f.observe({ 2: 'smart' }, START + 2 * MIN + 1000);
    assert.equal(f.verify(b, START + 2 * MIN).modeCheck.outcome, 'fresh mismatch');
    const c = f.enqueue(START + 3 * MIN);
    const d = f.enqueue(START + 3 * MIN + 2000, { set: 'smart' });
    f.observe({ 2: 'smart' }, START + 3 * MIN + 3000);
    const before = f.verify(c, START + 3 * MIN), after = f.verify(d, START + 3 * MIN + 2000);
    assert.equal(before.modeCheck.outcome, 'superseded');
    assert.equal(after.modeCheck.outcome, 'confirmed');
    assert.ok(after.modeCheck.sendId > before.modeCheck.sendId);
});

const externalEvents = call => call.sent.map(m => m[5]?.event).filter(e => e?.rule === 'hp_external_change');

test('Node 16-compatible telemetry reaches the controller and credits the latest matching SET', () => {
    const f = fixture();
    const file = '34 Heat pump state.js';
    const runState = runInNewContext(`delete Array.prototype.findLast;
        (function (msg, node, context, flow, Date, setTimeout) { ${readSource(file)} })`);
    const state = loadNode(file, 'return runState(msg, node, context, flow, Date, setTimeout);',
        f.heat.flow, { runState });
    const report = (value, now) => state.run({ topic: 'hp', payload: { data: { dps: { 2: value } } } }, { now });
    report('smart', START);
    f.enqueue(START + 1000, { shadow: { writer: 'heat' } });
    f.enqueue(START + 3000, { shadow: { writer: 'kick' } });
    report('mute', START + 4000);
    assert.equal(f.heat.flow.get('heatPump').hp.dps[2], 'mute');
    assert.equal(f.heat.flow.get('hpWriteAttribution').dps[2].lastWriter, 'kick');
    assert.deepEqual(externalEvents(f.tick(START + 5000)), []);
});

test('only observed changes without matching dispatched SETs enter the alert digest', () => {
    const f = fixture();
    f.observe({ 2: 'smart', 121: 3, 132: '1', 133: 23, 134: 7 }, START);
    assert.deepEqual(externalEvents(f.tick(START + 1000)), [], 'initial telemetry is a baseline');
    const writes = [
        [2, 'mute', 'kick'], [121, 4, 'heat'], [132, '0', 'recovery'], [133, 24, 'dhw'], [134, 8, 'protection']
    ];
    for (const [i, [dp, value, writer]] of writes.entries()) {
        const t = START + 4000 + i * 2000;
        const call = f.enqueue(t, { dps: dp, set: value, shadow: { writer } });
        const tags = call.sent.map(m => m[5]?.event).find(e => e?.kind === 'dispatch');
        assert.deepEqual([tags?.writer, tags?.values], [writer, { [dp]: value }]);
        f.observe({ [dp]: dp === 132 ? 0 : value }, t + 1000);
    }
    assert.deepEqual(externalEvents(f.tick(START + 15000)), [], 'fresh matching read-backs are local');
    assert.equal(f.mail(START + 3 * MIN), null);
    const at = START + 4 * MIN;
    f.observe({ 2: 'smart', 121: 3, 132: 1, 133: 23, 134: 7, 102: 38 }, at);
    f.observe({ 2: 'mute' }, at + 1000);
    const events = externalEvents(f.tick(at + 2000));
    assert.deepEqual(events.map(e => [e.dp, e.old, e.value, e.t]), [
        ['2', 'mute', 'smart', at], ['121', '4', '3', at], ['132', '0', '1', at],
        ['133', '24', '23', at], ['134', '8', '7', at], ['2', 'smart', 'mute', at + 1000]
    ], 'a consumed SET cannot explain a later transition; two reports between ticks are retained');
    for (const event of events) f.alerts.run({ event }, { now: at + 2000 });
    const digest = JSON.parse(f.mail(at + 3 * MIN).payload).text;
    assert.match(digest, /\d\d:\d\d\s+DP 2 \(mode\) changed mute → smart — changed outside Node-RED \(app \/ cloud \/ pump\)/);
    assert.match(digest, /P24 changed 8 → 7/);
});

test('mismatch mail names the requesting writer and the last observed writer, not the queue owner', () => {
    const f = fixture();
    f.observe({ 2: 'smart' }, START);
    f.enqueue(START + 1000, { set: 'strong', shadow: { writer: 'protection' } });
    f.observe({ 2: 'strong' }, START + 2000);
    const t = START + 4000;
    const call = f.enqueue(t, { shadow: { writer: 'kick' } });
    f.observe({ 2: 'strong' }, t + 1000);
    assert.equal(f.verify(call, t).modeCheck.outcome, 'fresh mismatch');
    const digest = JSON.parse(f.mail(t + 3 * MIN).payload).text;
    assert.match(digest, /requesting writer: kick; last writer: protection/);
});

test('queued and expired SETs cannot explain reported changes', () => {
    const f = fixture();
    f.observe({ 2: 'smart' }, START);
    f.heat.context.set('queue', [{ role: 'hp', dps: 2, set: 'mute', rule: 'heat', text: 'mode Silent' }]);
    f.observe({ 2: 'mute' }, START + 1000);
    const sentAt = START + 2000;
    f.enqueue(sentAt, { set: 'smart' });
    f.observe({ 2: 'smart' }, sentAt + CHECK + 1);
    const events = externalEvents(f.tick(sentAt + CHECK + 2000));
    assert.deepEqual(events.map(e => [e.old, e.value]), [['smart', 'mute'], ['mute', 'smart']]);
});

test('untagged writes use the rule label rather than a guessed recovery writer', () => {
    const f = fixture();
    const call = f.enqueue(START + 1000, { rule: 'future-rule', force: true });
    const tag = call.sent.map(m => m[5]?.event).find(e => e?.kind === 'dispatch');
    assert.equal(tag?.writer, 'future-rule');
});

test('telemetry bursts keep recent changes and report overflow if ticks stall', () => {
    const f = fixture();
    f.observe({ 2: 'mute' }, START);
    for (let i = 1; i <= 52; i++) f.observe({ 2: i % 2 ? 'smart' : 'mute' }, START + i);
    const events = externalEvents(f.tick(START + 1000));
    assert.equal(events.length, 50);
    assert.match(events[0].text, /overflow: omitted 3 earlier changes/);
    assert.equal(events[0].t, START + 1);
    assert.equal(events[1].t, START + 4);
    assert.equal(events.at(-1).t, START + 52);
    assert.deepEqual(externalEvents(f.tick(START + 2000)), []);
});

test('unexplained changes deduplicate in the existing digest and respect its send gap', () => {
    const f = fixture();
    const change = (value, at) => f.observe({ 2: value }, at);
    const deliver = t => {
        const events = externalEvents(f.tick(t));
        for (const event of events) assert.equal(f.alerts.run({ event }, { now: t }).result, null);
    };
    change('mute', START);
    change('smart', START + 1000);
    change('mute', START + 2000);
    change('smart', START + 3000);
    deliver(START + 4000);
    assert.equal(f.mail(START + MIN), null);
    const first = START + 3 * MIN;
    assert.match(JSON.parse(f.mail(first).payload).text, /changed mute → smart .*×2/);
    change('mute', START + 4 * MIN);
    deliver(START + 4 * MIN);
    assert.equal(f.mail(first + 14 * MIN), null);
    assert.match(JSON.parse(f.mail(first + 15 * MIN).payload).text, /changed smart → mute/);
});

test('three unsuccessful ordinary SETs pause retries, but not DHW or protection writes', () => {
    const f = fixture();
    for (let i = 1; i <= 3; i++) {
        const now = START + i * MIN;
        assert.equal(f.verify(f.enqueue(now), now).modeCheck.outcome, 'no fresh DP 2');
    }
    assert.deepEqual(setMessages(f.enqueue(START + 4 * MIN)), []);
    for (const [i, options] of [[5, { rule: 'dhw' }], [6, { protection: true }], [7, { rule: 'dhw' }], [8, { protection: true }]]) {
        const now = START + i * MIN;
        assert.equal(setMessages(f.enqueue(now, options)).length, 1);
    }
    assert.deepEqual(setMessages(f.enqueue(START + 32 * MIN)), []);
    assert.equal(setMessages(f.enqueue(START + 34 * MIN)).length, 1);

    const g = fixture();
    for (let i = 1; i <= 3; i++) g.verify(g.enqueue(START + i * MIN), START + i * MIN);
    assert.equal(setMessages(g.enqueue(START + 4 * MIN, { set: 'smart' })).length, 1);
    assert.equal(setMessages(g.enqueue(START + 5 * MIN)).length, 1, 'changing intent discards the old retry budget');
});

test('the 9/19-minute cached-mode repro sends one digest, not a second at minute 27', () => {
    const f = fixture({ heat: { kickMin: 0 }, heatCurve: { p23: 23, p24: 7 }, dhw: { showerForce: false } });
    f.observe({ 2: 'smart' }, START);
    const writes = [], mails = [], outcomes = [];
    for (let t = START; t <= START + 28 * MIN; t += 10000) {
        f.observe({ 1: true, 15: 0, 101: 33, 102: 38, 103: 4, 104: 60, 108: 48, 112: 4, 115: 69, 116: 596,
            123: 28, 125: 36, 132: '1', 133: 23, 134: 7 }, t);
        f.observe({ 1: false }, t, 'valve');
        f.observe({ 1: false }, t, 'bypass');
        const call = f.tick(t);
        if (setMessages(call).length) {
            writes.push((t - START) / MIN);
            call.timers.find(timer => timer.ms === 1500).cb();
            outcomes.push(f.verify(call, t).modeCheck?.outcome);
        }
        if (t % MIN === 0 && f.mail(t)) mails.push((t - START) / MIN);
    }
    assert.deepEqual(writes, [9, 19]);
    assert.deepEqual(mails, [12]);
    assert.deepEqual(outcomes, ['no fresh DP 2', 'no fresh DP 2']);
});

test('HP-P1: three cached mismatches and a forced-cycle cancellation still mail the safety stop', () => {
    const f = fixture();
    f.observe({ 2: 'smart' }, START);
    for (let i = 1; i <= 3; i++) {
        const t = START + i * 30000;
        const event = f.verify(f.enqueue(t, { rule: 'dhw' }), t);
        assert.equal(event.modeCheck.outcome, 'no fresh DP 2');
        assert.doesNotMatch(event.text, /reports smart/);
    }
    assert.match(JSON.parse(f.mail(START + 4 * MIN).payload).text, /no fresh DP 2/);
    const t = START + 20 * MIN, run = 'forced-cycle';
    const fourth = f.enqueue(t, { rule: 'dhw', run });
    f.heat.context.set('dhw', { ...f.heat.context.get('dhw'), state: 'DHW', live: true, run, showerStart: { type: 'manual' } });
    f.heat.run({ topic: 'ui', payload: { action: 'dhwForceRun', on: false } }, { now: t + 1000 });
    assert.equal(f.verify(fourth, t).modeCheck.outcome, 'superseded');
    assert.ok(!f.heat.context.get('modeRetry'));
    const safety = f.tick(t + 20000).sent.map(m => m[5]?.event)
        .find(event => event?.text.includes('forced cycle safety stop pending'));
    assert.ok(safety, 'invalid telemetry still emits the DHW safety-stop alert');
    f.alerts.run({ event: safety }, { now: t + 20000 });
    const digest = JSON.parse(f.mail(t + 3 * MIN).payload).text;
    assert.match(digest, /forced cycle safety stop pending/);
    assert.doesNotMatch(digest, /superseded|no fresh DP 2/);
});

test('mode incident gets one counted reminder, and a fresh match clears it for a new incident', () => {
    const f = fixture();
    const failure = (now, wanted = 'mute') => f.alerts.run({ event: { kind: 'fail', text: 'mode ' + wanted + ' — fresh mismatch',
        modeCheck: { device: 'hp', dp: '2', wanted, sentAt: now - CHECK, outcome: 'fresh mismatch' } } }, { now });
    failure(START);
    const first = START + 3 * MIN;
    assert.ok(f.mail(first));
    failure(START + 20 * MIN);
    assert.equal(f.mail(START + 23 * MIN), null);
    const due = first + 360 * MIN;
    f.mail(due);
    assert.match(JSON.parse(f.mail(due + 2 * MIN).payload).text, /Reminder: .*2 failures/);
    assert.equal(f.mail(due + 6 * 60 * MIN + 3 * MIN), null);
    f.observe({ 2: 'mute' }, due + 4 * MIN);
    f.mail(due + 4 * MIN);
    f.observe({ 2: 'smart' }, due + 20 * MIN);
    failure(due + 21 * MIN);
    const reopened = JSON.parse(f.mail(due + 24 * MIN).payload).text;
    assert.match(reopened, /mode mute — fresh mismatch/);
    assert.doesNotMatch(reopened, /Reminder/);
});
