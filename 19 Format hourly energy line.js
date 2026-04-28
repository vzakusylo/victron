// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `19 Format hourly energy line.js` and the embedded `func` for "Format hourly energy line"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Formats a completed hourly energy record as a plain-text log line and sets
//   msg.filename so a downstream file-append node writes it to the correct daily file.
// Input:
// - msg.payload : { hourKey: 'YYYY-MM-DD HH', gridWh: number, acWh: number, solarWh: number }
// Output (1):
// - output 1 -> msg with:
//     msg.payload  = 'YYYY-MM-DD HH:00 | Grid <n>Wh | AC <n>Wh | Sol <n>Wh\n'
//     msg.filename = /data/home/nodered/grid-control-logs/energy-YYYY-MM-DD.log
// Change notes:
// 1. Initial version.
// 2. Added Sol column: MPPT solar generation Wh derived from negative DC System Power.
// ==========================
if (!msg.payload || !msg.payload.hourKey) return null;
const { hourKey, gridWh, acWh } = msg.payload;
const solarWh = Number(msg.payload.solarWh) || 0;
const dateKey = hourKey.substring(0, 10);
const hourLabel = hourKey.substring(11, 13);
const line = dateKey + ' ' + hourLabel + ':00 | Grid ' + gridWh + 'Wh | AC ' + acWh + 'Wh | Sol ' + solarWh + 'Wh\n';
msg.filename = '/data/home/nodered/grid-control-logs/energy-' + dateKey + '.log';
msg.payload = line;
msg.encoding = 'utf8';
return msg;