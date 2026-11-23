#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = process.env.VICTRON_LOG_DIR || '/data/home/nodered/grid-control-logs';
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function local(t) {
    const p = Object.fromEntries(clock.formatToParts(t).map((p) => [p.type, p.value]));
    return { day: p.year + '-' + p.month + '-' + p.day, sec: +p.hour * 3600 + +p.minute * 60 + +p.second,
        time: p.hour + ':' + p.minute + ':' + p.second };
}
function validateDay(day) {
    const d = new Date(day + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new Error('Invalid calendar day');
    return day;
}
function optional(file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function listing(dir) {
    try { return fs.readdirSync(dir); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function jsonLines(text, diagnostics) {
    const rows = [];
    for (const line of (text || '').split(/\r?\n/).filter((s) => s.trim())) {
        try { rows.push(JSON.parse(line)); }
        catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
            diagnostics.invalidRows++;
        }
    }
    return rows;
}
const timestamp = (t) => Number.isFinite(t) && t > 0 && t <= 8640000000000000;
// d#201: the Temperatures page shows room sensors only; pump, water, outdoor, tank, supply and return stay on the Heat Pump page
// The Devices model calls this same predicate when building the temperature catalog.
const NON_ROOM_IDS = ['hp', 'acc', 'plate'];
const isRoomSensorKey = (key) => typeof key === 'string' && !NON_ROOM_IDS.includes(key.split(':')[0]);
const colors = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22'];
function build(day, catalog, samples, reports, available, days, invalidRows = 0) {
    validateDay(day);
    const buckets = new Map(), seen = new Set();
    const sensors = new Map((catalog.sensors || []).filter((s) => isRoomSensorKey(s.key)).map((s) => [s.key, { ...s, samples: 0 }]));
    for (const s of samples) {
        if (s && typeof s.key === 'string' && !isRoomSensorKey(s.key)) continue;
        if (!s || typeof s.key !== 'string' || !s.key || !Number.isFinite(s.value) ||
            (s.sec === undefined ? !timestamp(s.t) : !Number.isFinite(s.sec) || s.sec < 0 || s.sec >= 86400)) {
            invalidRows++;
            continue;
        }
        const c = Number.isFinite(s.sec) ? { day, sec: s.sec } : local(s.t);
        if (c.day !== day || c.sec < 0 || c.sec >= 86400) continue;
        const identity = s.key + ':' + (s.t || s.sec) + ':' + s.value;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (!sensors.has(s.key)) sensors.set(s.key, { key: s.key, name: s.name || s.key, value: null, online: false,
            source: s.source || 'temperature log (catalog entry unavailable)', samples: 0 });
        sensors.get(s.key).samples++;
        const list = buckets.get(s.key) || new Map();
        const i = Math.floor(c.sec / 120);
        const b = list.get(i) || { sum: 0, n: 0 };
        b.sum += s.value; b.n++;
        list.set(i, b); buckets.set(s.key, list);
    }
    let lo = Infinity, hi = -Infinity;
    for (const list of buckets.values()) for (const b of list.values()) { lo = Math.min(lo, b.sum / b.n); hi = Math.max(hi, b.sum / b.n); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 50; }
    lo = Math.floor(lo / 10) * 10; hi = Math.max(lo + 10, Math.ceil(hi / 10) * 10);
    const x = (sec) => +(40 + sec / 86400 * 708).toFixed(2);
    const y = (v) => +(235 - (v - lo) / (hi - lo) * 225).toFixed(2);
    const series = [...buckets].map(([key, list], index) => {
        const points = [...list].sort((a, b) => a[0] - b[0]).map(([i, b]) => ({
            x: x(i * 120 + 60), y: y(b.sum / b.n), value: +(b.sum / b.n).toFixed(2),
            time: String(Math.floor(i / 30)).padStart(2, '0') + ':' + String(i % 30 * 2).padStart(2, '0')
        }));
        const lines = []; let line = [];
        for (const p of points) {
            if (line.length && p.x - line.at(-1).x > 708 * 300 / 86400) { if (line.length > 1) lines.push(line.map((v) => v.x + ',' + v.y).join(' ')); line = []; }
            line.push(p);
        }
        if (line.length > 1) lines.push(line.map((v) => v.x + ',' + v.y).join(' '));
        return { key, name: sensors.get(key).name, color: colors[index % colors.length], points, lines };
    });
    const ticks = [];
    for (let value = lo; value <= hi; value += 10) ticks.push({ value, y: y(value) });
    const hours = Array.from({ length: 9 }, (_, i) => ({ x: x(i * 10800), label: String(i * 3).padStart(2, '0') + ':00' }));
    const motionSeen = new Set(), events = [];
    const validReports = reports.filter((r) => {
        if (r && timestamp(r.t) && typeof r.id === 'string' && r.id && r.dps && typeof r.dps === 'object' && !Array.isArray(r.dps)) return true;
        invalidRows++;
        return false;
    });
    for (const r of validReports.sort((a, b) => a.t - b.t)) {
        if (r.id !== catalog.motionId || !['local', 'cloud report'].includes(r.source) || !r.dps || !['pir', 'none'].includes(r.dps['101'])) continue;
        const c = local(r.t), key = r.t + ':' + r.dps['101'];
        if (c.day !== day || motionSeen.has(key)) continue;
        motionSeen.add(key);
        events.push({ x: x(c.sec), y: r.dps['101'] === 'pir' ? 20 : 55, motion: r.dps['101'] === 'pir', time: c.time, source: r.source });
    }
    return { day, days: [...new Set([day, ...days])].sort().reverse(), series, ticks, hours,
        sensors: [...sensors.values()], invalidRows,
        motion: { available, targetKnown: !!catalog.motionId, count: events.filter((e) => e.motion).length, events } };
}
function read(day, dir = DIR) {
    validateDay(day);
    const catalogText = optional(path.join(dir, 'temperatures', 'catalog.json'));
    const catalog = catalogText ? JSON.parse(catalogText) : { sensors: [], motionId: '' };
    if (!catalog.updated || Date.now() - Date.parse(catalog.updated) > 6 * 60000) {
        for (const s of catalog.sensors) s.online = false;
    }
    const diagnostics = { invalidRows: 0 };
    const recorded = jsonLines(optional(path.join(dir, 'temperatures', day + '.jsonl')), diagnostics);
    const samples = [];
    for (const line of (optional(path.join(dir, 'air', day + '.csv')) || '').split(/\r?\n/).filter(Boolean)) {
        const cols = line.split(','), parts = cols[0].split(':').map(Number);
        if (!/^\d{2}:\d{2}:\d{2}$/.test(cols[0]) || parts[0] >= 24 || parts[1] >= 60 || parts[2] >= 60 ||
            (cols[5] !== undefined && cols[5] !== '' && !Number.isFinite(Number(cols[5])))) {
            diagnostics.invalidRows++;
            continue;
        }
        if (cols[5] !== undefined && cols[5] !== '') samples.push({ key: 'air-monitor:Temperature', name: 'Air monitor / Temperature',
            value: Number(cols[5]), sec: parts[0] * 3600 + parts[1] * 60 + parts[2], source: 'air recorder' });
    }
    const eventsText = optional(path.join(dir, 'sensor-events', day + '.jsonl'));
    const days = ['temperatures', 'air', 'sensor-events'].flatMap((folder) => listing(path.join(dir, folder)))
        .map((f) => /^(\d{4}-\d{2}-\d{2})(?:\.(?:jsonl|csv))?$/.exec(f)).filter(Boolean).map((m) => m[1]);
    const archiveKeys = new Set(samples.map((s) => s.key));
    samples.push(...recorded.filter((s) => !s || !archiveKeys.has(s.key)));
    return build(day, catalog, samples, jsonLines(eventsText, diagnostics), eventsText !== null, days, diagnostics.invalidRows);
}
function prune(dir = DIR, now = Date.now()) {
    const cutoff = local(now - 400 * 86400000).day, folder = path.join(dir, 'temperatures');
    let pruned = 0;
    for (const file of listing(folder)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!match || match[1] >= cutoff) continue;
        const date = new Date(match[1] + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) continue;
        const full = path.join(folder, file);
        if (!fs.lstatSync(full).isFile()) continue;
        fs.unlinkSync(full);
        pruned++;
    }
    return { pruned, keepDays: 400 };
}
module.exports = { build, read, prune, validateDay, isRoomSensorKey };
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length === 1 && args[0] === '--prune') console.log(JSON.stringify(prune()));
        else {
            if (args.length !== 2 || args[0] !== '--day') throw new Error('Usage: sensor-history.js --day YYYY-MM-DD | --prune');
            console.log(JSON.stringify(read(args[1])));
        }
    } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; }
}
