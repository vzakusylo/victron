#!/usr/bin/env node
// One-time setup (run again after adding / re-pairing a device in Smart Life): reads every device of
// the Smart Life account from the Tuya Cloud OpenAPI and writes what is needed to read the devices
// on the LOCAL network afterwards — the cloud is not used at run time.
//
// Usage (on the GX, as root):  node /data/home/nodered/tools/tuya-devices-setup.js [--sweep]
//   --sweep  ping every address of the GX subnets first, so `ip neigh` knows all devices that are awake
// Reads:  grid-control-config/tuya-cloud.json (cloud project credentials, not in the repo)
// Writes: grid-control-config/tuya-devices.json       (mode 600, owner nodered: WITH local keys)
//         grid-control-config/tuya-devices-meta.json  (no keys: names, IPs, DP map, cloud state at setup)
//   per device: { name, category, product, mac, ip, cloudOnline, cloudUpdated, battery, node, dps: { dpId: { code, scale, unit } } }
//   battery = sleeping battery sensor (read by tools/tuya-local-sensors.js on its UDP beacon);
//   node    = read by a tuya-smart-device node in the flow (heat pump, valve, bypass, SA1 meter): not polled.
// Output: a table without keys. IPs come from the ARP table (MAC -> IP); a device that is asleep or on a
// network the GX cannot reach has no IP.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DIR = '/data/home/nodered/grid-control-config/';
const cfg = JSON.parse(fs.readFileSync(process.env.TUYA_CLOUD_CRED || DIR + 'tuya-cloud.json', 'utf8'));
const KNOWN = 'bf3f2552b6fcd2c689fzre';          // heat pump: any device of the account gives the uid
const NODE_IDS = ['bf3f2552b6fcd2c689fzre', 'bf894708aa7e3ac196zjzk', 'bf3ff3d877d898b531cuoq', 'bff533964da65dd78dlha6'];
const BATTERY_CATEGORIES = ['wsdcg', 'ywbj', 'mcs', 'pir', 'sj', 'rqbj', 'cobj', 'ldcg'];
// shadow-property code -> specification code (the two APIs name some codes differently)
const SPEC_ALIAS = { temp_current: 'va_temperature', humidity_value: 'va_humidity', smoke_sensor_state: 'smoke_sensor_status', tamper_alarm: 'temper_alarm', switch_1: 'switch' };
let previous = {};
try { previous = JSON.parse(fs.readFileSync(DIR + 'tuya-devices-meta.json', 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s, key) => crypto.createHmac('sha256', key).update(s).digest('hex').toUpperCase();
async function call(path, token) {
    const t = String(Date.now()), nonce = crypto.randomBytes(8).toString('hex');
    const sign = hmac(cfg.accessId + (token || '') + t + nonce + ['GET', sha256(''), '', path].join('\n'), cfg.accessSecret);
    const headers = { client_id: cfg.accessId, sign, t, nonce, sign_method: 'HMAC-SHA256' };
    if (token) headers.access_token = token;
    const j = await (await fetch(cfg.endpoint.replace(/\/$/, '') + path, { headers })).json();
    if (!j.success) throw new Error(path.split('?')[0] + ': ' + j.code + ' ' + j.msg);
    return j.result;
}

function arpTable(sweep) {
    if (sweep) {
        for (const line of execSync('ip -4 -o addr show').toString().split('\n')) {
            const m = line.match(/inet (192\.168\.\d+)\.\d+\/24/);
            if (m) execSync('for i in $(seq 1 254); do ping -c 1 -W 1 ' + m[1] + '.$i >/dev/null 2>&1 & done; wait', { shell: '/bin/sh' });
        }
    }
    const arp = {};
    for (const line of execSync('ip neigh').toString().split('\n')) {
        const m = line.match(/^(\d+\.\d+\.\d+\.\d+) .* lladdr ([0-9a-f:]+)/i);
        if (m) arp[m[2].toLowerCase()] = m[1];
    }
    return arp;
}

(async () => {
    const tok = (await call('/v1.0/token?grant_type=1')).access_token;
    const uid = (await call('/v1.0/devices/' + KNOWN, tok)).uid;
    const list = await call('/v1.0/users/' + uid + '/devices', tok);
    const macs = {};
    for (let i = 0; i < list.length; i += 20) {
        for (const x of await call('/v1.0/devices/factory-infos?device_ids=' + list.slice(i, i + 20).map((d) => d.id).join(','), tok)) macs[x.id] = (x.mac || '').toLowerCase();
    }
    const arp = arpTable(process.argv.includes('--sweep'));
    const full = {}, meta = {};
    for (const d of list) {
        const dps = {};
        let props = [], spec = {};
        try { props = (await call('/v2.0/cloud/thing/' + d.id + '/shadow/properties', tok)).properties || []; } catch (e) { /* old device */ }
        try {
            for (const s of (await call('/v1.0/devices/' + d.id + '/specifications', tok)).status || []) {
                let v = {}; try { v = JSON.parse(s.values || '{}'); } catch (e) { /* enum */ }
                spec[s.code] = { scale: Number.isFinite(v.scale) ? v.scale : 0, unit: v.unit || '' };
            }
        } catch (e) { spec = {}; }
        for (const p of props) {
            const sp = spec[p.code] || spec[SPEC_ALIAS[p.code]] || { scale: 0, unit: '' };
            dps[p.dp_id] = { code: p.code, scale: sp.scale, unit: sp.unit };
        }
        const codes = props.map((p) => p.code);
        const pir = codes.includes('pir_state');
        const prior = previous[d.id] && previous[d.id].mac === macs[d.id] ? previous[d.id] : {};
        const m = {
            name: String(d.name || '').trim(), category: d.category, product: d.product_name, mac: macs[d.id] || '',
            ip: arp[macs[d.id]] || (pir ? prior.ip || '' : ''), version: pir ? prior.version || '' : undefined,
            cloudOnline: !!d.online, cloudUpdated: d.update_time ? d.update_time * 1000 : 0,
            battery: BATTERY_CATEGORIES.includes(d.category) || (codes.some((c) => /battery/.test(c)) && !codes.some((c) => /^switch|cur_power/.test(c)) && (d.category === 'wsdcg' || codes.includes('pir_state'))),
            node: NODE_IDS.includes(d.id), dps
        };
        meta[d.id] = m;
        full[d.id] = Object.assign({ key: d.local_key }, m);
    }
    fs.writeFileSync(DIR + 'tuya-devices.json', JSON.stringify(full, null, 1) + '\n', { mode: 0o600 });
    fs.writeFileSync(DIR + 'tuya-devices-meta.json', JSON.stringify(meta, null, 1) + '\n', { mode: 0o644 });
    try { execSync('chown nodered:nodered ' + DIR + 'tuya-devices.json ' + DIR + 'tuya-devices-meta.json && chmod 600 ' + DIR + 'tuya-devices.json'); } catch (e) { /* not root */ }
    for (const id of Object.keys(meta)) {
        const m = meta[id];
        console.log([m.name.padEnd(34), m.category.padEnd(6), (m.ip || '-').padEnd(15), m.cloudOnline ? 'online ' : 'OFFLINE', m.battery ? 'battery' : (m.node ? 'node   ' : 'poll   '), Object.keys(m.dps).length + ' dps'].join(' '));
    }
    console.log('devices', Object.keys(meta).length, '-> ' + DIR + 'tuya-devices.json (keys, 600) + tuya-devices-meta.json');
})().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
