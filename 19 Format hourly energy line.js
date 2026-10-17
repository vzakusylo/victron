// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `19 Format hourly energy line.js` and the embedded `func` for "Format hourly energy line"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Formats a completed hourly energy record as one CSV row of the monthly energy file and
//   builds the shell command that appends it (the header is written when the file is new).
// Input:
// - msg.payload : { hourKey: 'YYYY-MM-DD HH', gridWh, acWh, solarWh,
//                   billWh, peakW, setpointW, season: 'S' | 'W', coverageMin }
// Output (1):
// - output 1 -> exec "Append energy CSV" (`sh -c <payload>`), msg.filename = the CSV path
// File:
// - /data/home/nodered/grid-control-logs/energy-YYYY-MM.csv
//     hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min
//     2026-10-17 22,2450,2432,0,1715,2610,6440,W,60
//   bill_wh  = grid Wh as counted for the capacity tariff (night hours x night billing %)
//   peak_w   = highest grid import W seen in the hour
//   setpoint_w / season = the season plan for that hour
//   min      = minutes of the hour actually integrated (60 = full hour; less after a restart)
// Change notes:
// 1. Initial version.
// 2. Added Sol column: PV charger generation Wh accumulated from `/Dc/Pv/Power`.
// 3. Switched from the daily `energy-YYYY-MM-DD.log` text file to the monthly CSV with tariff columns.
//    Legacy daily files are kept untouched and are still read by the dashboard and the controller.
// ==========================
if (!msg.payload || !msg.payload.hourKey) return null;

const LOG_DIR = '/data/home/nodered/grid-control-logs';
const HEADER = 'hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min';
const p = msg.payload;
const int = value => Math.round(Number(value) || 0);
const season = p.season === 'W' || p.season === 'S' ? p.season : '';
const row = [
    String(p.hourKey).substring(0, 13),
    int(p.gridWh),
    int(p.acWh),
    int(p.solarWh),
    int(p.billWh),
    int(p.peakW),
    int(p.setpointW),
    season,
    p.coverageMin === undefined ? '' : int(p.coverageMin)
].join(',');
const filename = LOG_DIR + '/energy-' + String(p.hourKey).substring(0, 7) + '.csv';
// Only digits, dates, commas and S/W reach the script, so plain single quotes are safe.
const script = 'mkdir -p "' + LOG_DIR + '"; f="' + filename + '"; [ -s "$f" ] || echo "' + HEADER + '" > "$f"; echo "' + row + '" >> "$f"';

msg.filename = filename;
msg.csvRow = row;
msg.payload = "'" + script + "'";
return msg;
