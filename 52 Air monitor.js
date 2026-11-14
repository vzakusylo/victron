// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `52 Air monitor.js` and the embedded `func` for "Air monitor" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Keeps the last reading of the Qingping Air Monitor (Wi-Fi, 192.168.1.58 behind the ASUS router,
//   MAC 58:2D:34:70:1F:19) for the Devices page (50 / 51) and stores every reading in a day file on
//   the GX for the Air quality page (53 / 54). The monitor has no open port: it only pushes. With a
//   "Private Access Config" of type self-built MQTT (developer.qingping.co) it publishes its readings
//   to the MQTT broker of the GX (192.168.1.94:1883) instead of the Qingping cloud, so the reading
//   is local.
// Input:
// - mqtt in node "Qingping air monitor (MQTT)", topic `qingping/+/up`: msg.topic = qingping/<MAC>/up,
//   msg.payload = { type, mac, timestamp, sensorData: [ { temperature: { value }, humidity: { value },
//   co2: { value }, pm25: { value }, pm10: { value }, tvoc: { value }, battery: { value },
//   timestamp: { value } }, ... ] } (object or JSON text). Type 12 = realtime, 17 = history (may
//   hold several readings, also the same reading as a type 12 before). Messages without
//   sensorData (settings, heartbeat) only refresh `seen`.
// Output (1):
// - output 1 -> file node "Append air quality" (append, msg.filename, createDir): one line per new
//   reading, readings already written (time <= the last written) are skipped.
// Files:
// - /data/home/nodered/grid-control-logs/air/YYYY-MM-DD.csv (local date of the GX, one file a day)
//   line: HH:MM:SS,co2,pm25,pm10,tvoc,temperature,humidity   (empty = not in this reading)
//   units: ppm, µg/m³, µg/m³, ppb, °C, %RH. One line a minute = about 60 KB a day, 20 MB a year.
// State:
// - flow.airMonitor = { <MAC>: { mac, t: time of the last reading (ms), seen: last message (ms),
//   type, values: { temperature, humidity, co2, pm25, pm10, tvoc, battery, ... } } }
// - context.logged = { <MAC>: time of the last reading written to a file (ms) }
// Change notes:
// 1. Initial version (d#156).
// 2. d#157: values rounded to one decimal (the monitor sends float32).
// 3. d#159: every reading is written to the day file for the Air quality page (owner: "air quality
//    chart with navigation by days, data stored on the device").
// ==========================

const KEYS = ['temperature', 'humidity', 'co2', 'pm25', 'pm10', 'tvoc', 'tvoc_index', 'noise', 'battery'];
const FILE_COLS = ['co2', 'pm25', 'pm10', 'tvoc', 'temperature', 'humidity'];
const DIR = '/data/home/nodered/grid-control-logs/air';

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

const num = (x) => {
    const v = x && typeof x === 'object' ? x.value : x;
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
};
// every reading of the message with its time; the monitor sends float32 values (36.599998...):
// keep one decimal
const readings = [];
for (const r of Array.isArray(p.sensorData) ? p.sensorData : []) {
    if (!r || typeof r !== 'object') continue;
    const ts = num(r.timestamp) || num(p.timestamp) || 0;
    const t = Math.min(ts > 0 ? (ts < 1e11 ? ts * 1000 : ts) : now, now);
    const values = {};
    for (const k of KEYS) { const v = num(r[k]); if (v !== null) values[k] = Math.round(v * 10) / 10; }
    if (Object.keys(values).length) readings.push({ t, values });
}
readings.sort((a, b) => a.t - b.t);

// the newest one is the current reading
const newest = readings[readings.length - 1];
if (newest && newest.t >= dev.t) {
    // a reading does not always hold every value: keep the last one of the others
    dev.values = Object.assign({}, dev.values, newest.values);
    dev.t = newest.t;
}
all[mac] = dev;
flow.set('airMonitor', all);

// day file: only readings newer than the last one written
const logged = context.get('logged') || {};
const pad = (n) => String(n).padStart(2, '0');
const out = [];
for (const r of readings) {
    if (r.t <= (logged[mac] || 0)) continue;
    const d = new Date(r.t);
    const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const line = [pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())]
        .concat(FILE_COLS.map((k) => (r.values[k] === undefined ? '' : r.values[k]))).join(',');
    out.push({ filename: DIR + '/' + day + '.csv', payload: line + '\n' });
    logged[mac] = r.t;
}
context.set('logged', logged);

const v = dev.values;
const text = [v.co2 !== undefined ? 'CO2 ' + v.co2 : '', v.pm25 !== undefined ? 'PM2.5 ' + v.pm25 : '', v.temperature !== undefined ? v.temperature + ' °C' : ''].filter(Boolean).join(' · ');
node.status({ fill: dev.t ? 'green' : 'yellow', shape: 'dot', text: text || 'message without readings' });
return out.length ? [out] : null;
