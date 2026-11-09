#!/usr/bin/env node
// Reads the two Tuya Wi-Fi temperature sensors on battery ("Accumulator tank temp", "Exchange
// plate") from the local network, without the Tuya cloud.
//
// The sensors sleep. When one wakes (on a change of 0.3 °C or on its periodic report) it sends a
// UDP beacon to port 6667 for a few seconds. This tool listens for the beacons, connects to the
// sensor at once (tuyapi, protocol version from the beacon) and takes the DPs it pushes:
//   DP 1 temperature × 10 (°C), DP 2 humidity (%), DP 3 battery_state (low / middle / high).
// Tested 2026-11-09: connect in ~0.4 s, DP 1 / 2 pushed within 2 s.
//
// Usage (on the GX, exec node "Read local battery sensors" in spawn mode, restarted every 10 min):
//   node /data/home/nodered/tools/tuya-local-sensors.js [lifetime_s]   (default 630 s)
// Keys: /data/home/nodered/grid-control-config/tuya-local-sensors.json (not in the repo, mode 600)
//   { "<deviceId>": { "role": "acc" | "plate", "key": "<local key>" }, ... }
// Last readings: /data/home/nodered/grid-control-config/tuya-local-sensors-last.json — printed
//   again at every start (cached: true), so the page has values after a restart.
// Output: one JSON line per event, never the keys:
//   { kind: 'start', t, devices }   { kind: 'reading', t, role, id, ip, version, temp, hum, bat, dps, cached }
//   { kind: 'error', t, role, error }
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');

const DIR = '/data/home/nodered/grid-control-config/';
const KEYS = process.env.TUYA_LOCAL_KEYS || DIR + 'tuya-local-sensors.json';
const LAST = process.env.TUYA_LOCAL_LAST || DIR + 'tuya-local-sensors-last.json';
const LIB = process.env.TUYAPI || '/data/home/nodered/.node-red/node_modules/tuyapi';
const LIFE_MS = (Number(process.argv[2]) || 630) * 1000;
const COLLECT_MS = 6000;      // stay connected at most this long (battery)
const QUIET_MS = 20000;       // ignore further beacons of the same wake
const BEACON_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const out = (o) => process.stdout.write(JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n');
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };

function decodeBeacon(m) {
    try {
        if (m.length > 28 && m.readUInt32BE(0) === 0x000055aa) {          // 3.1–3.4: AES-128-ECB
            const d = crypto.createDecipheriv('aes-128-ecb', BEACON_KEY, null);
            return JSON.parse(Buffer.concat([d.update(m.slice(20, m.length - 8)), d.final()]).toString());
        }
        if (m.length > 50 && m.readUInt32BE(0) === 0x00006699) {          // 3.5: AES-128-GCM
            const hdr = m.slice(4, 18), iv = m.slice(18, 30), tag = m.slice(m.length - 20, m.length - 4);
            const d = crypto.createDecipheriv('aes-128-gcm', BEACON_KEY, iv);
            d.setAAD(hdr); d.setAuthTag(tag);
            return JSON.parse(Buffer.concat([d.update(m.slice(30, m.length - 20)), d.final()]).slice(4).toString());
        }
    } catch (e) { /* not a Tuya beacon */ }
    return null;
}

function decode(dps) {
    const temp = Number.isFinite(Number(dps['1'])) ? Number(dps['1']) / 10 : null;
    const hum = Number.isFinite(Number(dps['2'])) ? Number(dps['2']) : null;
    const bat = typeof dps['3'] === 'string' ? dps['3'] : (Number.isFinite(Number(dps['4'])) ? Number(dps['4']) : null);
    return { temp, hum, bat };
}

const keys = readJson(KEYS, null);
if (!keys) { out({ kind: 'error', error: 'no key file ' + KEYS }); process.exit(1); }
let TuyAPI;
try { TuyAPI = require(LIB); } catch (e) { out({ kind: 'error', error: 'tuyapi not found: ' + e.message }); process.exit(1); }

const last = readJson(LAST, {});
out({ kind: 'start', devices: Object.keys(keys).map((id) => keys[id].role) });
for (const id of Object.keys(last)) {
    if (keys[id]) out(Object.assign({}, last[id], { kind: 'reading', cached: true, t: last[id].t }));
}

const busy = {};
function read(id, beacon) {
    const k = keys[id];
    busy[id] = Date.now();
    const dps = {};
    let finished = false;
    const dev = new TuyAPI({ id, key: k.key, ip: beacon.ip, version: String(beacon.version || '3.3'), issueGetOnConnect: false });
    const finish = (why) => {
        if (finished) return;
        finished = true;
        try { dev.disconnect(); } catch (e) { /* gone */ }
        if (dps['1'] === undefined) { out({ kind: 'error', role: k.role, error: 'no temperature from ' + beacon.ip + ' (' + why + ')' }); return; }
        const r = Object.assign({ kind: 'reading', t: Date.now(), role: k.role, id, ip: beacon.ip, version: beacon.version, dps, cached: false }, decode(dps));
        last[id] = Object.assign({}, r, { kind: undefined, cached: undefined });
        try { fs.writeFileSync(LAST, JSON.stringify(last, null, 1)); } catch (e) { /* no cache */ }
        out(r);
    };
    const take = (d) => {
        if (!d || typeof d !== 'object' || !d.dps) return;
        Object.assign(dps, d.dps);
        if (dps['1'] !== undefined && dps['2'] !== undefined) setTimeout(() => finish('complete'), 500);
    };
    dev.on('data', take);
    dev.on('dp-refresh', take);
    dev.on('error', () => { /* sensor goes back to sleep; handled by the timer */ });
    setTimeout(() => finish('timeout'), COLLECT_MS);
    dev.connect()
        .then(() => dev.get({ schema: true }).then(take).catch(() => { /* 3.4 sensors answer "json obj data unvalid"; the data comes as a push */ }))
        .catch((e) => finish('connect failed: ' + e.message));
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (m) => {
    const b = decodeBeacon(m);
    if (!b || !b.gwId || !keys[b.gwId]) return;
    if (busy[b.gwId] && Date.now() - busy[b.gwId] < QUIET_MS) return;
    read(b.gwId, b);
});
sock.on('error', (e) => { out({ kind: 'error', error: 'udp 6667: ' + e.message }); process.exit(1); });
sock.bind(6667);
setTimeout(() => process.exit(0), LIFE_MS);
