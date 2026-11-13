// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `52 Air monitor.js` and the embedded `func` for "Air monitor" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Keeps the last reading of the Qingping Air Monitor (Wi-Fi, 192.168.1.58 behind the ASUS router,
//   MAC 58:2D:34:70:1F:19) for the Devices page (50 / 51). The monitor has no open port: it only
//   pushes. With a "Private Access Config" of type self-built MQTT (developer.qingping.co) it
//   publishes its readings to the MQTT broker of the GX (192.168.1.94:1883) instead of the
//   Qingping cloud, so the reading is local.
// Input:
// - mqtt in node "Qingping air monitor (MQTT)", topic `qingping/+/up`: msg.topic = qingping/<MAC>/up,
//   msg.payload = { type, mac, timestamp, sensorData: [ { temperature: { value }, humidity: { value },
//   co2: { value }, pm25: { value }, pm10: { value }, tvoc: { value }, battery: { value },
//   timestamp: { value } }, ... ] } (object or JSON text). Messages without sensorData (settings,
//   heartbeat) only refresh `seen`.
// Output: none.
// State:
// - flow.airMonitor = { <MAC>: { mac, t: time of the last reading (ms), seen: last message (ms),
//   type, values: { temperature, humidity, co2, pm25, pm10, tvoc, battery, ... } } }
// Change notes:
// 1. Initial version (d#156).
// ==========================

const KEYS = ['temperature', 'humidity', 'co2', 'pm25', 'pm10', 'tvoc', 'tvoc_index', 'noise', 'battery'];

let p = msg.payload;
if (Buffer.isBuffer(p)) p = p.toString('utf8');
if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
if (!p || typeof p !== 'object') return null;

const fromTopic = String(msg.topic || '').split('/')[1] || '';
const mac = String(p.mac || fromTopic).replace(/[^0-9a-f]/gi, '').toUpperCase();
if (mac.length !== 12) return null;

const now = Date.now();
const all = flow.get('airMonitor') || {};
const dev = all[mac] || { mac, t: 0, values: {} };
dev.seen = now;
if (p.type !== undefined) dev.type = String(p.type);

// a message may hold several readings (history upload): the newest one wins
const num = (x) => {
    const v = x && typeof x === 'object' ? x.value : x;
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
};
let best = null, bestT = 0;
for (const r of Array.isArray(p.sensorData) ? p.sensorData : []) {
    if (!r || typeof r !== 'object') continue;
    const ts = num(r.timestamp) || num(p.timestamp) || 0;
    const t = ts > 0 ? (ts < 1e11 ? ts * 1000 : ts) : now;
    if (!best || t >= bestT) { best = r; bestT = t; }
}
if (best && bestT >= dev.t) {
    const values = {};
    // the monitor sends float32 values (36.599998...): keep one decimal
    for (const k of KEYS) { const v = num(best[k]); if (v !== null) values[k] = Math.round(v * 10) / 10; }
    if (Object.keys(values).length) {
        // a reading does not always hold every value: keep the last one of the others
        dev.values = Object.assign({}, dev.values, values);
        dev.t = Math.min(bestT, now);
    }
}
all[mac] = dev;
flow.set('airMonitor', all);

const v = dev.values;
const text = [v.co2 !== undefined ? 'CO2 ' + v.co2 : '', v.pm25 !== undefined ? 'PM2.5 ' + v.pm25 : '', v.temperature !== undefined ? v.temperature + ' °C' : ''].filter(Boolean).join(' · ');
node.status({ fill: dev.t ? 'green' : 'yellow', shape: 'dot', text: text || 'message without readings' });
return null;
