// ==========================
// UPDATE DAILY SUMMARY
// ==========================
// Source of the function node "Update daily summary" in flows.json.
// Purpose:
// - Keeps flow `dailySummary` = today's closed hours (grid / AC / solar Wh), used by the
//   Analytics page and the MCP tool get_energy_today. It resets when the day changes.
// Input:
// - topic `hourly-energy` (controller output 5), msg.payload =
//   { hourKey: 'YYYY-MM-DD HH', gridWh, acWh, solarWh } -> add / replace that hour
// - topic `tariff-history` (exec "Read month energy history", string payload = the month's
//   energy files) -> restore today's hours after a restart or redeploy; hours already
//   counted live are kept
// Flow context write:
// - `dailySummary` -> { dateKey: 'YYYY-MM-DD', hours: [{ hour: 'HH:00', gridWh, acWh, solarWh }, …] }
// Outputs (2):
// - output 1 -> unused (the summary file is no longer written; the monthly CSV holds the rows)
// - output 2 -> topic `hourly-load-stats` for the dashboards
// Change notes:
// 1. Initial version.
// 2. Added solarWh field: accumulated PV charger generation Wh per hour (from `/Dc/Pv/Power`).
// 3. No longer writes `summary-YYYY-MM-DD.log`: the monthly `energy-YYYY-MM.csv` holds the same
//    hourly rows (output 1 is always null). Existing summary files are kept and still readable.
// 4. Restores today's hours from the energy files (`tariff-history`): after a restart the
//    Analytics totals used to start again from zero.
// ==========================
const wh = value => Math.round(Number(value) || 0);
const now = new Date();
const todayKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const currentHourLabel = String(now.getHours()).padStart(2, '0') + ':00';

// Rows of one day from the energy files; later lines win for the same hour.
//   CSV:    2026-10-17 22,2450,2432,0,...
//   legacy: 2026-10-17 22:00 | Grid 2450Wh | AC 2432Wh | Sol 0Wh
function parseDay(rawText, dateKey) {
    const byHour = {};
    String(rawText).split(/\r?\n/).forEach(line => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}),(-?\d+),(-?\d+),(-?\d+)/)
            || line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):00 \| Grid (-?\d+)Wh \| AC (-?\d+)Wh(?:\s*\|\s*Sol\s*(-?\d+)Wh)?/);
        if (m && m[1] === dateKey) {
            byHour[m[2] + ':00'] = { hour: m[2] + ':00', gridWh: wh(m[3]), acWh: wh(m[4]), solarWh: wh(m[5]) };
        }
    });
    return byHour;
}

let summary = flow.get('dailySummary') || { dateKey: '', hours: [] };
let dateKey;

if (msg.topic === 'tariff-history' && typeof msg.payload === 'string') {
    dateKey = todayKey;
    if (summary.dateKey !== dateKey) {
        summary = { dateKey, hours: [] };
    }
    const restored = parseDay(msg.payload, dateKey);
    Object.keys(restored).forEach(hour => {
        // The running hour is not closed yet; a live row is newer than the file.
        if (hour !== currentHourLabel && !summary.hours.some(row => row.hour === hour)) {
            summary.hours.push(restored[hour]);
        }
    });
}
else if (msg.payload && msg.payload.hourKey) {
    dateKey = String(msg.payload.hourKey).substring(0, 10);
    const hourLabel = String(msg.payload.hourKey).substring(11, 13) + ':00';
    if (summary.dateKey !== dateKey) {
        summary = { dateKey, hours: [] };
    }
    summary.hours = summary.hours.filter(row => row.hour !== hourLabel);
    summary.hours.push({ hour: hourLabel, gridWh: wh(msg.payload.gridWh), acWh: wh(msg.payload.acWh), solarWh: wh(msg.payload.solarWh) });
}
else {
    return null;
}

summary.hours.sort((a, b) => a.hour.localeCompare(b.hour));
flow.set('dailySummary', summary);

return [null, {
    topic: 'hourly-load-stats',
    payload: [{
        labels: summary.hours.map(row => row.hour),
        series: ['Grid Wh', 'AC Wh', 'Solar Wh'],
        data: [
            summary.hours.map(row => row.gridWh),
            summary.hours.map(row => row.acWh),
            summary.hours.map(row => row.solarWh)
        ]
    }],
    summary: {
        dateKey,
        totalGrid: summary.hours.reduce((sum, row) => sum + row.gridWh, 0),
        totalAc: summary.hours.reduce((sum, row) => sum + row.acWh, 0),
        hours: summary.hours
    }
}];
