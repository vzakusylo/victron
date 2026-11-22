'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const NOW = Date.parse('2026-11-16T19:00:00Z');
const DAY = 24 * 3600000;
// Routing IDs recognized by 44 and 46; the stub supplies all readings and never runs either exec.
const ACC = 'bfe0dd97b76a98f454a8bt';
const PLATE = 'bfe949ce996182ffb9b1zl';

function fixture() {
    const state = loadNode('34 Heat pump state.js');
    const cloud = loadNode('44 Heat pump cloud sensors.js');
    const local = loadNode('46 Heat pump local sensors.js');
    function feed(bridge, topic, payload, now = NOW) {
        bridge.flow.set('heatPump', state.flow.get('heatPump'));
        const { result } = bridge.run({ topic, payload }, { now });
        for (const msg of result?.[0] || []) state.run(msg, { now });
        return result;
    }
    return {
        cloud: (payload, now) => feed(cloud, 'cloud', payload, now),
        pollCloud: now => feed(cloud, 'poll', undefined, now),
        local: (payload, now) => feed(local, 'local', payload, now),
        state: role => state.flow.get('heatPump')?.[role],
        summary: () => state.flow.get('heatPumpModel').summary,
        refreshView: now => state.run({ topic: 'hp', payload: { state: 'DISCONNECTED' } }, { now })
    };
}

function reading(id, t, fields = {}) {
    return JSON.stringify({ kind: 'reading', id, t, ...fields }) + '\n';
}

test('disabled cloud polling drops cached cloud readings but leaves local readings alone', () => {
    const gx = fixture();
    gx.cloud(JSON.stringify({ ok: true, devices: { [ACC]: { temp: 24 } } }));
    gx.local(reading(PLATE, NOW, { temp: 33 }));
    assert.equal(gx.summary().accTemp, 24);
    assert.deepEqual(gx.pollCloud(NOW + 1000), [[{ topic: 'acc', payload: { state: 'DISCONNECTED' } }], null]);
    assert.equal(gx.summary().accTemp, null);
    assert.equal(gx.summary().plateTemp, 33);
    assert.equal(gx.pollCloud(NOW + 2000), null, 'no repeat disconnect or exec request');
});

test('cloud failure and missing devices leave the corresponding temperatures unavailable', () => {
    for (const payload of ['', '{"ok":', '{"ok":false,"error":"synthetic timeout"}',
        '{"ok":true,"devices":{}}']) {
        const gx = fixture();
        gx.cloud(JSON.stringify({ ok: true, devices: { [ACC]: { temp: 24 }, [PLATE]: { temp: 33 } } }));
        const [, exec] = gx.cloud(payload, NOW + 1000);
        assert.equal(exec, null);
        const status = payload.includes('"ok":true') ? 'DISCONNECTED' : 'ERROR';
        assert.equal(gx.state('acc').state, status);
        assert.equal(gx.state('plate').state, status);
        assert.equal(gx.summary().accTemp, null);
        assert.equal(gx.summary().plateTemp, null);
    }
});

test('local stdout chunks keep partial readings, reject stale replies, and expire silent sensors', () => {
    const gx = fixture();
    const line = reading(ACC, NOW, { temp: 24, hum: 52, bat: 91 });
    assert.equal(gx.local(Buffer.from(line.slice(0, 20))), null);
    gx.local(Buffer.from(line.slice(20) + reading(PLATE, NOW, { bat: 83 })));
    assert.equal(gx.summary().accTemp, 24);
    assert.equal(gx.summary().plateTemp, null, 'a wake without a temperature does not create one');
    assert.equal(gx.local(reading(ACC, NOW - 1000, { temp: 3 }) + reading(ACC, NOW, { temp: 4 }), NOW + 1000), null);
    assert.equal(gx.local('not JSON\n' + reading(ACC, 'invalid time', { temp: 5 }), NOW + 2000), null);
    assert.equal(gx.state('acc').lastData, NOW);
    gx.local(reading(ACC, NOW + 3000, { temp: 25, hum: null, bat: null }), NOW + 3000);
    assert.deepEqual(gx.state('acc').dps, { temp: 25, hum: 52, bat: 91 });
    gx.refreshView(NOW + DAY + 3001);
    assert.equal(gx.summary().accTemp, null);
});

test('expected_fail TGX7-CLOUD-LATE: cloud off should not accept a late reply', t => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24 }));
    assert.equal(gx.pollCloud(NOW + 1000), null);
    gx.cloud(JSON.stringify({ ok: true, t: NOW - 2 * DAY, devices: { [ACC]: { temp: 8 } } }), NOW + 2000);
    assert.throws(() => assert.equal(gx.summary().accTemp, 24),
        { code: 'ERR_ASSERTION', actual: 8, expected: 24 }, 'unexpected pass: remove expected_fail TGX7-CLOUD-LATE');
    t.skip('expected_fail: delayed cloud stdout overwrites a local temperature even though polling is disabled');
});

test('expected_fail TGX7-LOCAL-AGE: a battery-only wake must not refresh an expired temperature', t => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24, bat: 91 }));
    const later = NOW + DAY + 1000;
    gx.refreshView(later);
    assert.equal(gx.summary().accTemp, null);
    gx.local(reading(ACC, later, { bat: 88 }), later);
    assert.equal(gx.state('acc').dps.bat, 88);
    assert.throws(() => assert.equal(gx.summary().accTemp, null),
        { code: 'ERR_ASSERTION', actual: 24, expected: null }, 'unexpected pass: remove expected_fail TGX7-LOCAL-AGE');
    t.skip('expected_fail: a battery-only wake makes the last temperature look current again');
});

test('expected_fail TGX7-LOCAL-NULL: a null line must not prevent the next reading in a chunk', t => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24 }));
    assert.throws(() => gx.local('null\n' + reading(ACC, NOW + 1000, { temp: 25 }), NOW + 1000),
        { name: 'TypeError', message: /Cannot read properties of null.*kind/ },
        'unexpected pass: remove expected_fail TGX7-LOCAL-NULL');
    assert.equal(gx.summary().accTemp, 24);
    t.skip('expected_fail: a valid JSON null line throws and drops the subsequent reading');
});
