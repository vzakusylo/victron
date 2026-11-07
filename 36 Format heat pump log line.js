// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `36 Format heat pump log line.js` and the embedded `func` for "Format heat pump log line"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - READ-ONLY history of the Tuya heat pump on the GX: every 30 s formats one text line
//   from flow.heatPumpModel (built by "Heat pump state", 34) and appends it to a daily
//   log file, in the same style as the daily energy log
//   (`2026-09-01 00:00 | Grid 2551Wh | AC 2981Wh | Sol 0Wh`).
// Input:
// - any msg (inject "Heat pump log tick (30 s)")
// Output (1):
// - output 1 -> file node "Append heat pump log" (append, msg.filename, createDir)
// File:
// - /data/home/nodered/grid-control-logs/heatpump-YYYY-MM-DD.log  (local date of the GX)
//     2026-11-08 00:18:30 | Sup 34C | Ret 29C | Tank 45C | Out -3C | Cmp 69Hz 3A 77% ~1128W | Fan 591 | HeatSet 35C | DhwSet 28C | Heating Silent | Valve - | Bypass OFF | Defrost no | Faults none | Age 12s
//   Cmp  = compressor frequency, current, load % (frequency / max frequency), estimated power
//   Age  = seconds since the last data from the heat pump
//   "-"  = value not received yet
// - About 2880 lines / ~0.4 MB per day. Log cleanup is disabled in this flow: watch disk
//   space on the Files page.
// Rules:
// - No line is written while the heat pump has never sent data or the data is older than
//   STALE_S (the line would only repeat old values). Node status shows why.
// Change notes:
// 1. Initial version (d#114).
// ==========================

const LOG_DIR = '/data/home/nodered/grid-control-logs';
const STALE_S = 180;

function pad(n) { return String(n).padStart(2, '0'); }
function v(x, unit) { return x === null || x === undefined || x === '' ? '-' : String(x) + (unit || ''); }

const model = flow.get('heatPumpModel');
if (!model || !model.summary || !Array.isArray(model.devices)) {
    node.status({ fill: 'grey', shape: 'ring', text: 'no heat pump data yet' });
    return null;
}

const raw = flow.get('heatPump') || {};
const lastData = raw.hp && raw.hp.lastData ? raw.hp.lastData : 0;
const now = new Date();
const ageS = lastData ? Math.round((now.getTime() - lastData) / 1000) : null;
if (ageS === null || ageS > STALE_S) {
    node.status({ fill: 'yellow', shape: 'ring', text: 'stale: ' + (ageS === null ? 'no data' : ageS + ' s') + ' — not logged' });
    return null;
}

const s = model.summary;
const dayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const stamp = dayKey + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

const onOff = (b) => (b === null || b === undefined ? '-' : (b ? 'ON' : 'OFF'));
const valve = s.valveToDhw === null || s.valveToDhw === undefined ? '-' : (s.valveToDhw ? 'DHW' : 'Heating');
const faults = Array.isArray(s.faults) && s.faults.length ? s.faults.join(',') : 'none';
const cmp = v(s.compressorHz, 'Hz') + ' ' + v(s.compressorA, 'A') + ' ' + v(s.compressorLoadPct, '%') +
    ' ' + (s.compressorPowerW === null || s.compressorPowerW === undefined ? '-' : '~' + s.compressorPowerW + 'W');

const line = [
    stamp,
    'Sup ' + v(s.supply, 'C'),
    'Ret ' + v(s.ret, 'C'),
    'Tank ' + v(s.tank, 'C'),
    'Out ' + v(s.outdoor, 'C'),
    'Cmp ' + cmp,
    'Fan ' + v(s.fanRpm),
    'HeatSet ' + v(s.heatingSetpoint, 'C'),
    'DhwSet ' + v(s.dhwSetpoint, 'C'),
    v(s.workMode) + ' ' + v(s.mode),
    'Valve ' + valve,
    'Bypass ' + onOff(s.bypassOn),
    'Defrost ' + (s.defrostSign ? 'yes' : 'no'),
    'Faults ' + faults,
    'Age ' + ageS + 's'
].join(' | ');

msg.filename = LOG_DIR + '/heatpump-' + dayKey + '.log';
msg.payload = line + '\n';
node.status({ fill: 'green', shape: 'dot', text: stamp.substring(11) + ' → heatpump-' + dayKey + '.log' });
return msg;
