// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `44 Heat pump cloud sensors.js` and the embedded `func` for "Heat pump cloud sensors"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Two Tuya Wi-Fi temperature sensors on battery are not reachable locally (they sleep and
//   only report to the cloud): "Accumulator tank temp" and "Exchange plate". Their values are
//   read from the Tuya Cloud OpenAPI by `tools/tuya-cloud-status.js` (exec node) every 2 min
//   and passed to "Heat pump state" (34) as two more devices, roles `acc` and `plate`, so the
//   Heat Pump page, the 24 h chart, the recorder (36) and the day chart (38) get them.
// Input:
// - msg.topic 'poll' (inject)  -> output 2: device ids for the exec node
// - exec stdout (msg.topic 'cloud') -> one JSON line { ok, t, devices: { id: { temp, hum, bat, raw } } }
// Output (2):
// - output 1 -> "Heat pump state" (34): { topic: 'acc' | 'plate', payload: { data: { dps: { temp, hum, bat } } } }
//               or { topic, payload: { state: 'ERROR' } } when the cloud read fails
// - output 2 -> exec node "Read Tuya cloud sensors" (payload appended to the command)
// Notes:
// - dps keys are names, not Tuya DP numbers: temp (°C), hum (%), bat (%). The recorder stores
//   them as `atemp`, `ahum`, `abat` (accumulator) and `xtemp`, `xhum`, `xbat` (exchange plate).
// - A value that did not change in the cloud still counts as fresh data: the sensor reports
//   only on change or every few minutes.
// Change notes:
// 1. Initial version (d#132).
// ==========================

const SENSORS = [
    { role: 'acc', id: 'bfe0dd97b76a98f454a8bt', name: 'Accumulator tank temp' },
    { role: 'plate', id: 'bfe949ce996182ffb9b1zl', name: 'Exchange plate' }
];

if (msg.topic === 'poll') {
    return [null, { topic: 'cloud', payload: SENSORS.map((s) => s.id).join(' ') }];
}

let j = null;
try { j = JSON.parse(String(msg.payload || '').trim().split('\n').pop()); } catch (e) { j = null; }
if (!j || !j.ok) {
    const err = j ? j.error : 'no output from tools/tuya-cloud-status.js';
    node.status({ fill: 'red', shape: 'ring', text: String(err).slice(0, 60) });
    const last = context.get('lastErr') || 0;
    if (Date.now() - last > 30 * 60 * 1000) { node.warn('Heat pump cloud sensors: ' + err); context.set('lastErr', Date.now()); }
    return [SENSORS.map((s) => ({ topic: s.role, payload: { state: 'ERROR' } })), null];
}
const msgs = [];
const txt = [];
for (const s of SENSORS) {
    const d = j.devices && j.devices[s.id];
    if (!d) { msgs.push({ topic: s.role, payload: { state: 'DISCONNECTED' } }); txt.push(s.role + ' ?'); continue; }
    msgs.push({ topic: s.role, payload: { data: { dps: { temp: d.temp, hum: d.hum, bat: d.bat } }, deviceId: s.id, deviceName: s.name } });
    txt.push(s.role + ' ' + d.temp + '°');
}
node.status({ fill: 'green', shape: 'dot', text: txt.join(' · ') });
return [msgs, null];
