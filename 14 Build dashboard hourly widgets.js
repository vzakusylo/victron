// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `14 Build dashboard hourly widgets.js` and the embedded `func` for "Build dashboard hourly widgets"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads today's completed hourly energy rows (dailySummary) and the live partial hour
//   (dashboardLiveHour) from flow context, then builds the hourly widget payload for the dashboard.
// Flow context read:
// - `dailySummary`      -> completed hourly energy rows for today
// - `dashboardLiveHour` -> live (partial) current-hour Wh accumulators
// Input:
// - msg (any) -> triggers a rebuild from flow context
// Output (1):
// - output 1 -> dashboard hourly widget payload array
// Change notes:
// 1. Initial version.
// ==========================
function todayKeyFromDate(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function buildEmptySummary(dateKey) {
    const hours = [];

    for (let index = 0; index < 24; index += 1) {
        hours.push({
            hour: String(index).padStart(2, '0') + ':00',
            gridWh: 0,
            acWh: 0,
            status: 'pending'
        });
    }

    return {
        dateKey,
        hours,
        totalGrid: 0,
        totalAc: 0,
        availableHours: 0
    };
}

function parseSummaryText(rawText, dateKey) {
    const summary = buildEmptySummary(dateKey);
    const rowsByHour = {};

    if (typeof rawText === 'string' && rawText.trim()) {
        rawText.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            const match = trimmed.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \| Grid ([-]?\d+)Wh \| AC ([-]?\d+)Wh$/);

            if (!match || match[1] !== dateKey) {
                return;
            }

            rowsByHour[match[2]] = {
                hour: match[2],
                gridWh: Number(match[3]) || 0,
                acWh: Number(match[4]) || 0,
                status: 'done'
            };
        });
    }

    summary.hours = summary.hours.map(row => rowsByHour[row.hour] || row);
    summary.availableHours = summary.hours.filter(row => row.status === 'done').length;
    summary.totalGrid = summary.hours.reduce((sum, row) => sum + (row.status === 'done' ? row.gridWh : 0), 0);
    summary.totalAc = summary.hours.reduce((sum, row) => sum + (row.status === 'done' ? row.acWh : 0), 0);
    return summary;
}

function byteSize(rawText) {
    if (typeof rawText !== 'string' || !rawText.length) {
        return 0;
    }

    return typeof Buffer !== 'undefined'
        ? Buffer.byteLength(rawText, 'utf8')
        : rawText.length;
}

if (msg.topic === 'controller-trace' && msg.payload && msg.payload.hourBudget) {
    flow.set('dashboardLiveHour', {
        timestamp: msg.payload.timestamp || '',
        hourKey: msg.payload.hourBudget.hourKey || '',
        gridWh: Number(msg.payload.hourBudget.usedWh) || 0,
        acWh: Number(msg.payload.acLoadBudget && msg.payload.acLoadBudget.usedWh) || 0,
        gridPowerW: Number(msg.payload.storedGridPowerW) || 0,
        acPowerW: Number(msg.payload.storedAcLoadPowerW) || 0
    });
}

const todayKey = todayKeyFromDate(new Date());
const selectedDate = flow.get('dashboardSelectedDate') || todayKey;
const summaryFileName = '/data/home/nodered/grid-control-logs/summary-' + selectedDate + '.log';
const energyFileName = '/data/home/nodered/grid-control-logs/energy-' + selectedDate + '.log';
const selectedFileName = summaryFileName + ' | fallback ' + energyFileName;

if (msg.topic === 'selected-day-summary-loading') {
    flow.set('dashboardSelectedRawFile', {
        dateKey: msg.dateKey || selectedDate,
        fileName: selectedFileName,
        rawText: '',
        status: 'loading',
        fileSize: 0
    });
}

if (msg.topic === 'selected-day-summary-file') {
    const rawFileText = typeof msg.payload === 'string' ? msg.payload : '';
    const parsedSummary = parseSummaryText(rawFileText, msg.dateKey || selectedDate);
    flow.set('dashboardSelectedSummary', parsedSummary);
    flow.set('dashboardSelectedRawFile', {
        dateKey: msg.dateKey || selectedDate,
        fileName: selectedFileName,
        rawText: rawFileText,
        status: rawFileText.trim() ? 'loaded' : 'empty',
        fileSize: byteSize(rawFileText)
    });
}

let summary = flow.get('dashboardSelectedSummary');
if (!summary || summary.dateKey !== selectedDate) {
    summary = parseSummaryText('', selectedDate);
    flow.set('dashboardSelectedSummary', summary);
}

const rawFileState = flow.get('dashboardSelectedRawFile') || {
    dateKey: selectedDate,
    fileName: selectedFileName,
    rawText: '',
    status: 'idle',
    fileSize: 0
};
const rows = Array.isArray(summary.hours)
    ? summary.hours.map(row => ({ ...row }))
    : buildEmptySummary(selectedDate).hours;
const live = flow.get('dashboardLiveHour') || null;
const isToday = selectedDate === todayKey;
let displayGridTotal = Number(summary.totalGrid) || 0;
let displayAcTotal = Number(summary.totalAc) || 0;
let liveText = 'Selected day loaded from file';

if (isToday && live && live.hourKey && live.hourKey.substring(0, 10) === selectedDate) {
    const liveHourLabel = live.hourKey.substring(11, 13) + ':00';
    const liveRow = rows.find(row => row.hour === liveHourLabel);

    if (liveRow) {
        liveRow.gridWh = Math.round(live.gridWh);
        liveRow.acWh = Math.round(live.acWh);
        liveRow.status = 'live';
    }

    displayGridTotal += Math.round(live.gridWh);
    displayAcTotal += Math.round(live.acWh);
    liveText = 'Live ' + liveHourLabel + ' | Grid ' + Math.round(live.gridWh) + 'Wh @ ' + Math.round(live.gridPowerW) + 'W | AC ' + Math.round(live.acWh) + 'Wh @ ' + Math.round(live.acPowerW) + 'W';
}
else if (summary.availableHours === 0) {
    liveText = 'No saved hourly file data for ' + selectedDate;
}

const chart = {
    labels: rows.map(row => row.hour),
    series: ['Grid Wh', 'AC Wh'],
    data: [
        rows.map(row => row.gridWh),
        rows.map(row => row.acWh)
    ]
};

const summaryText = selectedDate + ' | Hours ' + summary.availableHours + '/24 | Grid ' + displayGridTotal + 'Wh | AC ' + displayAcTotal + 'Wh';

return [
    { topic: 'hourly-load-stats', payload: [chart] },
    { payload: summaryText },
    { payload: liveText },
    { payload: { dateKey: selectedDate, rows, isToday, availableHours: summary.availableHours, fileName: selectedFileName } },
    { payload: { dateKey: selectedDate, fileName: selectedFileName, rawText: rawFileState.dateKey === selectedDate ? rawFileState.rawText : '', status: rawFileState.dateKey === selectedDate ? rawFileState.status : 'idle', fileSize: rawFileState.dateKey === selectedDate ? rawFileState.fileSize : 0 } }
];