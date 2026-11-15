#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ORIGIN = 'https://nett.elvenett.no';
const oslo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});
const round = (v) => v === null ? null : Math.round(v * 1000) / 1000;

function localTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid interval timestamp');
    const p = Object.fromEntries(oslo.formatToParts(date).map(part => [part.type, part.value]));
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour;
}

function monthStart(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must be YYYY-MM');
    // Find midnight in Oslo, including the CET/CEST offset, without using the host timezone.
    let ts = Date.parse(month + '-01T00:00:00Z');
    for (let i = 0; i < 2; i++) {
        const local = localTime(ts).replace(' ', 'T') + ':00:00Z';
        ts -= Date.parse(local) - Date.parse(month + '-01T00:00:00Z');
    }
    return new Date(ts).toISOString();
}

function nextMonth(month) {
    const date = new Date(month + '-01T12:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString().slice(0, 7);
}

function finite(v, name) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid ' + name);
    return v;
}

function readings(data, name) {
    if (!data || !Array.isArray(data.intervalReadings)) throw new Error('Missing ' + name + ' intervalReadings');
    if (data.unit !== 'WattHours' || !['None', 'Kilo'].includes(data.multiplier)) throw new Error('Unsupported ' + name + ' unit/multiplier');
    const scale = data.multiplier === 'Kilo' ? 1 : 0.001;
    const seen = new Set();
    return data.intervalReadings.map(r => {
        const ts = Date.parse(r.fromDateTime), end = Date.parse(r.toDateTime);
        if (!Number.isFinite(ts) || !(end > ts) || seen.has(ts)) throw new Error('Invalid or duplicate ' + name + ' interval');
        seen.add(ts);
        return { ...r, ts, end, local: localTime(ts), kwh: finite(r.value, name + ' value') * scale };
    });
}

function inPeriod(date, start, end) {
    return Date.parse(date) <= start && (!end || start < Date.parse(end));
}

function capacityTier(tariffs, timestamp, kw) {
    if (kw === null) return null;
    const tariff = tariffs.find(t => inPeriod(t.validFrom, timestamp, t.validTo));
    if (!tariff) return null;
    if (tariff.unit !== 'Watt' || !['None', 'Kilo'].includes(tariff.multiplier)) throw new Error('Unsupported tariff unit');
    const scale = tariff.multiplier === 'Kilo' ? 1 : 0.001;
    const tiers = tariff.tiers.filter(t => ['Hour', 'QuarterHour'].includes(t.priceResolution)).sort((a, b) => a.fromPower - b.fromPower);
    const index = tiers.findIndex(t => kw >= t.fromPower * scale && kw < t.toPower * scale);
    if (index < 0) return null;
    const tier = tiers[index];
    const period = tier.pricePeriods.find(p => inPeriod(p.validFrom, timestamp, p.validTo));
    return {
        step: index + 1, fromKW: tier.fromPower * scale, toKW: tier.toPower * scale,
        price: period ? finite(period.price, 'tariff price') : null, currency: tariff.currencyCode, priceResolution: tier.priceResolution
    };
}

