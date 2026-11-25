'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('./harness');

function helpers() {
    return new Function(readSource('lib/grid/dashboard.js') +
        '\nreturn { gridDashboardStatus, gridDashboardOutput, gridDailyFeedbackAlerts };')();
}

test('daily feedback count resets at Oslo midnight and preserves persisted totals', () => {
    const { gridDailyFeedbackAlerts } = helpers();
    const previous = { day: '2026-03-29', count: 4, total: 17 };
    const beforeMidnight = gridDailyFeedbackAlerts(previous, new Date('2026-03-29T21:59:59Z'), 1);
    assert.deepEqual(beforeMidnight, { day: '2026-03-29', count: 5, total: 18 });
    const afterMidnight = gridDailyFeedbackAlerts(beforeMidnight, new Date('2026-03-29T22:00:00Z'), 1);
    assert.deepEqual(afterMidnight, { day: '2026-03-30', count: 1, total: 19 });
});

test('daily feedback count handles Oslo DST transitions and survives a restart', () => {
    const { gridDailyFeedbackAlerts } = helpers();
    const springDay = gridDailyFeedbackAlerts(
        { day: '2026-03-29', count: 2, total: 8 }, new Date('2026-03-29T21:59:59Z'), 0);
    assert.deepEqual(springDay, { day: '2026-03-29', count: 2, total: 8 });
    const springMidnight = gridDailyFeedbackAlerts(
        springDay, new Date('2026-03-29T22:00:00Z'), 0);
    assert.deepEqual(springMidnight, { day: '2026-03-30', count: 0, total: 8 });
    const autumnDay = gridDailyFeedbackAlerts(
        { day: '2026-10-25', count: 3, total: 11 }, new Date('2026-10-25T22:59:59Z'), 0);
    assert.deepEqual(autumnDay, { day: '2026-10-25', count: 3, total: 11 });
    const autumnMidnight = gridDailyFeedbackAlerts(
        autumnDay, new Date('2026-10-25T23:00:00Z'), 0);
    assert.deepEqual(autumnMidnight, { day: '2026-10-26', count: 0, total: 11 });
    const restarted = gridDailyFeedbackAlerts(
        { day: '2026-10-25', count: 3, total: 11 }, new Date('2026-10-25T12:00:00Z'), 1);
    assert.deepEqual(restarted, { day: '2026-10-25', count: 4, total: 12 });
    const stale = gridDailyFeedbackAlerts(
        { day: '2026-10-24', count: 9, total: 11 }, new Date('2026-10-25T12:00:00Z'), 0);
    assert.deepEqual(stale, { day: '2026-10-25', count: 0, total: 11 });
});

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
