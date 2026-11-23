'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('./harness');

function helpers() {
    return new Function(readSource('lib/grid/dashboard.js') +
        '\nreturn { gridDashboardStatus, gridDashboardOutput };')();
}

test('grid status is change-only and never publishes faster than two seconds', () => {
    const { gridDashboardStatus } = helpers();
    const snapshot = { reason: 'Day tariff schedule', arrivals: [1000, null] };
    const first = gridDashboardStatus(undefined, snapshot, 0, 1000);
    assert.deepEqual(first.message.payload.arrivals, [1000, null]);
    assert.equal(gridDashboardStatus(first.state, snapshot, 2500, 3500).message, null);
    const changed = { ...snapshot, reason: 'Export guard' };
    assert.equal(gridDashboardStatus(first.state, changed, 1999, 2999).message, null);
    assert.equal(gridDashboardStatus(first.state, changed, 2000, 3000).message.payload.reason, 'Export guard');
});

test('read-back mismatch remains visible during a same-target retry and clears on a new target', () => {
    const { gridDashboardOutput } = helpers();
    const first = gridDashboardOutput(undefined, undefined, { phase: 'pending', value: 1100 }, { payload: 1100 }, 1000, 0);
    const retry = gridDashboardOutput(first, { phase: 'reading', value: 1100, reading: { value: 1000 } },
        { phase: 'pending', value: 1100, retried: true }, { payload: 1100 }, 2000, 0);
    assert.deepEqual(retry, { value: 1100, sentAt: 2000, phase: 'pending', fault: '', read: { value: 1000, state: 'Mismatch' } });
    const next = gridDashboardOutput(retry, { phase: 'verified', value: 1100 },
        { phase: 'pending', value: 1200 }, { payload: 1200 }, 3000, 0);
    assert.equal(next.read, null);
});
