'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');
const MIN = 60000;
const NOW = new Date(2026, 10, 13, 12, 0).getTime();

function controller({ now = NOW, usage, lastVisit } = {}) {
    const node = loadNode('40 Heat pump automations.js');
    const saved = { master: true, modes: { dhw: 'live', heat: 'off', df_exchange_off: 'off', df_exchange_on: 'off', hp_er03_restart: 'off' },
        dhw: { showerForce: false }, heatCurve: { p23: 38, p24: 4, at: now - 3600000 }, dhwLastEnd: now - 5 * MIN };
    if (usage !== undefined) saved.dhwUsage = usage;
    if (lastVisit !== undefined) saved.dhwUsageLastVisit = lastVisit;
    node.run({ topic: 'load', payload: JSON.stringify(saved) }, { now });
    const d = node.context.get('dhw');
    Object.assign(d, { state: 'HEATING', since: now - 3600000, outAvg: 1, outS: [[now - MIN, 1]], lastEnd: now - 5 * MIN });
    node.context.set('lastDefrost', now - 3600000);
    node.context.set('shower', { samples: [[now - 2 * MIN, 50], [now - MIN, 50]],
        lastValve: false, valveAt: now - 10 * MIN, episode: null, demand: null, dropC: null });
    function tick(t, tank = 50, motionAt = null) {
        if (motionAt !== null) node.flow.set('bathroomMotion', { source: 'local', value: 'pir', t: motionAt, seen: motionAt, lastMotionAt: motionAt });
        node.flow.set('heatPump', {
            hp: { state: 'CONNECTED', lastData: t, dps: { 1: true, 2: 'mute', 15: 0, 101: 32, 102: 35, 103: 1, 104: 60, 108: tank, 112: 3,
                115: 60, 116: 550, 125: 35, 132: '1', 133: 38, 134: 4 } },
            valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
        });
        return node.run({ topic: 'tick' }, { now: t });
    }
    const settings = () => node.context.get('settings');
    const today = () => settings().dhwUsage[Object.keys(settings().dhwUsage).sort().pop()];
    return { node, tick, settings, today };
}

test('PIR reports closer than 5 minutes count as one toilet visit', () => {
    const c = controller();
    c.tick(NOW, 50, NOW - 1000);
    c.tick(NOW + MIN, 50, NOW + 30000);          // same visit
    c.tick(NOW + 7 * MIN, 50, NOW + 7 * MIN);     // new visit
    assert.equal(c.today().visits, 2);
});

test('a restart does not count the same motion report again', () => {
    const c = controller({ lastVisit: NOW - 1000 });
    c.tick(NOW, 50, NOW - 1000);
    assert.equal(c.settings().dhwUsage[Object.keys(c.settings().dhwUsage)[0]]?.visits || 0, 0);
});

test('cloud or future motion is not counted', () => {
    const c = controller();
    c.node.flow.set('bathroomMotion', { source: 'cloud', value: 'pir', t: NOW, lastMotionAt: NOW - 1000 });
    c.tick(NOW);
    c.tick(NOW + MIN, 50, NOW + 10 * MIN);
    assert.deepEqual(c.settings().dhwUsage || {}, {});
});

test('a tank drop of at least 2 C after motion counts as a draw with motion', () => {
    const c = controller();
    c.tick(NOW, 50, NOW - 1000);
    c.tick(NOW + MIN, 49);
    c.tick(NOW + 2 * MIN, 47.5);
    c.tick(NOW + 3 * MIN, 47);                    // same episode: counted once
    const day = c.today();
    assert.equal(day.draws, 1);
    assert.equal(day.drawsWithMotion, 1);
    assert.equal(day.dropC, 2.5);
    assert.equal(day.hours[new Date(NOW + MIN).getHours()], 1);
});

test('a draw without recent motion is counted but not as motion-linked', () => {
    const c = controller();
    c.node.flow.set('bathroomMotion', { source: 'local', value: 'none', t: NOW - 3600000, lastMotionAt: NOW - 3600000 });
    c.tick(NOW);
    c.tick(NOW + MIN, 48);
    const day = c.today();
    assert.equal(day.draws, 1);
    assert.equal(day.drawsWithMotion, 0);
});

test('a small tank wobble is not a draw', () => {
    const c = controller();
    c.tick(NOW, 50, NOW - 1000);
    c.tick(NOW + MIN, 49);
    assert.equal(c.today().draws, 0);
});

test('summary reports per-day averages, motion share and the busiest hour', () => {
    const day = (d) => { const t = new Date(NOW); t.setDate(t.getDate() - d);
        return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    const hours = new Array(24).fill(0); hours[7] = 2;
    const c = controller({ usage: {
        [day(0)]: { visits: 6, draws: 2, drawsWithMotion: 1, dropC: 5, hours },
        [day(1)]: { visits: 4, draws: 2, drawsWithMotion: 2, dropC: 3, hours: new Array(24).fill(0) }
    } });
    c.tick(NOW);
    const view = c.node.flow.get('dhwView');
    const usage = view && view.shower ? view.shower.usage : null;
    assert.ok(usage, 'usage summary present in the dashboard model');
    assert.equal(usage.days, 2);
    assert.equal(usage.visitsPerDay, 5);
    assert.equal(usage.drawsPerDay, 2);
    assert.equal(usage.motionShare, 75);
    assert.equal(usage.dropCPerDay, 4);
    assert.equal(usage.peakHour, 7);
});

test('load drops malformed usage days and keeps at most 90 days', () => {
    const usage = { 'bad-key': { visits: 3 }, '2026-11-12': { visits: -1, draws: 2, drawsWithMotion: 5, dropC: 'x', hours: [1] } };
    for (let i = 0; i < 100; i++) usage['2025-' + String(1 + Math.floor(i / 28)).padStart(2, '0') + '-' + String(1 + i % 28).padStart(2, '0')] = { visits: 1 };
    const c = controller({ usage });
    const u = c.settings().dhwUsage;
    assert.equal(Object.keys(u).length, 90);
    assert.ok(!u['bad-key']);
    assert.deepEqual(u['2026-11-12'], { visits: 0, draws: 2, drawsWithMotion: 2, dropC: 0, hours: new Array(24).fill(0) });
});
