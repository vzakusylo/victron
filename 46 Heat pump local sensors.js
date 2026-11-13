// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `46 Heat pump local sensors.js` and the embedded `func` for "Heat pump local sensors"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads the two Tuya Wi-Fi temperature sensors on battery ("Accumulator tank temp",
//   "Exchange plate") from the local network instead of the Tuya cloud (d#134). They sleep and
//   wake on a change of 0.3 °C or on their periodic report; on wake they send a UDP beacon.
//   `tools/tuya-local-sensors.js` (exec node, spawn mode) listens for the beacons, connects at
//   once and prints one JSON line per reading. This node passes the readings to "Heat pump
//   state" (34) as roles `acc` / `plate`, like the cloud node (44) did.
// Input:
// - msg.topic 'local' from the inject (every 10 min, once at start) -> output 2 starts the tool
//   (it runs 630 s, so two instances overlap for 30 s and no wake is missed)
// - exec stdout chunks (spawn mode: a chunk may hold several or half a line)
// Output (2):
// - output 1 -> "Heat pump state" (34): { topic: role, payload: { data: { dps: { temp, hum, bat },
//               t: reading time }, deviceId, deviceName, source: 'local' } }
// - output 2 -> exec node "Read local battery sensors"
// State:
// - flow.localSensors = { acc: t, plate: t } (time of the last local reading) — 44 calls the cloud
//   only for a sensor without a local reading for CLOUD_FALLBACK_H (44).
// - context.buf = unfinished stdout line, context.lastT = { role: t } (cached repeats skipped)
// Change notes:
// 1. Initial version (d#135).
// 2. d#137: own node ids hpls-* (d#135 had taken the ids of the Automation log nodes by mistake).
// 3. d#138: DPs missing in a wake (null) are not sent, so 34 keeps their last value.
// ==========================

const SENSORS = {
    bfe0dd97b76a98f454a8bt: { role: 'acc', name: 'Accumulator tank temp' },
    bfe949ce996182ffb9b1zl: { role: 'plate', name: 'Exchange plate' }
};

if (msg.topic === 'local' && (msg.payload === undefined || msg.payload === '' || typeof msg.payload === 'number' || msg.payload === 'tick')) {
    return [null, { topic: 'local', payload: '' }];
}

const text = (context.get('buf') || '') + (Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : String(msg.payload || ''));
const lines = text.split('\n');
context.set('buf', lines.pop().slice(-4000));
const lastT = context.get('lastT') || {};
const local = flow.get('localSensors') || {};
const out = [];
for (const ln of lines) {
    let j;
    try { j = JSON.parse(ln); } catch (e) { continue; }
    if (j.kind === 'error') {
        const last = context.get('lastErr') || 0;
        if (Date.now() - last > 30 * 60 * 1000) { node.warn('Heat pump local sensors: ' + (j.role ? j.role + ': ' : '') + j.error); context.set('lastErr', Date.now()); }
        continue;
    }
    if (j.kind !== 'reading' || !SENSORS[j.id] || !Number.isFinite(j.t)) continue;
    const s = SENSORS[j.id];
    if (lastT[s.role] && j.t <= lastT[s.role]) continue;
    lastT[s.role] = j.t;
    local[s.role] = j.t;
    // a wake does not always push every DP (battery_state often missing): keep the last value then
    const dps = {};
    if (j.temp !== null && j.temp !== undefined) dps.temp = j.temp;
    if (j.hum !== null && j.hum !== undefined) dps.hum = j.hum;
    if (j.bat !== null && j.bat !== undefined) dps.bat = j.bat;
    out.push({ topic: s.role, payload: { data: { dps, t: j.t }, deviceId: j.id, deviceName: s.name, source: 'local' } });
}
context.set('lastT', lastT);
flow.set('localSensors', local);
if (!out.length) return null;
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + ' min' : (m / 60).toFixed(1) + ' h'; };
node.status({ fill: 'green', shape: 'dot', text: Object.keys(lastT).map((r) => r + ' ' + ago(lastT[r]) + ' ago').join(' · ') });
return [out, null];
