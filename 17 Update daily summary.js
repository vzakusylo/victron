// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `17 Update daily summary.js` and the embedded `func` for "Update daily summary"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Receives a completed hourly energy record and appends or updates it in the
//   flow context `dailySummary` for today's date.
// - Automatically resets the summary when the date rolls over to a new day.
// Input:
// - msg.payload : { hourKey: 'YYYY-MM-DD HH', gridWh: number, acWh: number }
// Flow context write:
// - `dailySummary` -> { dateKey: 'YYYY-MM-DD', hours: [{ hour, gridWh, acWh }, …] }
// Output (1):
// - output 1 -> msg with the updated daily summary payload
// Change notes:
// 1. Initial version.
// ==========================
if (!msg.payload || !msg.payload.hourKey) return null;
const { hourKey, gridWh, acWh } = msg.payload;
const dateKey = hourKey.substring(0, 10);
const hourLabel = hourKey.substring(11, 13) + ':00';

let summary = flow.get('dailySummary') || { dateKey: '', hours: [] };
if (summary.dateKey !== dateKey) {
    summary = { dateKey, hours: [] };
}
summary.hours = summary.hours.filter(h => h.hour !== hourLabel);
summary.hours.push({ hour: hourLabel, gridWh, acWh });
summary.hours.sort((a, b) => a.hour.localeCompare(b.hour));
flow.set('dailySummary', summary);

const totalGrid = summary.hours.reduce((s, h) => s + h.gridWh, 0);
const totalAc = summary.hours.reduce((s, h) => s + h.acWh, 0);
const lines = summary.hours.map(h => dateKey + ' ' + h.hour + ' | Grid ' + h.gridWh + 'Wh | AC ' + h.acWh + 'Wh');
lines.push('');
lines.push('TOTAL | Grid ' + totalGrid + 'Wh | AC ' + totalAc + 'Wh');

const fileMsg = {
    payload: lines.join('\n') + '\n',
    filename: '/data/home/nodered/grid-control-logs/summary-' + dateKey + '.log',
    encoding: 'utf8'
};

const chart = {
    labels: summary.hours.map(h => h.hour),
    series: ['Grid Wh', 'AC Wh'],
    data: [
        summary.hours.map(h => h.gridWh),
        summary.hours.map(h => h.acWh)
    ]
};

const dashboardMsg = {
    topic: 'hourly-load-stats',
    payload: [chart],
    summary: {
        dateKey,
        totalGrid,
        totalAc,
        hours: summary.hours
    }
};

return [fileMsg, dashboardMsg];