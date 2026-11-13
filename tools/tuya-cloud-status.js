#!/usr/bin/env node
// Reads the status of Tuya devices that are not reachable locally (battery Wi-Fi sensors)
// from the Tuya Cloud OpenAPI and prints one JSON line for Node-RED ("Heat pump cloud sensors", 44).
//
// Usage (on the GX, by the exec node "Read Tuya cloud sensors"):
//   node /data/home/nodered/tools/tuya-cloud-status.js <deviceId> [<deviceId> ...]
// Credentials: /data/home/nodered/grid-control-config/tuya-cloud.json (not in the repo, mode 600)
//   { "accessId": "...", "accessSecret": "...", "endpoint": "https://openapi.tuyaeu.com" }
// Caches (tmpfs): /tmp/tuya-cloud-token.json (access token, ~2 h), /tmp/tuya-cloud-spec-<id>.json
// (value scales, 24 h).
// Output: { ok: true, t, devices: { <id>: { temp, hum, bat, raw: { code: value } } } }
//         temp °C, hum %, bat = % or 'low' / 'middle' / 'high'
//         { ok: false, t, error }            — never prints the credentials or the token.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const CRED = process.env.TUYA_CLOUD_CRED || '/data/home/nodered/grid-control-config/tuya-cloud.json';
const TOKEN_FILE = '/tmp/tuya-cloud-token.json';
const SPEC_TTL_MS = 24 * 3600 * 1000;
const TEMP = ['va_temperature', 'temp_current', 'temp_value', 'temp_indoor'];
const HUM = ['va_humidity', 'humidity_value', 'humidity_indoor'];
const BAT = ['battery_percentage', 'va_battery', 'battery_value'];

// caches are optional: a cache file that cannot be written (e.g. owned by another user) is ignored
const save = (f, data) => { try { fs.writeFileSync(f, data, { mode: 0o600 }); } catch (e) { /* no cache */ } };
const out = (o) => { process.stdout.write(JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n'); };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s, key) => crypto.createHmac('sha256', key).update(s).digest('hex').toUpperCase();

async function call(cfg, method, path, token) {
    const t = String(Date.now());
    const nonce = crypto.randomBytes(8).toString('hex');
    const stringToSign = [method, sha256(''), '', path].join('\n');
    const sign = hmac(cfg.accessId + (token || '') + t + nonce + stringToSign, cfg.accessSecret);
    const headers = { client_id: cfg.accessId, sign, t, nonce, sign_method: 'HMAC-SHA256' };
    if (token) headers.access_token = token;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
        const r = await fetch(cfg.endpoint.replace(/\/$/, '') + path, { method, headers, signal: ctl.signal });
        const j = await r.json();
        if (!j.success) throw new Error('Tuya API ' + path.split('?')[0] + ': ' + j.code + ' ' + j.msg);
        return j.result;
    } finally { clearTimeout(timer); }
}

async function token(cfg) {
    try {
        const c = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (c.id === cfg.accessId && c.until > Date.now() + 60000) return c.token;
    } catch (e) { /* no cache */ }
    const r = await call(cfg, 'GET', '/v1.0/token?grant_type=1');
    save(TOKEN_FILE, JSON.stringify({ id: cfg.accessId, token: r.access_token, until: Date.now() + r.expire_time * 1000 }));
    return r.access_token;
}

async function scales(cfg, tok, id) {
    const f = '/tmp/tuya-cloud-spec-' + id.replace(/[^a-z0-9]/gi, '') + '.json';
    try {
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (c.until > Date.now()) return c.scales;
    } catch (e) { /* no cache */ }
    const spec = await call(cfg, 'GET', '/v1.0/devices/' + id + '/specifications', tok);
    const sc = {};
    for (const s of (spec.status || []).concat(spec.functions || [])) {
        try { const v = JSON.parse(s.values || '{}'); if (Number.isFinite(v.scale)) sc[s.code] = v.scale; } catch (e) { /* not numeric */ }
    }
    save(f, JSON.stringify({ until: Date.now() + SPEC_TTL_MS, scales: sc }));
    return sc;
}

(async () => {
    const ids = process.argv.slice(2).filter((x) => /^[a-z0-9]{10,32}$/i.test(x));
    if (!ids.length) return out({ ok: false, error: 'no device ids' });
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch (e) { return out({ ok: false, error: 'credentials file missing or unreadable: ' + CRED }); }
    if (!cfg.accessId || !cfg.accessSecret || !cfg.endpoint) return out({ ok: false, error: 'credentials file needs accessId, accessSecret, endpoint' });
    try {
        const tok = await token(cfg);
        const res = await call(cfg, 'GET', '/v1.0/iot-03/devices/status?device_ids=' + ids.join(','), tok);
        const devices = {};
        for (const d of res || []) {
            const sc = await scales(cfg, tok, d.id);
            const raw = {};
            for (const s of d.status || []) raw[s.code] = s.value;
            const val = (codes) => {
                const c = codes.find((k) => typeof raw[k] === 'number');
                return c === undefined ? null : Math.round(raw[c] / Math.pow(10, sc[c] || 0) * 10) / 10;
            };
            // battery: a percentage, or the enum battery_state (low / middle / high)
            const bat = val(BAT);
            devices[d.id] = { temp: val(TEMP), hum: val(HUM), bat: bat !== null ? bat : (typeof raw.battery_state === 'string' ? raw.battery_state : null), raw };
        }
        out({ ok: true, devices });
    } catch (e) {
        out({ ok: false, error: String(e.message || e).replace(/[A-Za-z0-9]{24,}/g, '…') });
    }
})();
