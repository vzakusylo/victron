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
//    solarWh is hourly PV charger generation accumulated from `/Dc/Pv/Power`.
// 3. Added same-day load forecast series and KPI.
//    Forecast uses observed AC hourly usage from completed hours plus the live partial hour,
//    then projects future hours with time-of-day bucket averages.
// 4. Added surplus forecast/actual series.
//    Surplus is a non-negative proxy: max(0, solar - AC load), without routing breakdown.
// 5. Added PV routing totals.
//    Routing uses a no-export proxy that matches the controller's non-negative grid-import behavior:
//    PV->Load = min(PV, load), PV->Battery = max(0, PV - load), PV->Grid = 0.
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

function average(values) {
    return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

function bucketKeyForHour(hour) {
    if (hour < 6 || hour >= 22) {
        return 'night';
    }
    if (hour < 12) {
        return 'morning';
    }
    if (hour < 17) {
        return 'day';
    }
    return 'evening';
}

function buildLoadForecast(todayKey, rows, liveState, now) {
    const buckets = {
        night: [],
        morning: [],
        day: [],
        evening: []
    };
    const observedHourlyWh = [];
    const forecastMap = {};
    const currentHour = now.getHours();
    const secondsIntoHour = (now.getMinutes() * 60) + now.getSeconds();
    const elapsedFraction = Math.min(1, Math.max(1 / 3600, secondsIntoHour / 3600));
    const remainingFraction = Math.max(0, 1 - elapsedFraction);
    let liveHourForecastW = null;

    rows.forEach(row => {
        const hour = Number(String(row.hour || '').substring(0, 2));
        const acWh = Math.max(0, Number(row.acWh) || 0);

        if (!Number.isInteger(hour)) {
            return;
        }

        observedHourlyWh.push(acWh);
        buckets[bucketKeyForHour(hour)].push(acWh);
    });

    if (liveState && liveState.hourKey && String(liveState.hourKey).startsWith(todayKey)) {
        const liveHour = Number(String(liveState.hourKey).substring(11, 13));
        const liveAcWh = Math.max(0, Number(liveState.acWh) || 0);
        const liveAcW = Math.max(0, Math.round(Number(liveState.acPowerW) || 0));
        const normalizedLiveHourWh = elapsedFraction > 0 ? liveAcWh / elapsedFraction : liveAcWh;

        if (Number.isInteger(liveHour)) {
            observedHourlyWh.push(normalizedLiveHourWh);
            buckets[bucketKeyForHour(liveHour)].push(normalizedLiveHourWh);
        }

        if (liveAcW > 0) {
            liveHourForecastW = liveAcW;
        }
    }

    const globalAverageWh = average(observedHourlyWh);
    const bucketAverages = {
        night: average(buckets.night) || globalAverageWh,
        morning: average(buckets.morning) || globalAverageWh,
        day: average(buckets.day) || globalAverageWh,
        evening: average(buckets.evening) || globalAverageWh
    };

    let remainingForecastWh = 0;

    for (let hour = 0; hour < 24; hour += 1) {
        const label = String(hour).padStart(2, '0') + ':00';
        const bucketAverageWh = bucketAverages[bucketKeyForHour(hour)] || 0;
        const forecastW = hour === currentHour && liveHourForecastW !== null
            ? liveHourForecastW
            : Math.max(0, Math.round(bucketAverageWh));

        forecastMap[label] = forecastW;

        if (hour > currentHour) {
            remainingForecastWh += forecastW;
        }
        else if (hour === currentHour) {
            remainingForecastWh += forecastW * remainingFraction;
        }
    }

    return {
        forecastMap,
        remainingForecastWh,
        hasObservedData: observedHourlyWh.length > 0
    };
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
const loadForecast = buildLoadForecast(todayKey, summaryHours, live, new Date());
const forecastLoadTodayWh = totalAcToday + loadForecast.remainingForecastWh;
const actualSurplusTodayWh = summaryHours.reduce(
    (sum, row) => sum + Math.max(0, (Number(row.solarWh) || 0) - (Number(row.acWh) || 0)),
    0
) + Math.max(0, liveSolarWh - liveAcWh);
const actualPvToLoadTodayWh = summaryHours.reduce(
    (sum, row) => sum + Math.min(Math.max(0, Number(row.solarWh) || 0), Math.max(0, Number(row.acWh) || 0)),
    0
) + Math.min(liveSolarWh, liveAcWh);
const actualPvToBatteryTodayWh = actualSurplusTodayWh;
const actualPvToGridTodayWh = 0;

const hourlyRows = summaryHours.map(row => ({
    hour: row.hour,
    gridWh: Number(row.gridWh) || 0,
    acWh: Number(row.acWh) || 0,
    solarWh: Number(row.solarWh) || 0,
    surplusWh: Math.max(0, (Number(row.solarWh) || 0) - (Number(row.acWh) || 0)),
    forecastSolarW: null,
    forecastLoadW: null,
    forecastSurplusW: null,
    state: 'done'
}));

if (live && live.hourKey && live.hourKey.startsWith(todayKey)) {
    hourlyRows.push({
        hour: hourLabelFromKey(live.hourKey) + ' *',
        gridWh: liveGridWh,
        acWh: liveAcWh,
        solarWh: liveSolarWh,
        surplusWh: Math.max(0, liveSolarWh - liveAcWh),
        forecastSolarW: null,
        forecastLoadW: null,
        forecastSurplusW: null,
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
    row.forecastLoadW = Object.prototype.hasOwnProperty.call(loadForecast.forecastMap, normalizedHour)
        ? loadForecast.forecastMap[normalizedHour]
        : null;
    row.forecastSurplusW = row.forecastSolarW !== null && row.forecastLoadW !== null
        ? Math.max(0, row.forecastSolarW - row.forecastLoadW)
        : null;
});

const allForecastHours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0') + ':00');
const forecastSurplusTodayWh = allForecastHours.reduce((sum, hourLabel) => {
    const solarW = Object.prototype.hasOwnProperty.call(forecastHourlyMap, hourLabel)
        ? forecastHourlyMap[hourLabel]
        : 0;
    const loadW = loadForecast.forecastMap[hourLabel] || 0;

    return sum + Math.max(0, solarW - loadW);
}, 0);
const forecastPvToLoadTodayWh = allForecastHours.reduce((sum, hourLabel) => {
    const solarW = Object.prototype.hasOwnProperty.call(forecastHourlyMap, hourLabel)
        ? forecastHourlyMap[hourLabel]
        : 0;
    const loadW = loadForecast.forecastMap[hourLabel] || 0;

    return sum + Math.min(solarW, loadW);
}, 0);
const forecastPvToBatteryTodayWh = forecastSurplusTodayWh;
const forecastPvToGridTodayWh = 0;
const forecastChart = {
    labels: allForecastHours,
    series: ['Adjusted solar forecast W', 'Forecast load W', 'Forecast surplus W'],
    data: [
        allForecastHours.map(hour => Object.prototype.hasOwnProperty.call(forecastHourlyMap, hour) ? forecastHourlyMap[hour] : 0),
        allForecastHours.map(hour => loadForecast.forecastMap[hour] || 0),
        allForecastHours.map(hour => {
            const solarW = Object.prototype.hasOwnProperty.call(forecastHourlyMap, hour) ? forecastHourlyMap[hour] : 0;
            const loadW = loadForecast.forecastMap[hour] || 0;
            return Math.max(0, solarW - loadW);
        })
    ]
};

const actualChart = {
    labels: hourlyRows.map(row => row.hour),
    series: ['Grid Wh', 'AC Wh', 'Solar Wh', 'Surplus Wh'],
    data: [
        hourlyRows.map(row => row.gridWh),
        hourlyRows.map(row => row.acWh),
        hourlyRows.map(row => row.solarWh),
        hourlyRows.map(row => row.surplusWh)
    ]
};

const forecastSolarKWh = Number(solarToday.energyKWh) || 0;
const liveGridW = live ? Math.round(Number(live.gridPowerW) || 0) : 0;
const liveAcW = live ? Math.round(Number(live.acPowerW) || 0) : 0;
const liveSolarW = trace ? Math.round(Number(trace.solarGenerationW) || 0) : 0;
const livePvToLoadW = Math.min(liveSolarW, liveAcW);
const livePvToBatteryW = Math.max(0, liveSolarW - livePvToLoadW);
const livePvToGridW = 0;
const totalInputW = liveGridW + liveSolarW;
const efficiencyPct = totalInputW > 50
    ? Math.round(Math.min(100, liveAcW / totalInputW * 100) * 10) / 10
    : null;
const lossesW = totalInputW > 50 ? Math.max(0, totalInputW - liveAcW) : null;
const kpiPayload = {
    dateKey: todayKey,
    forecastSolarKWh: forecastSolarKWh.toFixed(2),
    actualSolarKWh: (totalSolarToday / 1000).toFixed(2),
    forecastLoadKWh: (forecastLoadTodayWh / 1000).toFixed(2),
    actualGridKWh: (totalGridToday / 1000).toFixed(2),
    actualAcKWh: (totalAcToday / 1000).toFixed(2),
    surplusKWh: `Act ${(actualSurplusTodayWh / 1000).toFixed(2)} | Fc ${(forecastSurplusTodayWh / 1000).toFixed(2)} kWh`,
    pvToLoadKWh: `Act ${(actualPvToLoadTodayWh / 1000).toFixed(2)} | Fc ${(forecastPvToLoadTodayWh / 1000).toFixed(2)}`,
    pvToBatteryKWh: `Act ${(actualPvToBatteryTodayWh / 1000).toFixed(2)} | Fc ${(forecastPvToBatteryTodayWh / 1000).toFixed(2)}`,
    pvToGridKWh: `Act ${(actualPvToGridTodayWh / 1000).toFixed(2)} | Fc ${(forecastPvToGridTodayWh / 1000).toFixed(2)}`,
    batteryGridChargeKWh: 'pending metric',
    batterySolarChargeKWh: `Act ${(actualPvToBatteryTodayWh / 1000).toFixed(2)} | Fc ${(forecastPvToBatteryTodayWh / 1000).toFixed(2)}`,
    dailyCost: 'pending metric',
    liveGridW,
    liveAcW,
    liveSolarW,
    livePvToLoadW,
    livePvToBatteryW,
    livePvToGridW,
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
        'load forecast series',
        'surplus forecast/actual series',
        'PV to load/battery/grid routing',
        'hourly adjusted solar forecast',
        'hourly Grid Wh',
        'hourly AC Wh',
        'live current-hour Grid/AC Wh and W',
        'controller diagnostics from trace',
        'adaptive grid support budget and live support metrics'
    ],
    missing: [
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