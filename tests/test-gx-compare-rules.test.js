'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyStartLog, classifyStateFiles, PALETTE_DISCOVERY } = require('../tools/test-gx/compare-rules.js');

const POLL = '[info] [victron-client] Polling is disabled. This is the recommended configuration.';
const UNKNOWN = 'DBUS ERROR MESSAGE org.freedesktop.DBus.Error.UnknownObject';

test('one start: UnknownObject right after "Polling is disabled" is expected', () => {
    const r = classifyStartLog(['Started flows', POLL, UNKNOWN]);
    assert.deepStrictEqual(r.unknown, []);
    assert.strictEqual(r.known.get(PALETTE_DISCOVERY), 1);
});

test('two starts: both UnknownObject lines are expected', () => {
    const r = classifyStartLog([POLL, UNKNOWN, 'Started flows', POLL, '', UNKNOWN]);
    assert.deepStrictEqual(r.unknown, []);
    assert.strictEqual(r.known.get(PALETTE_DISCOVERY), 2);
});

test('UnknownObject elsewhere is an unknown error', () => {
    const r = classifyStartLog([POLL, UNKNOWN, UNKNOWN]);
    assert.strictEqual(r.known.get(PALETTE_DISCOVERY), 1);
    assert.strictEqual(r.unknown.length, 1);
    assert.strictEqual(classifyStartLog([UNKNOWN]).unknown.length, 1);
});

test('known and unknown errors are told apart', () => {
    const r = classifyStartLog(['[error] Error in setValue: No services available yet', '[error] TypeError: boom']);
    assert.strictEqual(r.known.get('D-Bus service not up yet'), 1);
    assert.deepStrictEqual(r.unknown, ['[error] TypeError: boom']);
});

test('whitespace-only lines between "Polling is disabled" and UnknownObject are skipped', () => {
    const r = classifyStartLog([POLL, '   ', '\t', UNKNOWN]);
    assert.deepStrictEqual(r.unknown, []);
    assert.strictEqual(r.known.get(PALETTE_DISCOVERY), 1);
});

test('Tuya "Key is missing or incorrect" is expected, counted per line', () => {
    const line = '[error] [tuya-smart-device:Heat pump] Key is missing or incorrect';
    const r = classifyStartLog([line, line]);
    assert.deepStrictEqual(r.unknown, []);
    assert.strictEqual(r.known.get('Tuya devices have fake keys'), 2);
});

test('only a successful internal MQTT connection may interleave D-Bus discovery', () => {
    const connected = '15 Nov 21:10:21 - [info] [mqtt-broker:GX broker (local)] Connected to broker: mqtt://mosquitto:1883';
    const r = classifyStartLog([POLL, connected, UNKNOWN, 'Started flows', POLL, connected, UNKNOWN]);
    assert.deepStrictEqual(r.unknown, []);
    assert.strictEqual(r.known.get(PALETTE_DISCOVERY), 2);
    for (const intervening of [
        connected.replace('mosquitto:1883', '192.168.1.94:1883'),
        connected.replace('mosquitto:1883', 'other:1883'),
        connected.replace('[info]', '[error]'),
        connected.replace('Connected', 'Disconnected'),
        'some unrelated log line',
    ]) {
        assert.ok(classifyStartLog([POLL, intervening, UNKNOWN]).unknown.includes(UNKNOWN));
    }
    assert.ok(classifyStartLog([connected, UNKNOWN]).unknown.includes(UNKNOWN), 'MQTT alone is not D-Bus discovery');
});

test('state files: known names are expected, others stay a warning', () => {
    const r = classifyStateFiles(['grid-control-config/tuya-devices-ver.json', 'grid-control-config/controller-constants.json']);
    assert.deepStrictEqual(r.expected, ['grid-control-config/tuya-devices-ver.json']);
    assert.deepStrictEqual(r.warn, ['grid-control-config/controller-constants.json']);
});
