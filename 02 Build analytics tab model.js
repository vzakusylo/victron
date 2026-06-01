// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `02 Build analytics tab model.js` and the embedded `func` for "Build analytics tab model"
//   in `flows.json` must always stay synchronized.
// Inputs (message topics):
// - `controller-trace`  -> stores trace payload into flow context `dashboardControllerTrace`
// - any other topic / inject -> rebuilds the full analytics model from stored flow context
// Flow context read:
// - `dailySummary`             -> completed hourly energy rows for today
// - `dashboardLiveHour`        -> live (partial) current-hour energy accumulators
// - `dashboardControllerTrace` -> latest controller trace for diagnostics panel
// - `solarForecastToday`       -> today's solar forecast summary (energyKWh)
// - `solarForecastAdjusted`    -> hourly adjusted solar forecast map (hour key -> W)
// Outputs (6):
// - output 1 -> KPI payload  (totalGridKWh, totalAcKWh, forecastSolarKWh, liveGridW, liveAcW, …)
// - output 2 -> actual chart  (hourly Grid Wh / AC Wh bar series)
// - output 3 -> forecast chart (adjusted hourly solar forecast W; null when no data)
// - output 4 -> diagnostics payload (active window, setpoint, charge current, voltages, …)
// - output 5 -> hourly rows payload (dateKey + rows array for table display)
// - output 6 -> pending payload (lists available vs. missing metrics)
// Change notes:
// 1. Initial version: builds KPI, actual/forecast charts, diagnostics, hourly rows, and pending panels.
//    Reads dailySummary + dashboardLiveHour for grid/AC Wh totals; reads solarForecastAdjusted for
//    per-hour solar forecast; reads dashboardControllerTrace for diagnostics.
// 2. Added actualSolarKWh to KPI: sums solarWh from completed dailySummary rows + live hour.
//    solarWh is MPPT solar generation accumulated per hour from negative DC System Power.
// ==========================

if (msg.topic === 'controller-trace' && msg.payload) {
    flow.set('dashboardControllerTrace', msg.payload);
}

