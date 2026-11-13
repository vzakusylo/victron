#!/usr/bin/env node
// Reads every mains-powered Tuya device of grid-control-config/tuya-devices.json (made by
// tools/tuya-devices-setup.js) once over the LOCAL network: connect, take the DPs, disconnect.
// Not polled: battery sensors (they sleep; tools/tuya-local-sensors.js reads them on their beacon)
// and the devices of the tuya-smart-device nodes in the flow (one local connection per device).
//
// Usage (exec of "Devices model", 50):  node /data/home/nodered/tools/tuya-local-poll.js
// Protocol version: tried 3.3, 3.4, 3.5 until one answers; the working one is remembered in
//   grid-control-config/tuya-devices-ver.json (no keys).
// Last good readings: grid-control-config/tuya-devices-last.json { id: { t, ip, version, dps } } (no keys).
// Output: one JSON line per device { kind: 'reading', id, t, ip, version, dps } or { kind: 'error', id, error },
//   then { kind: 'done', ms }. Never prints keys.
'use strict';
const fs = require('fs');

const DIR = '/data/home/nodered/grid-control-config/';
const LIB = process.env.TUYAPI || '/data/home/nodered/.node-red/node_modules/tuyapi';
const WAIT_MS = 3500;
const PARALLEL = 4;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n');

const devices = readJson(DIR + 'tuya-devices.json', null);
if (!devices) { out({ kind: 'error', error: 'no ' + DIR + 'tuya-devices.json (run tools/tuya-devices-setup.js)' }); process.exit(0); }
const TuyAPI = require(LIB);
const ver = readJson(DIR + 'tuya-devices-ver.json', {});
const last = readJson(DIR + 'tuya-devices-last.json', {});
const t0 = Date.now();
const HARD_LIMIT_MS = 25000;   // the exec must not hang (BusyBox on the GX has no `timeout`)
setTimeout(() => { out({ kind: 'done', ms: Date.now() - t0, aborted: true }); process.exit(0); }, HARD_LIMIT_MS).unref();

function readOnce(id, d, version) {
    return new Promise((resolve) => {
        const dps = {};
        let done = false, got = false;
        const dev = new TuyAPI({ id, key: d.key, ip: d.ip, version, issueGetOnConnect: false, issueRefreshOnConnect: false });
        const finish = (err) => {
            if (done) return; done = true;
            try { dev.disconnect(); } catch (e) { /* gone */ }
            resolve(got ? { dps } : { error: err || 'no data' });
        };
        const take = (x) => { if (x && x.dps && typeof x.dps === 'object') { Object.assign(dps, x.dps); got = true; } };
        dev.on('data', take);
        dev.on('dp-refresh', take);
        dev.on('error', (e) => { if (!got) finish(String(e && e.message || e)); });
        setTimeout(() => finish('timeout'), WAIT_MS);
        dev.connect()
            .then(() => dev.get({ schema: true }).then((x) => { take(x); if (got) setTimeout(() => finish(), 300); }).catch(() => { /* push follows */ }))
            .catch((e) => finish('connect: ' + e.message));
    });
}

// saved after every reading, so a run stopped by HARD_LIMIT_MS keeps what it got
function save() {
    try { fs.writeFileSync(DIR + 'tuya-devices-ver.json', JSON.stringify(ver, null, 1)); } catch (e) { /* read-only */ }
    try { fs.writeFileSync(DIR + 'tuya-devices-last.json', JSON.stringify(last)); } catch (e) { /* read-only */ }
}

async function poll(id) {
    const d = devices[id];
    const tries = ver[id] ? [ver[id]] : ['3.3', '3.4', '3.5'];
    let lastErr = '';
    for (const v of tries) {
        const r = await readOnce(id, d, v);
        if (r.dps) {
            ver[id] = v;
            last[id] = { t: Date.now(), ip: d.ip, version: v, dps: r.dps };
            out({ kind: 'reading', id, ip: d.ip, version: v, dps: r.dps });
            save();
            return;
        }
        lastErr = v + ': ' + r.error;
    }
    if (ver[id] && tries.length === 1) delete ver[id];   // try all versions next time
    out({ kind: 'error', id, ip: d.ip, error: lastErr });
}

(async () => {
    const ids = Object.keys(devices).filter((id) => devices[id].ip && !devices[id].battery && !devices[id].node);
    for (let i = 0; i < ids.length; i += PARALLEL) await Promise.all(ids.slice(i, i + PARALLEL).map(poll));
    save();
    out({ kind: 'done', ms: Date.now() - t0, polled: ids.length });
    process.exit(0);
})();