function summarize(raw) {
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.periods) || !Array.isArray(raw.tariffs)) throw new Error('Invalid Elvenett raw archive');
    const warnings = [...(raw.warnings || [])];
    const expenses = new Map();
    const months = raw.periods.map(p => {
        const from = Date.parse(p.from), to = Date.parse(p.to);
        const energy = readings(p.consumption, 'consumption').filter(r => r.ts >= from && r.ts < to);
        const peaks = p.peakHours ? readings(p.peakHours, 'peak hours').filter(r => r.ts >= from && r.ts < to) : [];
        const official = p.peakMonth ? readings(p.peakMonth, 'monthly peak') : [];
        const energyByTime = new Map(energy.map(r => [r.ts, r]));
        const daily = new Map();
        let gridKWh = 0, nightKWh = 0, maxRawKW = null, coveredHours = 0;
        const quality = {};
        for (const r of energy) {
            const hours = (r.end - r.ts) / 3600000;
            if (hours !== 1) throw new Error('Consumption is not hourly');
            gridKWh += r.kwh;
            coveredHours += hours;
            if (Number(r.local.slice(11)) >= 22 || Number(r.local.slice(11)) < 6) nightKWh += r.kwh;
            maxRawKW = Math.max(maxRawKW === null ? -Infinity : maxRawKW, r.kwh / hours);
            quality[r.quality || 'Unknown'] = (quality[r.quality || 'Unknown'] || 0) + 1;
        }
        for (const r of peaks) {
            if (r.end - r.ts !== 3600000) throw new Error('Peak values are not hourly');
            const day = r.local.slice(0, 10);
            // /peak-power values already include effectFactor. Never multiply by 0.7 again.
            if (!daily.has(day) || daily.get(day).capacityKW < r.kwh) {
                daily.set(day, {
                    at: r.fromDateTime, local: r.local, capacityKW: r.kwh,
                    rawKW: energyByTime.has(r.ts) ? energyByTime.get(r.ts).kwh : null,
                    effectFactor: r.effectFactor, selectedByPortal: r.isEffectPeak
                });
            }
        }
        const top3 = [...daily.values()].sort((a, b) => b.capacityKW - a.capacityKW).slice(0, 3);
        const computedCapacityKW = top3.length ? top3.reduce((s, r) => s + r.capacityKW, 0) / top3.length : null;
        const monthReading = official.find(r => r.local.slice(0, 7) === p.month);
        const capacityKW = monthReading ? monthReading.kwh : null;
        if (capacityKW !== null && computedCapacityKW !== null && Math.abs(capacityKW - computedCapacityKW) > 0.01) {
            warnings.push(p.month + ': official capacity differs from the top-three hourly calculation');
        }
        let cost = null, costIncludingVat = null;
        for (const c of p.costs || []) {
            if (c.currencyCode === null) {
                warnings.push(p.month + ': cost series has no currency; amounts are unavailable, not zero');
                continue;
            }
            if (c.currencyCode !== 'NOK' || !Array.isArray(c.costs)) throw new Error('Invalid costs response');
            for (const r of c.costs) {
                const ts = Date.parse(r.fromDate);
                if (ts >= from && ts < to) {
                    cost = (cost === null ? 0 : cost) + finite(r.cost, 'cost');
                    costIncludingVat = (costIncludingVat === null ? 0 : costIncludingVat) + finite(r.costIncludingVat, 'costIncludingVat');
                }
            }
        }
        for (const e of p.expenses || []) {
            if (e.currencyCode !== 'NOK' || !Array.isArray(e.expenseRows)) throw new Error('Invalid expenses response');
            for (const row of e.expenseRows) {
                if (!/^\d{4}-\d{2}$/.test(row.period)) throw new Error('Invalid expense period');
                // The API may return an earlier settled billing period, not the requested month.
                expenses.set(row.period, row);
            }
        }
        let priceAvg = null, priceMin = null, priceMax = null;
        if (p.spotPrices) {
            if (p.spotPrices.currencyCode !== 'NOK' || !Array.isArray(p.spotPrices.prices)) throw new Error('Invalid spot prices response');
            const prices = p.spotPrices.prices.filter(r => Date.parse(r.fromDate) >= from && Date.parse(r.fromDate) < to);
            let weighted = 0, duration = 0;
            for (const r of prices) {
                const value = finite(r.price, 'spot price');
                const hours = (Date.parse(r.toDate) - Date.parse(r.fromDate)) / 3600000;
                if (!(hours > 0)) {
                    warnings.push(p.month + ': ignored a zero/invalid-duration spot price; retained in the raw archive');
                    continue;
                }
                weighted += value * hours; duration += hours;
                priceMin = Math.min(priceMin === null ? Infinity : priceMin, value);
                priceMax = Math.max(priceMax === null ? -Infinity : priceMax, value);
            }
            if (duration) priceAvg = weighted / duration;
        }
        const production = p.production ? readings(p.production, 'production').filter(r => r.ts >= from && r.ts < to).reduce((s, r) => s + r.kwh, 0) : null;
        return {
            month: p.month, from: p.from, to: p.to,
            complete: from === Date.parse(monthStart(p.month)) && to === Date.parse(monthStart(nextMonth(p.month))) && coveredHours === (to - from) / 3600000,
            hours: coveredHours, expectedHours: (to - from) / 3600000, days: new Set(energy.map(r => r.local.slice(0, 10))).size,
            gridKWh: round(gridKWh), dayKWh: round(gridKWh - nightKWh), nightKWh: round(nightKWh), productionKWh: round(production),
            maxRawKW: round(maxRawKW), capacityKW: round(capacityKW), computedCapacityKW: round(computedCapacityKW),
            tier: capacityTier(raw.tariffs, from, capacityKW), top3, quality,
            cost: round(cost), costIncludingVat: round(costIncludingVat),
            spotAvg: round(priceAvg), spotMin: round(priceMin), spotMax: round(priceMax),
            errors: p.errors || []
        };
    }).sort((a, b) => a.month.localeCompare(b.month));
    const byMonth = new Map(months.map(m => [m.month, m]));
    for (const m of months) {
        m.expenses = expenses.get(m.month) || null;
        const previousDate = new Date(m.month + '-01T12:00:00Z');
        previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
        const previous = byMonth.get(previousDate.toISOString().slice(0, 7));
        m.capacityChangeKW = previous && m.capacityKW !== null && previous.capacityKW !== null ? round(m.capacityKW - previous.capacityKW) : null;
        m.energyChangePct = previous && previous.gridKWh > 0 && m.complete && previous.complete
            ? round((m.gridKWh / previous.gridKWh - 1) * 100) : null;
        const lastYear = byMonth.get((Number(m.month.slice(0, 4)) - 1) + m.month.slice(4));
        m.yearEnergyChangePct = lastYear && lastYear.gridKWh > 0 && m.complete && lastYear.complete
            ? round((m.gridKWh / lastYear.gridKWh - 1) * 100) : null;
    }
    if (!months.some(m => m.hours)) throw new Error('Elvenett returned no consumption statistics');
    return {
        schemaVersion: 1, source: ORIGIN, updated: raw.updated, from: raw.from, to: raw.to,
        warnings, hours: months.reduce((s, m) => s + m.hours, 0), months: months.reverse(),
        expensePeriods: [...expenses.values()].sort((a, b) => b.period.localeCompare(a.period))
    };
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

