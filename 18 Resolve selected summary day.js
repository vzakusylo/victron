// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `18 Resolve selected summary day.js` and the embedded `func` for "Resolve selected summary day"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Resolves which day's energy summary to display based on a UI day-selector value.
// - Falls back to today's live summary if no selection is stored or the selection is invalid.
// Input:
// - msg.payload : selected date string ('YYYY-MM-DD') or null/undefined for today
// Flow context read:
// - `dailySummary` -> today's completed summary (used as fallback)
// Output (1):
// - output 1 -> resolved summary payload { dateKey, hours } for the dashboard table
// Change notes:
// 1. Initial version.
// 2. The command is single-quoted for the exec node, which now runs `sh -c <payload>`
//    (before, `-c` was appended after the payload, so `sh` tried to open a script named `cat`
//    and only the energy-*.log fallback ran).
// 3. Also prints the selected day's rows from the monthly `energy-YYYY-MM.csv`.
// ==========================
function todayKeyFromDate(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function shiftDay(dateKey, offsetDays) {
    const parts = String(dateKey || '').split('-').map(Number);
    const baseDate = parts.length === 3
        ? new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
        : new Date();
    baseDate.setDate(baseDate.getDate() + offsetDays);
    return todayKeyFromDate(baseDate);
}

const todayKey = todayKeyFromDate(new Date());
let selectedDate = flow.get('dashboardSelectedDate') || todayKey;

if (msg.topic === 'dashboard-refresh') {
    selectedDate = todayKey;
}
else if (msg.topic === 'hourly-day-nav') {
    const action = msg.payload && msg.payload.action;

    if (action === 'prev') {
        selectedDate = shiftDay(selectedDate, -1);
    }
    else if (action === 'next') {
        selectedDate = shiftDay(selectedDate, 1);
        if (selectedDate > todayKey) {
            selectedDate = todayKey;
        }
    }
    else {
        selectedDate = todayKey;
    }
}

flow.set('dashboardSelectedDate', selectedDate);

const summaryFileName = '/data/home/nodered/grid-control-logs/summary-' + selectedDate + '.log';
const energyFileName = '/data/home/nodered/grid-control-logs/energy-' + selectedDate + '.log';
const monthCsvFileName = '/data/home/nodered/grid-control-logs/energy-' + selectedDate.substring(0, 7) + '.csv';
// Legacy daily file first, then the day's rows from the monthly CSV (later rows win per hour).
const shellCommand = '{ cat "' + summaryFileName + '" 2>/dev/null || cat "' + energyFileName + '" 2>/dev/null; }; grep "^' + selectedDate + ' " "' + monthCsvFileName + '" 2>/dev/null; true';

return [
    {
        topic: 'selected-day-summary-file',
        dateKey: selectedDate,
        payload: "'" + shellCommand.replace(/'/g, "'\\''") + "'",
        summaryFileName,
        energyFileName
    },
    {
        topic: 'selected-day-summary-loading',
        dateKey: selectedDate,
        payload: '',
        summaryFileName,
        energyFileName
    }
];