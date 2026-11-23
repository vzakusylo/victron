'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadNode } = require('./harness');

const t0 = Date.UTC(2026, 10, 16, 12);
const serial = 'com.victronenergy.battery.ttyTEST';

function repairHarness(code) {
    const writes = [];
    const watchdog = loadNode('30 BMS watchdog.js', undefined, undefined, { dbus: { systemBus: () => ({
        connection: { on() {}, stream: { destroy() {} } },
        invoke(request, callback) {
            assert.equal(request.member, 'SetValue');
            assert.equal(request.path, '/Settings/SystemSetup/BmsInstance');
            assert.equal(request.signature, 'v');
            writes.push(request.body[0]);
            callback(null, code);
        }
    }) } });
    return { watchdog, writes };
}

test('a serial driver restart sends one repair notification, suppresses repeats and clears the fault on recovery', async () => {
    const { watchdog, writes } = repairHarness(0);
    const call = (seconds, fields) => watchdog.run({
        topic: 'bms-watchdog-exec',
        payload: Object.entries(fields).map(([field, value]) => `@@${field} ${value}`).join('\n')
    }, { now: t0 + seconds * 1000 });
    const report = (seconds, fields) => call(seconds, fields).result;
    const active = { ACTIVE: serial, SETTING: 289, CONNECTED: 1, BATT: serial };
    const [save] = report(0, active);
    assert.equal(save.bmsWatchdogStep, 'save-good');
    assert.deepEqual(report(30, { ACTIVE: '[]', SETTING: -1, GOOD: 289 }), [null, null]);
    const missing = { ...active, ACTIVE: '[]', SETTING: -1, GOOD: 289 };
    assert.deepEqual(report(60, missing), [null, null]);
    const attempt = call(90, missing);
    assert.deepEqual(await attempt.result, [null, null]);
    assert.deepEqual(writes, [['i', 289]]);
    const [[, alert]] = attempt.sent;
    assert.deepEqual(alert.notification, {
        title: 'BMS watchdog', type: 'warning',
        message: 'Controlling BMS was lost (-1); restored automatically to the SerialBattery.'
    });

    for (const seconds of [120, 150, 180]) {
        assert.deepEqual(report(seconds, { ...missing, SETTING: 289 }), [null, null]);
    }
    assert.deepEqual(report(210, { ...active, GOOD: 289 }), [null, null]);
    const state = watchdog.flow.get('bmsWatchdogState');
    assert.equal(state.status, 'ok');
    assert.equal(state.missingCount, 0);
});

test('force restore, failed write and Passthru grace retain their operator messages', async () => {
        const { watchdog, writes } = repairHarness(1);
        const run = (seconds, msg) => watchdog.run(msg, { now: t0 + seconds * 1000 });
        const report = (seconds, payload, bmsWatchdogStep = 'read') =>
            run(seconds, { topic: 'bms-watchdog-exec', bmsWatchdogStep, payload });
        run(0, { topic: 'bms-watchdog-force' });
        const attempt = report(1, `@@ACTIVE []\n@@BATT ${serial}\n@@CONNECTED 1\n@@SETTING -1\n@@GOOD "289"`);
        assert.deepEqual(writes, [['s', '289']]);
        assert.equal(attempt.sent[0][1].notification.type, 'warning');
        assert.deepEqual((await attempt.result)[1].notification, {
            title: 'BMS watchdog', type: 'alarm',
            message: 'Could not restore Controlling BMS automatically. Select it in Settings > System setup > Charge control.'
        });

        const passthru = `@@ACTIVE ${serial}\n@@SETTING 289\n@@GOOD 289\n@@VSTATE 8\n@@BMSLOST 1`;
        assert.deepEqual(report(30, passthru).result, [null, null]);
        assert.deepEqual(report(149, passthru).result, [null, null]);
        assert.deepEqual(report(150, passthru).result[1].notification, {
            title: 'BMS watchdog', type: 'warning',
            message: 'BMS active, but MultiPlus still in Passthru with "BMS connection lost" - restart the VE.Bus system'
        });
        assert.deepEqual(report(180, passthru).result, [null, null]);
});

test('quoted legacy settings compare equal to the current string and do not trigger a repair', () => {
    const { watchdog, writes } = repairHarness(0);
    for (const setting of [serial, '289']) {
        watchdog.flow.set('bmsWatchdogState', { forceRepair: true });
        const call = watchdog.run({
            topic: 'bms-watchdog-exec',
            payload: `@@ACTIVE []\n@@BATT ${serial}\n@@CONNECTED 1\n@@SETTING "${setting}"\n@@GOOD '${setting}'`
        }, { now: t0 });
        assert.deepEqual(call.result, [null, null]);
        assert.match(call.status.text, /already correct/);
    }
    assert.deepEqual(writes, []);
});

test('scheduled watchdog checks use D-Bus and disk with no exec, even when a critical read fails', async () => {
    const { EventEmitter } = require('node:events');
    let closed = 0;
    let failed = false;
    const bus = {
        connection: Object.assign(new EventEmitter(), { stream: { destroy: () => { closed++; } } }),
        listNames: callback => callback(null, [serial]),
        invoke({ destination, path }, callback) {
            if (path === '/Settings/SystemSetup/BmsInstance') {
                assert.equal(destination, 'com.victronenergy.settings');
                return failed ? callback(new Error('settings unavailable')) : callback(null, ['i', [289]]);
            }
            if (path === '/Connected') {
                assert.equal(destination, serial);
                return callback(null, ['i', [1]]);
            }
            assert.equal(path, '/ActiveBmsService');
            callback(null, ['s', [serial]]);
        }
    };
    const watchdog = loadNode('30 BMS watchdog.js', undefined, undefined, {
        dbus: { systemBus: () => bus },
        fs: { promises: { readFile: async () => '289\n' } }
    });
    const check = () => watchdog.run({ topic: 'tick' }, { now: t0 });
    assert.deepEqual(await check().result, [null, null]);
    assert.equal(watchdog.flow.get('bmsWatchdogState').status, 'ok');
    failed = true;
    const fault = check();
    assert.equal(await fault.result, null);
    assert.equal(watchdog.flow.get('bmsWatchdogState').busySince, 0);
    assert.deepEqual(fault.warnings, ['D-Bus did not return BMS status/settings']);
    assert.equal(closed, 2);
});
