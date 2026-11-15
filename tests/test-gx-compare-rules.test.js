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

test('state files: known names are expected, others stay a warning', () => {
    const r = classifyStateFiles(['grid-control-config/tuya-devices-ver.json', 'grid-control-config/controller-constants.json']);
    assert.deepStrictEqual(r.expected, ['grid-control-config/tuya-devices-ver.json']);
    assert.deepStrictEqual(r.warn, ['grid-control-config/controller-constants.json']);
});
