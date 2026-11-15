'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, monthStart, nextMonth, readings, argumentsFor } = require('../tools/elvenett-statistics');
const { loadNode } = require('./harness');

const tariff = [{
    validFrom: '2025-01-01T00:00:00Z', validTo: null, unit: 'Watt', multiplier: 'Kilo', currencyCode: 'NOK',
    tiers: [
        { fromPower: 0, toPower: 2, priceResolution: 'Hour', pricePeriods: [{ validFrom: '2025-01-01T00:00:00Z', validTo: null, price: 128 }] },
        { fromPower: 2, toPower: 5, priceResolution: 'Hour', pricePeriods: [{ validFrom: '2025-01-01T00:00:00Z', validTo: null, price: 186 }] },
        { fromPower: 5, toPower: 10, priceResolution: 'Hour', pricePeriods: [{ validFrom: '2025-01-01T00:00:00Z', validTo: null, price: 265 }] }
    ]
}];
function period(month, value) {
    const from = monthStart(month), to = monthStart(nextMonth(month));
    const rows = [];
    for (let t = Date.parse(from); t < Date.parse(to); t += 3600000) {
        rows.push({ fromDateTime: new Date(t).toISOString(), toDateTime: new Date(t + 3600000).toISOString(), value, quality: 'Measured' });
    }
    return { month, from, to, consumption: { unit: 'WattHours', multiplier: 'Kilo', intervalReadings: rows },
        peakHours: null, peakMonth: null, costs: [], expenses: [] };
}
function archive(periods) {
    return { schemaVersion: 1, updated: '2026-11-15T00:00:00Z', from: periods[0].from, to: periods.at(-1).to, periods, tariffs: tariff };
}

test('Oslo month boundaries and duplicate autumn hours are retained independently', () => {
    assert.equal(monthStart('2026-10'), '2026-09-30T22:00:00.000Z');
    assert.equal(monthStart('2026-11'), '2026-10-31T23:00:00.000Z');
    assert.equal(monthStart('2026-04'), '2026-03-31T22:00:00.000Z');
    const a = period('2026-09', 1), b = period('2026-10', 2);
    const [oct, sep] = summarize(archive([a, b])).months;
    assert.equal(oct.hours, 745);
    assert.equal(oct.gridKWh, 1490);
    assert.equal(sep.hours, 720);
    assert.equal(oct.energyChangePct, 106.944);
    const r = readings(b.consumption, 'test').filter(r => r.local === '2026-10-25 02');
    assert.equal(r.length, 2);
});

test('capacity values already include night factor; top-three uses distinct local days and exact tier boundary', () => {
    const p = period('2026-10', 1);
    const row = (at, value, effectFactor) => ({
        fromDateTime: at, toDateTime: new Date(Date.parse(at) + 3600000).toISOString(), value, effectFactor, isEffectPeak: true
    });
    p.peakHours = { unit: 'WattHours', multiplier: 'Kilo', intervalReadings: [
        row('2026-10-01T00:00:00Z', 6, 0.7), row('2026-10-01T01:00:00Z', 5.9, 0.7),
        row('2026-10-02T10:00:00Z', 5, 1), row('2026-10-03T10:00:00Z', 4, 1)
    ] };
    p.peakMonth = { unit: 'WattHours', multiplier: 'Kilo', intervalReadings: [
        { fromDateTime: p.from, toDateTime: p.to, value: 5 }
    ] };
    const m = summarize(archive([p])).months[0];
    assert.equal(m.capacityKW, 5);
    assert.equal(m.computedCapacityKW, 5);
    assert.equal(m.top3.length, 3);
    assert.equal(m.tier.step, 3);
    assert.equal(m.tier.price, 265);
});

test('partial month has no energy comparison; costs keep credits and expenses use their own billing month', () => {
    const a = period('2026-09', 1), b = period('2026-10', 2);
    b.to = b.consumption.intervalReadings[1].toDateTime;
    b.consumption.intervalReadings = b.consumption.intervalReadings.slice(0, 2);
    b.costs = [{ currencyCode: 'NOK', costs: [{ fromDate: b.from, toDate: b.to, cost: -2, costIncludingVat: -2.5 }] }];
    b.expenses = [{ currencyCode: 'NOK', expenseRows: [{ period: '2026-09', totalExpenses: 123, totalExpensesVat: 30.75 }] }];
    b.spotPrices = { currencyCode: 'NOK', prices: [
        { fromDate: b.from, toDate: b.to, price: -0.5 },
        { fromDate: b.from, toDate: b.from, price: 999 }
    ] };
    const result = summarize(archive([a, b])), [oct, sep] = result.months;
    assert.equal(oct.complete, false);
    assert.equal(oct.energyChangePct, null);
    assert.equal(oct.costIncludingVat, -2.5);
    assert.equal(oct.expenses, null);
    assert.equal(sep.expenses.totalExpenses, 123);
    assert.equal(oct.spotAvg, -0.5);
    assert.equal(result.warnings.length, 1);
});

test('invalid input fails explicitly, including units, duplicate timestamps and CLI arguments', () => {
    const p = period('2026-10', 1);
    p.consumption.multiplier = 'Mega';
    assert.throws(() => summarize(archive([p])), /Unsupported consumption/);
    p.consumption.multiplier = 'Kilo';
    p.consumption.intervalReadings.push(p.consumption.intervalReadings[0]);
    assert.throws(() => summarize(archive([p])), /duplicate/);
    assert.throws(() => monthStart('2026-13'), /YYYY-MM/);
    assert.throws(() => argumentsFor(['fetch', '--session']), /Invalid option/);
});

test('provider placeholder costs without a currency remain unavailable rather than becoming zero', () => {
    const p = period('2026-10', 1);
    p.costs = [{ currencyCode: null, costs: [{ fromDate: p.from, toDate: p.to, cost: 0, costIncludingVat: 0 }] }];
    const result = summarize(archive([p]));
    assert.equal(result.months[0].costIncludingVat, null);
    assert.match(result.warnings[0], /not zero/);
});

test('Payback import joins local months without replacing estimated savings, and reports broken imports', () => {
    const n = loadNode('48 Payback model.js');
    const input = '@@CFG\n{}\n@@CSV energy-2026-10.csv\n2026-10-01 10,1000,2000,0,1000\n';
    const initial = n.run({ topic: 'read', payload: input + '@@END' }).result[0].payload;
    const imported = summarize(archive([period('2026-10', 1)]));
    imported.months[0].capacityKW = 4.215;
    const model = n.run({ topic: 'read', payload: input + '@@ELV\n' + JSON.stringify(imported) + '\n@@END' }).result[0].payload;
    assert.equal(model.saved, initial.saved);
    assert.equal(model.elvenett.months[0].localKW, 1);
    assert.equal(model.elvenett.months[0].differenceKW, 3.22);
    const bad = n.run({ topic: 'read', payload: input + '@@ELV\n{bad}\n@@END' });
    assert.match(bad.result[0].payload.error, /Cannot read Elvenett/);
    assert.equal(bad.result[0].payload.elvenett, null);
    assert.equal(bad.warnings.length, 1);
});
