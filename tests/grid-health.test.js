'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('./harness');
const { gridHeartbeat, gridP95 } = new Function(
    'gridClock', 'flow', 'node', 'context', 'setInterval',
    readSource('64 Grid loop health.init.js') + '\nreturn { gridHeartbeat, gridP95 };'
 )({ hrtime: { bigint: () => 0n } }, {}, {}, {}, () => {});

test('heartbeat alarms at ten seconds, clears on a pulse, and rate-limits another incident', () => {
    let result = gridHeartbeat({}, 0, 9999);
    assert.equal(result.silent, false);
    result = gridHeartbeat(result, 0, 10000);
    assert.equal(result.notify, true);
    result = gridHeartbeat(result, 0, 50000);
    assert.equal(result.notify, false);
    result = gridHeartbeat(result, 50001, 50001);
    assert.equal(result.silent, false);
    result = gridHeartbeat(result, 50001, 60001);
    assert.equal(result.notify, false);
    assert.equal(gridHeartbeat(result, 50001, 910000).notify, true);
});

test('p95 uses nearest rank without mutating timer samples', () => {
    const samples = [650, ...Array(18).fill(12), 40];
    assert.equal(gridP95(samples), 40);
    assert.equal(samples[0], 650);
    assert.equal(gridP95([]), null);
});