async function collect(session, options) {
    if (!session || session.origin !== ORIGIN || !session.token || !session.customerId || !session.deliveryPointId) {
        throw new Error('Session needs origin https://nett.elvenett.no, token, customerId and deliveryPointId');
    }
    const realm = session.realm || 'Dso';
    const root = '/api/v1/' + encodeURIComponent(realm);
    const customer = root + '/customers/' + encodeURIComponent(session.customerId);
    const point = customer + '/delivery-points/' + encodeURIComponent(session.deliveryPointId);
    const get = async (urlPath, query, optional) => {
        const url = new URL(urlPath, ORIGIN);
        url.search = new URLSearchParams(query || {}).toString();
        const response = await fetch(url, {
            headers: { Authorization: 'Bearer ' + session.token }, redirect: 'error', signal: AbortSignal.timeout(60000)
        });
        if (!response.ok) {
            if (optional && ![401, 403, 429].includes(response.status)) return { unavailable: true, status: response.status };
            throw new Error('Elvenett GET ' + urlPath.split('/').pop() + ' HTTP ' + response.status + (response.status === 401 ? ': sign in again and renew the private session' : ''));
        }
        try { return await response.json(); } catch { throw new Error('Elvenett returned invalid JSON for ' + urlPath.split('/').pop()); }
    };
    const [points, contracts, tariffs] = await Promise.all([
        get(customer + '/delivery-points'), get(customer + '/contracts', { includeInActiveContracts: true }),
        get(point + '/peak-power/tariffs')
    ]);
    const selected = points.find(p => p.recordId === session.deliveryPointId);
    if (!selected) throw new Error('Selected delivery point does not belong to this account');
    const relevant = contracts.filter(c => c.deliveryPointRecordId === selected.recordId && ['Power', 'Net', 'Energy'].includes(c.type));
    if (!relevant.length) throw new Error('No electricity contract for the selected delivery point');
    const start = options.from ? monthStart(options.from) : relevant.map(c => c.startDateTime).sort()[0];
    const to = options.to ? monthStart(options.to) : new Date().toISOString();
    if (!(Date.parse(to) > Date.parse(start))) throw new Error('--to must be after --from (exclusive end)');
    const raw = { schemaVersion: 1, updated: new Date().toISOString(), from: start, to, periods: [], tariffs, points, contracts, warnings: [] };
    const currentMonth = localTime(Date.now()).slice(0, 7);
    for (let month = localTime(start).slice(0, 7); monthStart(month) < to; month = nextMonth(month)) {
        const from = new Date(Math.max(Date.parse(start), Date.parse(monthStart(month)))).toISOString();
        const end = new Date(Math.min(Date.parse(to), Date.parse(monthStart(nextMonth(month))))).toISOString();
        const active = relevant.filter(c => Date.parse(c.startDateTime) < Date.parse(end) && (!c.endDateTime || Date.parse(c.endDateTime) > Date.parse(from)));
        if (!active.length) continue;
        const query = { fromDateTime: from, toDateTime: end, resolution: 'Hour' };
        const errors = [];
        const optional = async (label, urlPath, q) => {
            const data = await get(urlPath, q, true);
            if (data.unavailable) { errors.push(label + ': unavailable (HTTP ' + data.status + ')'); return null; }
            return data;
        };
        const consumption = await get(point + '/metering-values/Consumption', { ...query, unit: 'WattHours', contractType: active[0].type });
        const lastReading = consumption.intervalReadings && consumption.intervalReadings.at(-1);
        const peakTo = lastReading ? new Date(Math.min(Date.parse(end), Date.parse(lastReading.toDateTime))).toISOString() : end;
        // Current-month metering can lag. The peak API fails on the unrecorded tail.
        const [peakHours, peakMonth, costs, expenseRows, spotPrices, production] = await Promise.all([
            optional('Peak hours', point + '/peak-power', { ...query, toDateTime: peakTo }),
            optional('Monthly capacity', point + '/peak-power', { ...query, resolution: 'Month' }),
            Promise.all(active.map(c => optional('Costs', customer + '/contracts/' + encodeURIComponent(c.recordId) + '/costs', { ...query, directionOfFlow: 'Consumption' }))),
            Promise.all(active.map(c => optional('Expenses', customer + '/contracts/' + encodeURIComponent(c.recordId) + '/expenses', { fromDateTime: from, toDateTime: end }))),
            selected.energyInstallation.priceAreaConsumption ? optional('Spot prices', root + '/spot-prices/' + encodeURIComponent(selected.energyInstallation.priceAreaConsumption), query) : null,
            (selected.energyInstallation.energyReadTypes || []).some(t => t.directionOfFlow === 'Production')
                ? optional('Production', point + '/metering-values/Production', { ...query, unit: 'WattHours', contractType: active[0].type }) : null
        ]);
        raw.periods.push({ month, from, to: end, consumption, peakHours, peakMonth,
            costs: costs.filter(Boolean), expenses: expenseRows.filter(Boolean), spotPrices, production, errors });
        if (options.raw) writeJson(options.raw, raw);
        if (!options.quiet) console.error(month + (month === currentMonth ? ' (partial)' : '') + ': ' + consumption.intervalReadings.length + ' hours' + (errors.length ? '; ' + errors.join('; ') : ''));
    }
    return raw;
}