function dayKeyFromDate(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function hourLabelFromKey(hourKey) {
    return hourKey.substring(11, 13) + ':00';
}

const todayKey = dayKeyFromDate(new Date());
const summary = flow.get('dailySummary') || { dateKey: '', hours: [] };
const summaryHours = Array.isArray(summary.hours)
    ? summary.hours.slice().sort((a, b) => a.hour.localeCompare(b.hour))
    : [];
const live = flow.get('dashboardLiveHour') || null;
const trace = flow.get('dashboardControllerTrace') || null;
const solarToday = flow.get('solarForecastToday') || {};
const solarAdjusted = flow.get('solarForecastAdjusted') || {};

const totalGridCompleted = summaryHours.reduce((sum, row) => sum + (Number(row.gridWh) || 0), 0);
const totalAcCompleted = summaryHours.reduce((sum, row) => sum + (Number(row.acWh) || 0), 0);
const totalSolarCompleted = summaryHours.reduce((sum, row) => sum + (Number(row.solarWh) || 0), 0);
const liveGridWh = live && live.hourKey && live.hourKey.startsWith(todayKey) ? Math.round(Number(live.gridWh) || 0) : 0;
const liveAcWh = live && live.hourKey && live.hourKey.startsWith(todayKey) ? Math.round(Number(live.acWh) || 0) : 0;
const liveSolarWh = live && live.hourKey && live.hourKey.startsWith(todayKey) ? Math.round(Number(live.solarWh) || 0) : 0;
const totalGridToday = totalGridCompleted + liveGridWh;
const totalAcToday = totalAcCompleted + liveAcWh;
const totalSolarToday = totalSolarCompleted + liveSolarWh;

const hourlyRows = summaryHours.map(row => ({
    hour: row.hour,
    gridWh: Number(row.gridWh) || 0,
    acWh: Number(row.acWh) || 0,
    solarWh: Number(row.solarWh) || 0,
    forecastSolarW: null,
    state: 'done'
}));

if (live && live.hourKey && live.hourKey.startsWith(todayKey)) {
    hourlyRows.push({
        hour: hourLabelFromKey(live.hourKey) + ' *',
        gridWh: liveGridWh,
        acWh: liveAcWh,
        solarWh: liveSolarWh,
        forecastSolarW: null,
        state: 'live'
    });
}

const forecastHourlyMap = {};
const adjustedResult = solarAdjusted.adjustedResult && typeof solarAdjusted.adjustedResult === 'object'
    ? solarAdjusted.adjustedResult
    : {};

Object.keys(adjustedResult).forEach(key => {
    if (!String(key).startsWith(todayKey)) {
        return;
    }
    const label = hourLabelFromKey(String(key));
    forecastHourlyMap[label] = Math.round(Number(adjustedResult[key]) || 0);
});

hourlyRows.forEach(row => {
    const normalizedHour = row.hour.replace(' *', '');
    row.forecastSolarW = Object.prototype.hasOwnProperty.call(forecastHourlyMap, normalizedHour)
        ? forecastHourlyMap[normalizedHour]
        : null;
});

const allForecastHours = Object.keys(forecastHourlyMap).sort();
const forecastChart = {
    labels: allForecastHours,
    series: ['Adjusted solar forecast W'],
    data: [allForecastHours.map(hour => forecastHourlyMap[hour])]
};

const actualChart = {
    labels: hourlyRows.map(row => row.hour),
    series: ['Grid Wh', 'AC Wh', 'Solar Wh'],
    data: [
        hourlyRows.map(row => row.gridWh),
        hourlyRows.map(row => row.acWh),
        hourlyRows.map(row => row.solarWh)
    ]
};

const forecastSolarKWh = Number(solarToday.energyKWh) || 0;
const liveGridW = live ? Math.round(Number(live.gridPowerW) || 0) : 0;
const liveAcW = live ? Math.round(Number(live.acPowerW) || 0) : 0;
const liveSolarW = trace ? Math.round(Number(trace.solarGenerationW) || 0) : 0;
const totalInputW = liveGridW + liveSolarW;
const efficiencyPct = totalInputW > 50
    ? Math.round(Math.min(100, liveAcW / totalInputW * 100) * 10) / 10
    : null;
const lossesW = totalInputW > 50 ? Math.max(0, totalInputW - liveAcW) : null;
const kpiPayload = {
    dateKey: todayKey,
    forecastSolarKWh: forecastSolarKWh.toFixed(2),
    actualSolarKWh: (totalSolarToday / 1000).toFixed(2),
    forecastLoadKWh: 'pending metric',
    actualGridKWh: (totalGridToday / 1000).toFixed(2),
    actualAcKWh: (totalAcToday / 1000).toFixed(2),
    surplusKWh: 'pending metric',
    batteryGridChargeKWh: 'pending metric',
    batterySolarChargeKWh: 'pending metric',
    dailyCost: 'pending metric',
    liveGridW,
    liveAcW,
    liveSolarW,
    totalInputW,
    efficiencyPct,
    lossesW
};

const diagnosticsPayload = {
    activeWindow: trace ? trace.window || 'unknown' : 'unknown',
    gridSetpointW: trace ? Math.round(Number(trace.finalGridSetpoint) || 0) : 0,
    chargeCurrentA: trace ? Number(trace.finalChargeCurrent || 0).toFixed(1) : '0.0',
    consumedAhDeficit: trace ? Number(trace.consumedAhDeficit || 0).toFixed(1) : '0.0',
    batteryRemainingAh: trace && trace.batteryRemainingAh !== null && trace && trace.batteryRemainingAh !== undefined
        ? Number(trace.batteryRemainingAh || 0).toFixed(1)
        : 'n/a',
    forecastRestoreAh: trace ? Number(trace.forecastRestoreAh || 0).toFixed(1) : '0.0',
    remainingForecastAh: trace ? Number(trace.remainingForecastAh || 0).toFixed(1) : '0.0',
    gridRestoreAhNeeded: trace ? Number(trace.gridRestoreAhNeeded || 0).toFixed(1) : '0.0',
    gridSupportMode: trace ? String(trace.gridSupportMode || 'hv-only') : 'hv-only',
    adaptiveGridSupportActive: trace ? String(Boolean(trace.adaptiveGridSupportActive)) : 'false',
    adaptiveGridSupportW: trace ? Math.round(Number(trace.adaptiveGridSupportW) || 0) : 0,
    plannedGridSupportW: trace ? Math.round(Number(trace.plannedGridSupportW) || 0) : 0,
    supportWindowRemainingHours: trace ? Number(trace.supportWindowRemainingHours || 0).toFixed(1) : '0.0',
    liveSolarAssistW: trace ? Math.round(Number(trace.liveSolarAssistW) || 0) : 0,
    remainingForecastWh: trace ? Math.round(Number(trace.remainingForecastWh) || 0) : 0,
    voltageLimitActive: trace ? String(Boolean(trace.voltageLimitActive)) : 'false',
    batteryVoltage: trace ? Number(trace.batteryVoltage || 0).toFixed(2) : '0.00',
    updatedAt: trace && trace.timestamp ? trace.timestamp : new Date().toISOString()
};

const pendingPayload = {
    available: [
        'forecast solar total',
        'hourly adjusted solar forecast',
        'hourly Grid Wh',
        'hourly AC Wh',
        'live current-hour Grid/AC Wh and W',
        'controller diagnostics from trace',
        'adaptive grid support budget and live support metrics'
    ],
    missing: [
        'load forecast series',
        'surplus forecast/actual series',
        'PV to load/battery/grid routing',
        'battery to load/grid routing',
        'daily tariff cost model'
    ]
};

return [
    { payload: kpiPayload },
    { topic: 'analytics-actual-hourly', payload: [actualChart] },
    allForecastHours.length ? { topic: 'analytics-forecast-solar', payload: [forecastChart] } : null,
    { payload: diagnosticsPayload },
    { payload: { dateKey: todayKey, rows: hourlyRows } },
    { payload: pendingPayload }
];