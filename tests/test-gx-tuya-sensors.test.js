'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, readSource } = require('./harness');

const NOW = Date.parse('2026-11-16T19:00:00Z');
const DAY = 24 * 3600000;
// Routing IDs recognized by 44 and 46; the stub supplies all readings and never runs either exec.
const ACC = 'bfe0dd97b76a98f454a8bt';
const PLATE = 'bfe949ce996182ffb9b1zl';

function fixture({ cloudEnabled = false } = {}) {
    const state = loadNode('34 Heat pump state.js');
    const cloudFile = '44 Heat pump cloud sensors.js';
    const cloud = loadNode(cloudFile, cloudEnabled
        ? readSource(cloudFile).replace('const CLOUD_ENABLED = false;', 'const CLOUD_ENABLED = true;')
        : undefined);
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
        seedCloud: (role, temp) => state.run({ topic: role, payload: { data: { dps: { temp } }, source: 'cloud' } }, { now: NOW }),
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
    gx.seedCloud('acc', 24);
    gx.local(reading(PLATE, NOW, { temp: 33 }));
    assert.equal(gx.summary().accTemp, 24);
    assert.deepEqual(gx.pollCloud(NOW + 1000), [[{ topic: 'acc', payload: { state: 'DISCONNECTED' } }], null]);
    assert.equal(gx.summary().accTemp, null);
    assert.equal(gx.summary().plateTemp, 33);
    assert.equal(gx.pollCloud(NOW + 2000), null, 'no repeat disconnect or exec request');
    gx.local(reading(ACC, NOW + 3000, { bat: 90 }), NOW + 3000);
    assert.equal(gx.summary().accTemp, null, 'a local battery report must not expose the dropped cloud temperature');
});

test('cloud failure and missing devices leave the corresponding temperatures unavailable', () => {
    for (const payload of ['', '{"ok":', '{"ok":false,"error":"synthetic timeout"}',
        '{"ok":true,"devices":{}}']) {
        const gx = fixture({ cloudEnabled: true });
        gx.cloud(JSON.stringify({ ok: true, devices: { [ACC]: { temp: 24 }, [PLATE]: { temp: 33 } } }));
        assert.equal(gx.summary().accTemp, 24);
        assert.equal(gx.summary().plateTemp, 33);
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

test('TGX7-CLOUD-LATE: cloud off drops late replies without overwriting local readings', () => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24 }));
    assert.equal(gx.pollCloud(NOW + 1000), null);
    gx.cloud(JSON.stringify({ ok: true, t: NOW - 2 * DAY, devices: { [ACC]: { temp: 8 } } }), NOW + 2000);
    assert.equal(gx.summary().accTemp, 24);
    assert.equal(gx.state('acc').source, 'local');
    assert.equal(gx.cloud('{"ok":false,"error":"synthetic timeout"}', NOW + 3000), null);
    assert.equal(gx.state('acc').state, 'CONNECTED');
});

test('TGX7-LOCAL-AGE: a battery-only wake does not refresh an expired temperature', () => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24, bat: 91 }));
    const later = NOW + DAY + 1000;
    gx.refreshView(later);
    assert.equal(gx.summary().accTemp, null);
    gx.local(reading(ACC, later, { bat: 88 }), later);
    assert.equal(gx.state('acc').dps.bat, 88);
    assert.equal(gx.state('acc').lastData, later);
    assert.equal(gx.summary().accTemp, null);
    gx.local(reading(ACC, later + 1000, { temp: 0 }), later + 1000);
    assert.equal(gx.summary().accTemp, 0);
    assert.equal(gx.state('acc').dps.bat, 88);
});

test('TGX7-LOCAL-NULL: a null line does not prevent the next reading in a chunk', () => {
    const gx = fixture();
    gx.local(reading(ACC, NOW, { temp: 24 }));
    gx.local('null\n' + reading(ACC, NOW + 1000, { temp: 25 }), NOW + 1000);
    assert.equal(gx.summary().accTemp, 25);
});
