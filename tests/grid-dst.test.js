'use strict';
process.env.TZ = 'Europe/Oslo';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadNode } = require('./harness');

function controller(at, watts) {
    const node = loadNode('01 Battery + Grid Controller.js');
    const run = (now, topic = 'test-tick', payload) => node.run({ topic, payload }, { now }).result;
    run(at, 'battery-voltage', 53);
    run(at, 'battery-consumed-ah', 0);
    run(at, 'grid-power', watts);
    return run;
}

test('Oslo October fold starts a new budget and restores both billable hours from CSV', () => {
    const first = '2026-10-25T02:00:00+02:00';
    const second = '2026-10-25T02:00:00+01:00';
    const after = '2026-10-25T03:00:00+01:00';
    const run = controller(first, 1200);
    run('2026-10-25T02:59:57+02:00');
    const fold = run(second, 'grid-power', 2400);
    assert.equal(fold[4].payload.hourKey, '2026-10-25 02');
    assert.equal(fold[4].payload.gridWh, 1199);
    assert.equal(fold[5].payload.hourBudget.hourKey, '2026-10-25 02+0100');
    assert.equal(fold[5].payload.hourBudget.usedWh, 0);
    run('2026-10-25T02:59:57+01:00');
    const next = run(after);
    assert.equal(next[4].payload.hourKey, '2026-10-25 02+0100');
    assert.equal(next[4].payload.gridWh, 2398);
    const assertTariff = ({ tariff }) => {
        assert.equal(tariff.todayGridWh, 3597);
        assert.equal(tariff.todayPeakBillableWh, 1679);
        assert.equal(tariff.todayPeakHourKey, '2026-10-25 02+0100');
        assert.deepEqual(tariff.monthTopPeaksWh, [1679]);
        assert.equal(tariff.monthTrackedDays, 1);
    };
    assertTariff(next[5].payload);
    const writer = loadNode('19 Format hourly energy line.js');
    const csv = [fold[4], next[4]].map(msg => writer.run({ ...msg }).result.csvRow).join('\n');
    assert.match(csv, /^2026-10-25 02\+0100,2398,/m);
    assertTariff(controller(after, 0)(after, 'tariff-history', csv)[5].payload);

    const summary = loadNode('17 Update daily summary.js');
    const restore = now => summary.run({ topic: 'tariff-history', payload: csv }, { now }).result[1].summary;
    assert.deepEqual(restore(second).hours.map(row => row.hour), ['02:00']);
    assert.deepEqual(restore(after).hours.map(row => row.hour), ['02:00', '02:00 +0100']);
    assert.equal(restore(after).totalGrid, 3597);
    const widgets = loadNode('14 Build dashboard hourly widgets.js');
    const report = widgets.run({ topic: 'selected-day-summary-file', payload: csv }, { now: after }).result;
    assert.match(report[1].payload, /Hours 2\/25 \| Grid 3597Wh/);
});

test('Oslo March gap closes 01 and starts 03 without inventing a budget for 02', () => {
    const run = controller('2026-03-29T01:00:00+01:00', 1200);
    run('2026-03-29T01:59:57+01:00');
    const gap = run('2026-03-29T03:00:00+02:00');
    assert.equal(gap[4].payload.hourKey, '2026-03-29 01');
    assert.equal(gap[5].payload.hourBudget.hourKey, '2026-03-29 03');
    assert.equal(gap[5].payload.hourBudget.usedWh, 0);
    assert.equal(gap[5].payload.tariff.todayGridWh, 1199);
    assert.equal(gap[5].payload.tariff.todayPeakHourKey, '2026-03-29 01');
});