function argumentsFor(args) {
    const command = args.shift();
    if (!['fetch', 'read'].includes(command)) throw new Error('Usage: node tools\\elvenett-statistics.js fetch --session FILE --raw FILE --output FILE [--from YYYY-MM --to YYYY-MM] | read --raw FILE [--output FILE]');
    const options = {};
    while (args.length) {
        const flag = args.shift();
        if (!['--session', '--raw', '--output', '--from', '--to'].includes(flag) || !args.length || args[0].startsWith('--')) throw new Error('Invalid option ' + flag);
        options[flag.slice(2)] = args.shift();
    }
    if (!options.raw || (command === 'fetch' && (!options.session || !options.output))) throw new Error('--raw is required; fetch also needs --session and --output');
    return { command, options };
}

async function main(args) {
    const { command, options } = argumentsFor(args);
    const loadJson = file => {
        const text = fs.readFileSync(file, 'utf8');
        try { return JSON.parse(text); } catch { throw new Error('Invalid JSON file: ' + path.basename(file)); }
    };
    const raw = command === 'fetch' ? await collect(loadJson(options.session), options) : loadJson(options.raw);
    const summary = summarize(raw);
    if (options.output) writeJson(options.output, summary);
    console.table(summary.months.map(m => ({
        month: m.month + (m.complete ? '' : '*'), hours: m.hours, kWh: m.gridKWh,
        kapasitetKW: m.capacityKW, top3KW: m.computedCapacityKW, step: m.tier ? m.tier.step : null,
        changeKW: m.capacityChangeKW, energyChangePct: m.energyChangePct
    })));
    for (const warning of summary.warnings) console.error('WARNING: ' + warning);
}

module.exports = { localTime, monthStart, nextMonth, readings, capacityTier, summarize, collect, argumentsFor };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
});
