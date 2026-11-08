// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `36 Record heat pump data.js` and the embedded `func` for "Record heat pump data"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - READ-ONLY recorder: every 30 s stores ALL data points of the heat pump, the boiler valve
//   relay and the bypass relay (flow.heatPump, written by "Heat pump state", 34) in a compact
//   hourly file on the GX. The previous hour's file is gzipped when the hour changes.
// Input:
// - any msg (inject "Heat pump log tick (30 s)")
// Output (2):
// - output 1 -> file node "Append heat pump data" (append, msg.filename, createDir)
// - output 2 -> exec node "Compress heat pump hours" (`sh -c <payload>`): gzip every *.csv
//   except the current hour — sent on a new hour and on the first run after a restart
// Files:
// - /data/home/nodered/grid-control-logs/heatpump/YYYY-MM-DD/HH.csv     (current hour, plain)
// - /data/home/nodered/grid-control-logs/heatpump/YYYY-MM-DD/HH.csv.gz  (finished hours)
//   Local date / hour of the GX.
// Format "hp1" (delta CSV, one file = one hour):
//   #hp1 2026-11-08 00 cols=t,st,1,2,5,15,101,...,v1,b1
//   0,CEC,1,mute,heat,0,29,33,-3,32,...        <- keyframe: every column
//   30,,,,,,,34                                <- delta: only changed columns, rest empty
//   60
//   - A line starting with `#hp1` starts a section: it names the date, hour and the column
//     list. A new section (header + keyframe) is written at the start of every file, after a
//     Node-RED restart / deploy and whenever a new DP appears.
//   - t   = seconds since the start of the hour (0…3599)
//   - st  = connection state of heat pump / valve / bypass / power meter, one letter each:
//           C connected, N connecting, D disconnected, E error, U unknown, S stale (> 180 s
//           without data while "connected"). Files written before d#121 have 3 letters.
//   - columns `1`, `2`, … = heat pump DP ids; `v<dp>` = valve relay DPs; `b<dp>` = bypass DPs;
//     `m<dp>` = SA1 power meter DPs; `pw` = decoded heat pump power in W (from the meter)
//   - empty field = same value as the previous row of the section (or not received yet in
//     the keyframe); trailing empty fields are dropped, so an unchanged row is just `t`
//   - values: numbers as sent by the device, booleans 1 / 0, text as is (`,` → `;`)
//   Decode: `node tools/heatpump-decode.js HH.csv[.gz]` → one full CSV row per sample.
// Size (measured on test data, 40 DPs): ~5–10 KB per hour plain, ~1–2 KB per hour gzipped
//   → about 30–50 KB per day, 15–20 MB per year.
// Change notes:
// 1. Initial version (d#114): one text line every 30 s to heatpump-YYYY-MM-DD.log.
// 2. Replaced by the compact hourly "hp1" delta CSV with all DPs + gzip of finished hours (d#120).
// 3. SA1 power meter (d#121): meter DPs as `m<dp>`, decoded power as `pw`, 4th state letter.
//    Read back by "Heat pump command" (37) + "Build heat pump history" (38) for the history page.
// ==========================

const BASE_DIR = '/data/home/nodered/grid-control-logs/heatpump';
const STALE_MS = 180 * 1000;
const ROLES = [['hp', ''], ['valve', 'v'], ['bypass', 'b'], ['meter', 'm']];
const STATE_LETTER = { CONNECTED: 'C', CONNECTING: 'N', DISCONNECTED: 'D', ERROR: 'E', UNKNOWN: 'U' };

function pad(n) { return String(n).padStart(2, '0'); }

function cell(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'object') return JSON.stringify(value).replace(/[,\r\n]/g, ';');
    return String(value).replace(/[,\r\n]/g, ';');
}

function dpSort(a, b) {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
}

const st = flow.get('heatPump');
if (!st || !st.hp) {
    node.status({ fill: 'grey', shape: 'ring', text: 'no heat pump data yet' });
    return null;
}

const now = new Date();
const nowMs = now.getTime();
const dayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const hourKey = dayKey + ' ' + pad(now.getHours());
const t = now.getMinutes() * 60 + now.getSeconds();
const filename = BASE_DIR + '/' + dayKey + '/' + pad(now.getHours()) + '.csv';

// Current values of every DP of every device, as cells
const values = {};
ROLES.forEach(([role, prefix]) => {
    const dev = st[role];
    if (!dev || !dev.dps) return;
    Object.keys(dev.dps).sort(dpSort).forEach((dp) => { values[prefix + dp] = cell(dev.dps[dp]); });
});
// Decoded heat pump power from the SA1 meter (W), only while the meter data is fresh
const meter = st.meter;
if (meter && meter.reading && meter.reading.powerW !== null && meter.reading.powerW !== undefined
    && meter.lastData && nowMs - meter.lastData <= STALE_MS) {
    values.pw = cell(meter.reading.powerW);
}

const stateLetters = ROLES.map(([role]) => {
    const dev = st[role];
    if (!dev) return 'U';
    const letter = STATE_LETTER[dev.state] || 'U';
    if (letter === 'C' && (!dev.lastData || nowMs - dev.lastData > STALE_MS)) return 'S';
    return letter;
}).join('');

const rec = context.get('rec') || {};
const outputs = [null, null];
const lines = [];

// New hour (or first run after a restart / deploy) -> gzip every finished hour file.
// Catches hours left plain by a restart too. Paths contain only digits, '-' and '/',
// so the single-quoted sh -c script is safe.
if (rec.file !== filename) {
    const script = 'find ' + BASE_DIR + ' -name "*.csv" ! -path "' + filename + '" -exec gzip -f {} + 2>/dev/null; echo done';
    outputs[1] = { payload: "'" + script + "'", topic: 'gzip' };
}

// Column list: keep the order of the running section, append new DPs at the end
let cols = rec.file === filename && Array.isArray(rec.cols) ? rec.cols.slice() : [];
let newSection = rec.file !== filename || cols.length === 0;
Object.keys(values).forEach((k) => {
    if (!cols.includes(k)) { cols.push(k); newSection = true; }
});

let row;
if (newSection) {
    lines.push('#hp1 ' + hourKey + ' cols=t,st,' + cols.join(','));
    row = [String(t), stateLetters].concat(cols.map((k) => (values[k] === undefined ? '' : values[k])));
} else {
    const prev = rec.last || {};
    row = [String(t), stateLetters === rec.lastSt ? '' : stateLetters]
        .concat(cols.map((k) => (values[k] !== undefined && values[k] !== prev[k] ? values[k] : '')));
}
while (row.length > 1 && row[row.length - 1] === '') row.pop();
lines.push(row.join(','));

context.set('rec', { file: filename, cols, last: values, lastSt: stateLetters });

outputs[0] = { filename, payload: lines.join('\n') + '\n' };
node.status({ fill: 'green', shape: 'dot', text: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${stateLetters} ${cols.length} cols → ${dayKey}/${pad(now.getHours())}.csv` });
return outputs;
