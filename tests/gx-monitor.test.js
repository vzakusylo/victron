'use strict';
// The monitor's judgement on states seen on the GX on 14 Nov 2026 and on the failures it must catch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, format, tai64nMs } = require('../tools/gx/monitor.js');

const MIN = 60000;
const NOW = new Date(2026, 10, 14, 20, 30).getTime();

// Healthy GX as read at 20:30: heating in Silent on the curve, DHW idle.
function healthy() {
    return {
        now: NOW,
        service: { up: true, seconds: 21300 },
        flow: { label: 'd#180 Day / Night Grid Control [git 97c023b52bca]', source: '{"dashboard":"x","automations":"x"}', rev: 'r' },
        devices: { hp: { state: 'CONNECTED', lastData: NOW - 5000 }, valve: { state: 'CONNECTED', lastData: NOW - 5000 },
            bypass: { state: 'CONNECTED', lastData: NOW - 5000 }, meter: { state: 'DISCONNECTED', lastData: 0 } },
        hp: { on: true, mode: 'mute', fault: 0, ret: 32, supply: 37, outdoor: -2, tank: 42, hz: 69, fan: 596 },
        dhw: { state: 'HEATING', since: NOW - 30 * MIN, startAt: NOW - 40 * MIN, why: 'last cycle 20 min ago (min 1 h)', outAvg: -2, running: false },
        settings: { master: true, modes: { dhw: 'live', heat: 'live' }, dhwBlock: null },
        view: { at: NOW - 4000, heat: { pumpMode: 'Silent', boost: 0, target: 36, lag: 0.8, why: 'collecting data' } },
        logErrors: [{ source: '[tuya-smart-device:SA1 power meter (heat pump)]', count: 4 }],
        events: []
    };
}
const levelOf = (result, check) => result.checks.filter((c) => c.check === check).map((c) => c.level);

test('monitor: a healthy GX is OK and the never-connected SA1 meter is not an error', () => {
    const result = evaluate(healthy());
    assert.equal(result.status, 'OK');
    assert.equal(result.exitCode, 0);
    assert.match(format(result), /Node-RED log\s+no errors.*known: 4 x .*SA1 power meter/);
    assert.match(format(result), /STATUS: OK$/);
});

test('monitor: right after a deploy "no outdoor value yet" is information, not a warning', () => {
    const input = healthy();
    input.service.seconds = 120;
    input.dhw = { state: 'HEATING', since: NOW - 2 * MIN, why: 'no outdoor value yet; defrost now or < 15 min ago', outAvg: null, running: false };
    const result = evaluate(input);
    assert.equal(result.status, 'OK');
    assert.deepEqual(levelOf(result, 'DHW'), ['INFO']);
    assert.deepEqual(levelOf(result, 'service'), ['INFO']);
});

test('monitor: the Er03 abort of 19:56 - DHW blocked is FAIL until allowed again, then the logged abort stays a WARN', () => {
    const input = healthy();
    const at = NOW - 34 * MIN;
    input.settings.dhwBlock = { at, why: 'fault Er03 (water flow)' };
    input.events = [{ t: at, kind: 'error', rule: 'hp_fault', text: 'Er03 (water flow failure) appeared' },
        { t: at, kind: 'stop', rule: 'dhw', text: 'end of DHW (fault Er03 (water flow))' }];
    let result = evaluate(input);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.exitCode, 2);
    assert.match(format(result), /FAIL\s+DHW\s+blocked since .*fault Er03 \(water flow\) - allow DHW again/);

    input.settings.dhwBlock = null;
    result = evaluate(input);
    assert.equal(result.status, 'WARN');
    assert.match(format(result), /WARN\s+automation log\s+1 error\(s\), 1 aborted DHW cycle\(s\)/);
});

test('monitor: a stale or disconnected device, a pump fault and a stopped service are FAIL', () => {
    let input = healthy();
    input.devices.valve.lastData = NOW - 9 * MIN;
    assert.deepEqual(levelOf(evaluate(input), 'device valve'), ['FAIL']);

    input = healthy();
    input.devices.bypass.lastData = 0;   // connected, but nothing received yet: the automations treat it as stale
    assert.match(format(evaluate(input)), /FAIL\s+device bypass\s+connected, no data yet/);

    input = healthy();
    input.devices.hp.state = 'DISCONNECTED';
    assert.deepEqual(levelOf(evaluate(input), 'device hp'), ['FAIL']);

    input = healthy();
    input.hp.fault = 1;
    assert.match(format(evaluate(input)), /FAIL\s+heat pump\s+fault code 1 \(Er03 water flow\)/);

    const down = evaluate({ now: NOW, service: { up: false, seconds: 0 } });
    assert.equal(down.status, 'FAIL');
    assert.deepEqual(levelOf(down, 'service'), ['FAIL']);
});

test('monitor: automations that stopped ticking and a DHW cycle that never ends are FAIL', () => {
    let input = healthy();
    input.view.at = NOW - 6 * MIN;
    assert.deepEqual(levelOf(evaluate(input), 'automations'), ['FAIL']);

    input = healthy();
    input.dhw = { state: 'DHW', since: NOW - 170 * MIN, startAt: NOW - 175 * MIN, why: 'DHW: tank 40 → 48', outAvg: -2, running: true };
    assert.deepEqual(levelOf(evaluate(input), 'DHW'), ['FAIL']);

    input.dhw.startAt = NOW - 20 * MIN; input.dhw.since = NOW - 15 * MIN;
    assert.deepEqual(levelOf(evaluate(input), 'DHW'), ['INFO'], 'an ordinary running cycle is information');
});

test('monitor: controllers not On, master off, a cold tank, new log errors and a missing source label are WARN', () => {
    const input = healthy();
    input.settings = { master: false, modes: { dhw: 'dry', heat: 'off' }, dhwBlock: null };
    input.hp.tank = 36;
    input.flow.source = null;
    input.logErrors.push({ source: '[function:Heat pump automations]', count: 2 });
    const result = evaluate(input);
    assert.equal(result.status, 'WARN');
    for (const check of ['local control', 'heating', 'tank', 'version', 'Node-RED log']) assert.deepEqual(levelOf(result, check), ['WARN'], check);
    assert.ok(levelOf(result, 'DHW').includes('WARN'));
    assert.match(format(result), /2 x \[function:Heat pump automations\]/);
});

test('monitor: log times come from the multilog TAI64N stamp, not from the local text date', () => {
    // a line of the GX log: the text says 18:31:02 (local, CET), the stamp is 17:31:02 UTC
    const line = '@400000006af89ae01f481074 14 Nov 18:31:02 - [error] [tuya-smart-device:Heating pump] connectDevice()';
    assert.equal(new Date(tai64nMs(line)).toISOString(), '2026-11-14T17:31:02.000Z');
    assert.equal(tai64nMs('14 Nov 18:31:02 - [error] no stamp'), null);
});