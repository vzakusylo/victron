#!/usr/bin/env node
// Cloud fallback for the battery sensors of the Smart Life account that can NOT be read on the
// local network: they wake for a few seconds, send their values to the Tuya cloud only and sleep
// again, without a UDP beacon the GX hears (checked d#153: one hour of listening on 6666 / 6667 /
// 7000 and the ARP table while the cloud got new values from stair, stue and vlada; the exchange
// plate sensor was heard in the same hour). Owner rule: local network first, the cloud only where
// local is impossible.
//
// Usage (exec of "Devices model", 50):  node /data/home/nodered/tools/tuya-cloud-sensors.js
// - Runs at most every EVERY_MS (it exits at once otherwise), so about 6 cloud calls per 30 min.
// - Devices: battery devices of grid-control-config/tuya-devices-meta.json (tools/tuya-devices-setup.js)
//   that were online in Smart Life at setup, are not heat pump sensors (34 / 46 read those locally)
//   and have no local reading (tuya-local-sensors-last.json) in the last LOCAL_FRESH_MS.
// - Reads the shadow properties (value + time of each DP) with the credentials of
//   grid-control-config/tuya-cloud.json, writes grid-control-config/tuya-devices-cloud.json
//   { at, error, devices: { id: { t, dps: { dpId: value } } } } (no keys). Never prints secrets.
// - PIR history uses /v2.1/cloud/thing/<id>/report-logs, not device online events:
//   both motion ('pir') and clear ('none') wake the sensor. Actual reports are appended to
//   grid-control-logs/sensor-events/YYYY-MM-DD.jsonl, with source 'cloud report'.
'use strict';
const fs = require('fs'), crypto = require('crypto');

const DIR = '/data/home/nodered/grid-control-config/';
const OUT = DIR + 'tuya-devices-cloud.json';
const EVENT_DIR = process.env.TUYA_EVENT_DIR || '/data/home/nodered/grid-control-logs/sensor-events/';
const EVERY_MS = 30 * 60 * 1000;
const LOCAL_FRESH_MS = 24 * 3600 * 1000;
const HEAT_PUMP_SENSORS = ['Accumulator tank temp', 'Exchange plate'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
setTimeout(() => {
    console.error(JSON.stringify({ kind: 'error', error: 'Tuya sensor read timed out' }));
    process.exit(1);
}, 60000).unref();   // allow the first paginated history read, but never hang the exec

const prev = readJson(OUT, { at: 0, devices: {} });
if (Date.now() - (prev.at || 0) < EVERY_MS && !process.argv.includes('--now')) process.exit(0);
const meta = readJson(DIR + 'tuya-devices-meta.json', {});
const local = readJson(DIR + 'tuya-local-sensors-last.json', {});
const cfg = readJson(DIR + 'tuya-cloud.json', null);

const ids = Object.keys(meta).filter((id) => {
    const m = meta[id] || {};
    const l = local[id];
    return m.battery && !m.node && m.cloudOnline && !HEAT_PUMP_SENSORS.includes(m.name) && !(l && l.t && Date.now() - l.t < LOCAL_FRESH_MS);
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s, key) => crypto.createHmac('sha256', key).update(s).digest('hex').toUpperCase();
async function call(path, token) {
    const t = String(Date.now()), nonce = crypto.randomBytes(8).toString('hex');
    const sign = hmac(cfg.accessId + (token || '') + t + nonce + ['GET', sha256(''), '', path].join('\n'), cfg.accessSecret);
    const headers = { client_id: cfg.accessId, sign, t, nonce, sign_method: 'HMAC-SHA256' };
    if (token) headers.access_token = token;
    const j = await (await fetch(cfg.endpoint.replace(/\/$/, '') + path, { headers, signal: AbortSignal.timeout(10000) })).json();
    if (!j.success) throw new Error(path.split('?')[0].replace(/\/[0-9a-z]{20,}/g, '/<id>') + ': ' + j.code + ' ' + j.msg);
    return j.result;
}

async function recordPirReports(id, dp, from, to, token) {
    const reports = [];
    const cursors = new Set();
    let cursor = '';
    for (let page = 0; ; page++) {
        if (page >= 50) throw new Error('PIR history exceeded 50 pages; cursor not advanced');
        const query = new URLSearchParams({
            codes: 'pir_state', end_time: String(to), size: '100', start_time: String(from)
        });
        if (cursor) query.set('last_row_key', cursor);
        query.sort();
        const result = await call('/v2.1/cloud/thing/' + id + '/report-logs?' + query, token);
        if (!result || !Array.isArray(result.logs)) throw new Error('Invalid PIR history response');
        for (const log of result.logs) {
            const t = Number(log.eventTime ?? log.event_time);
            if (log.code !== 'pir_state') continue;
            if (!Number.isFinite(t) || t <= 0 || log.value === undefined) throw new Error('Invalid PIR report');
            if (t >= from && t <= to) reports.push({ t, id, name: meta[id].name, dps: { [dp]: log.value }, source: 'cloud report' });
        }
        if (!(result.hasMore ?? result.has_more)) break;
        const next = result.lastRowKey || result.last_row_key;
        if (!next || cursors.has(next)) throw new Error('PIR history pagination cursor missing or repeated');
        cursors.add(next);
        cursor = next;
    }
    reports.sort((a, b) => a.t - b.t);
    const days = new Map();
    for (const report of reports) {
        const d = new Date(report.t), pad = (v) => String(v).padStart(2, '0');
        const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(report);
    }
    let written = 0;
    for (const [day, events] of days) {
        const file = EVENT_DIR + day + '.jsonl';
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const eventKey = (e) => JSON.stringify([e.id, e.t, e.source, e.dps]);
        const seen = new Set(text.split(/\r?\n/).filter((line) => line.trim()).map((line) => eventKey(JSON.parse(line))));
        const fresh = [];
        for (const event of events) {
            const key = eventKey(event);
            if (seen.has(key)) continue;
            seen.add(key);
            fresh.push(JSON.stringify(event));
        }
        if (fresh.length) {
            fs.mkdirSync(EVENT_DIR, { recursive: true });
            fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n');
            written += fresh.length;
        }
    }
    return written;
}

(async () => {
    const res = { at: Date.now(), error: '', devices: {} };
    // keep the last values of devices that are read locally again or failed this time
    for (const id of Object.keys(prev.devices || {})) if (meta[id]) res.devices[id] = prev.devices[id];
    try {
        if (!cfg) throw new Error('no tuya-cloud.json');
        if (ids.length) {
            const tok = (await call('/v1.0/token?grant_type=1')).access_token;
            for (const id of ids) {
                try {
                    const props = (await call('/v2.0/cloud/thing/' + id + '/shadow/properties', tok)).properties || [];
                    const dps = {};
                    let t = 0;
                    for (const p of props) { dps[String(p.dp_id)] = p.value; if (p.time > t) t = p.time; }
                    res.devices[id] = Object.assign({}, prev.devices[id], { t, dps });
                    const pirDp = Object.keys(meta[id].dps || {}).find((dp) => meta[id].dps[dp].code === 'pir_state');
                    if (pirDp) {
                        const to = Date.now();
                        const from = Math.max(res.devices[id].reportTo || 0, to - 7 * 24 * 3600 * 1000);
                        res.devices[id].events = await recordPirReports(id, pirDp, from, to, tok);
                        res.devices[id].reportTo = to;
                    }
                } catch (e) { res.error = e.message; }
            }
        }
    } catch (e) { res.error = e.message; }
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(JSON.stringify({ kind: 'done', devices: ids.length, error: res.error }));
    process.exit(0);
})();
