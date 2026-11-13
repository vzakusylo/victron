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
'use strict';
const fs = require('fs'), crypto = require('crypto');

const DIR = '/data/home/nodered/grid-control-config/';
const OUT = DIR + 'tuya-devices-cloud.json';
const EVERY_MS = 30 * 60 * 1000;
const LOCAL_FRESH_MS = 24 * 3600 * 1000;
const HEAT_PUMP_SENSORS = ['Accumulator tank temp', 'Exchange plate'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
setTimeout(() => process.exit(0), 20000).unref();   // the exec must not hang (no `timeout` on the GX)

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
    const j = await (await fetch(cfg.endpoint.replace(/\/$/, '') + path, { headers })).json();
    if (!j.success) throw new Error(path.split('?')[0].replace(/\/[0-9a-z]{20,}/g, '/<id>') + ': ' + j.code + ' ' + j.msg);
    return j.result;
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
                    res.devices[id] = { t, dps };
                } catch (e) { res.error = e.message; }
            }
        }
    } catch (e) { res.error = e.message; }
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(JSON.stringify({ kind: 'done', devices: ids.length, error: res.error }));
    process.exit(0);
})();
