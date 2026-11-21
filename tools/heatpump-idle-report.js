#!/usr/bin/env node
// Idle periods of the heat pump from the recorder files (36, format hp1): every stretch where the compressor is off
// (DP 115 = 0) and the pump is neither in a DHW cycle (valve relay) nor in a defrost / bypass. The cause is derived with
// the same order as `idleClassify` in lib/heat-pump/idle.js, from the recorded values only.
//
//   node tools/heatpump-idle-report.js <heatpump dir> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--min <seconds>]
//
// <heatpump dir> = a copy of /data/home/nodered/grid-control-logs/heatpump (day folders with HH.csv[.gz]).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decode } = require('./heatpump-decode');

const DEFROST_QUIET_MIN = 15, HEAT_WINDOW_MIN = 10, GAP_S = 90;
const CAUSES = { 1: 'stale', 2: 'pumpOff', 3: 'fault', 4: 'ctrlOff', 5: 'defrost', 6: 'dhwEnd', 7: 'point', 8: 'hyst', 9: 'below' };

// same order as idleClassify (lib/heat-pump/idle.js); the controller mode is not recorded, so no `ctrlOff` here
function classify(i) {
    const fin = (v) => Number.isFinite(v);
    if (i.pumpOn === false) return 2;
    if (i.fault > 0) return 3;
    if (fin(i.defrostMin) && i.defrostMin < DEFROST_QUIET_MIN) return 5;
    if (fin(i.dhwEndMin) && i.dhwEndMin < HEAT_WINDOW_MIN) return 6;
    if (fin(i.sup) && fin(i.set) && i.sup >= i.set) return 7;
    if (fin(i.sup) && fin(i.set) && fin(i.hyst) && i.sup > i.set - i.hyst) return 8;
    return 9;
}

// the pump stops on its own curve (P23 / P24 at the outdoor value), not on the reported DP 125
function pumpSet(r, out) { return Number.isFinite(r.p23) && Number.isFinite(r.p24) && Number.isFinite(out) ? Math.max(20, Math.min(60, 20 + r.p24 / 10 * (r.p23 - out))) : r.set; }

function readText(file) {
    const buf = fs.readFileSync(file);
    return (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

function* samples(dir, from, to) {
    const days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!from || d >= from) && (!to || d <= to)).sort();
    for (const day of days) {
        const files = fs.readdirSync(path.join(dir, day)).filter((f) => /^\d{2}\.csv(\.gz)?$/.test(f)).sort();
        const hours = new Map();
        for (const f of files) hours.set(f.slice(0, 2), f);
        for (const f of hours.values()) {
            for (const r of decode(readText(path.join(dir, day, f)), f, () => {})) {
                if (!r.time) continue;
                const num = (k) => (r.values[k] === '' || r.values[k] === undefined ? NaN : Number(r.values[k]));
                const st = (r.cells[0] || '').toString();
                yield { s: Date.parse(r.time.replace(' ', 'T')) / 1000, time: r.time, day, ok: (r.values.st || '').charAt(0) === 'C',
                    hz: num('115'), fan: num('116'), v1: num('v1'), b1: num('b1'), sup: num('102'), out: num('103'), set: num('125'), hyst: num('121'),
                    p23: num('133'), p24: num('134'), fault: num('15'), pump: r.values['1'], mode: r.values['2'], tank: num('108'), st };
            }
        }
    }
}

function report(dir, opts) {
    const periods = [];
    let cur = null, lastDefrost = -Infinity, lastDhw = -Infinity, prev = null, lastOut = NaN;
    const close = () => { if (cur) { periods.push(cur); cur = null; } };
    for (const r of samples(dir, opts.from, opts.to)) {
        if (prev && r.s - prev.s > GAP_S) close();
        prev = r;
        if (!r.ok) { close(); continue; }
        const defr = r.fan === 0 && r.hz > 30;
        if (defr) lastDefrost = r.s;
        if (r.v1 === 1) lastDhw = r.s;
        // DP 103 is only the air temperature while the compressor runs outside a defrost and its quiet time
        if (r.hz > 0 && !defr && r.s - lastDefrost >= DEFROST_QUIET_MIN * 60 && Number.isFinite(r.out)) lastOut = r.out;
        const idle = r.hz === 0 && r.v1 !== 1 && r.b1 !== 1 && !defr;
        if (!idle) { close(); continue; }
        const code = classify({ pumpOn: r.pump === '' ? undefined : r.pump === '1' || r.pump === 'true', fault: r.fault || 0,
            defrostMin: (r.s - lastDefrost) / 60, dhwEndMin: (r.s - lastDhw) / 60, sup: r.sup, set: pumpSet(r, lastOut), hyst: r.hyst });
        if (!cur) cur = { start: r.time, startS: r.s, endS: r.s, n: 0, outSum: 0, outN: 0, supStart: r.sup, set: Math.round(pumpSet(r, lastOut) * 10) / 10, hyst: r.hyst, mode: r.mode, causes: {}, day: r.day };
        cur.endS = r.s + 30; cur.n++;
        cur.supEnd = r.sup;
        if (Number.isFinite(r.out)) { cur.outSum += r.out; cur.outN++; }
        cur.causes[CAUSES[code]] = (cur.causes[CAUSES[code]] || 0) + 30;
    }
    close();
    return periods.filter((p) => p.endS - p.startS >= opts.min).map((p) => {
        const main = Object.entries(p.causes).sort((a, b) => b[1] - a[1])[0][0];
        return { day: p.day, start: p.start.slice(11, 16), minutes: Math.round((p.endS - p.startS) / 60 * 10) / 10, outdoor: p.outN ? Math.round(p.outSum / p.outN * 10) / 10 : null,
            supplyStart: p.supStart, supplyEnd: p.supEnd, set: p.set, hyst: p.hyst, mode: p.mode, cause: main, causes: p.causes };
    });
}

function group(periods) {
    const g = {};
    for (const p of periods) { const x = g[p.cause] || (g[p.cause] = { cause: p.cause, count: 0, minutes: 0 }); x.count++; x.minutes += p.minutes; }
    return Object.values(g).map((x) => Object.assign(x, { minutes: Math.round(x.minutes) })).sort((a, b) => b.minutes - a.minutes);
}

module.exports = { classify, report, group };

if (require.main === module) {
    const a = process.argv.slice(2);
    const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
    const dir = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--from' && a[a.indexOf(x) - 1] !== '--to' && a[a.indexOf(x) - 1] !== '--min');
    if (!dir) { console.error('usage: node tools/heatpump-idle-report.js <heatpump dir> [--from D] [--to D] [--json] [--min s]'); process.exit(2); }
    const periods = report(dir, { from: opt('--from'), to: opt('--to'), min: Number(opt('--min', 60)) });
    if (a.includes('--json')) console.log(JSON.stringify({ periods, groups: group(periods) }, null, 1));
    else {
        for (const p of periods) console.log(`${p.day} ${p.start} ${String(p.minutes).padStart(5)} min  out ${p.outdoor}  supply ${p.supplyStart}→${p.supplyEnd}  set ${p.set}  hyst ${p.hyst}  mode ${p.mode}  ${p.cause} ${JSON.stringify(p.causes)}`);
        console.log('\ncause        periods  minutes');
        for (const g of group(periods)) console.log(g.cause.padEnd(12), String(g.count).padStart(7), String(g.minutes).padStart(8));
    }
}
