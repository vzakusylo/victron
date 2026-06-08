// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `08 Adjust solar forecast for shade.js` and the embedded `func` for "Adjust solar forecast for shade"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Applies per-hour shade correction factors to the raw forecast.solar hourly W forecast.
// - Stores the adjusted per-hour map into flow context `solarForecastAdjusted`.
// Input:
// - msg.payload : normalized hourly forecast data (output of "Processed info")
// Flow context write:
// - `solarForecastAdjusted` -> { adjustedResult: { 'YYYY-MM-DD HH:00': W, … }, updatedAt }
// Output (1):
// - output 1 -> msg with adjusted forecast payload; flow context updated
// Change notes:
// 1. Initial version.
// 2. Updated hourlyCapW and sunnyRangeKWh from observed sunny-day data (6 Jun 2026): 16.7 kWh total, 2.7 kW peak.
// ==========================
function localDayKey(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

const result = msg.payload && msg.payload.result;
if (!result || typeof result !== 'object') {
    node.status({ fill: 'red', shape: 'ring', text: 'no forecast data' });
    return null;
}

const shadeByHour = {
    5: 0.02,
    6: 0.04,
    7: 0.06,
    8: 0.10,
    9: 0.18,
    10: 0.30,
    11: 0.55,
    12: 0.72,
    13: 0.78,
    14: 0.62,
    15: 0.50,
    16: 0.42,
    17: 0.32,
    18: 0.22,
    19: 0.14,
    20: 0.08,
    21: 0.03
};

const hourlyCapW = {
    5: 100,
    6: 200,
    7: 500,
    8: 1000,
    9: 1000,
    10: 2100,
    11: 2200,
    12: 2800,
    13: 2300,
    14: 2100,
    15: 1100,
    16: 1000,
    17: 600,
    18: 200,
    19: 150,
    20: 80,
    21: 20
};

const historicalReference = {
    sunnyPeakKW: '2.5-2.8',
    cloudyPeakKW: '<1.0',
    dominantWindow: '11:00-17:00',
    extendedWindow: '05:00-21:00'
};

const resolution = Number(msg.resolution) || 1;
const periodHours = resolution > 0 ? 1 / resolution : 1;
const adjustedResult = {};
const summaryByDay = {};

for (const [key, rawValue] of Object.entries(result)) {
    const date = new Date(key);
    const hour = date.getHours();
    const factor = shadeByHour[hour] || 0;
    const shadedW = factor > 0 ? Math.round(Math.max(0, Number(rawValue) || 0) * factor) : 0;
    const capW = hourlyCapW[hour] || 0;
    const adjustedW = capW > 0 ? Math.min(shadedW, capW) : 0;
    const dayKey = localDayKey(date);

    adjustedResult[key] = adjustedW;

    if (!summaryByDay[dayKey]) {
        summaryByDay[dayKey] = {
            energyWh: 0,
            peakW: 0,
            activeHours: 0
        };
    }

    summaryByDay[dayKey].energyWh += adjustedW * periodHours;
    summaryByDay[dayKey].peakW = Math.max(summaryByDay[dayKey].peakW, adjustedW);
    if (adjustedW > 0) {
        summaryByDay[dayKey].activeHours += periodHours;
    }
}

const todayKey = localDayKey(new Date());
const today = summaryByDay[todayKey] || { energyWh: 0, peakW: 0, activeHours: 0 };
const todayKWh = +(today.energyWh / 1000).toFixed(2);
const todayPeakKW = +(today.peakW / 1000).toFixed(2);
const condition = todayPeakKW >= 1.0 ? 'sunny' : (todayKWh >= 2 ? 'cloudy' : 'low');

msg.topic = 'solar-forecast-adjusted';
msg.payload = {
    source: 'forecast.solar',
    location: 'Hokksund, Norway',
    activeWindow: '05:00-21:00',
    dominantWindow: '11:00-17:00',
    shading: 'trees / heavy shadow',
    rawResult: result,
    adjustedResult,
    summaryByDay,
    today: {
        energyWh: Math.round(today.energyWh),
        energyKWh: todayKWh,
        peakW: today.peakW,
        peakKW: todayPeakKW,
        activeHours: +today.activeHours.toFixed(2),
        condition
    },
    assumptions: {
        sunnyRangeKWh: '14-18',
        cloudyKWh: '4-8',
        shadeByHour,
        hourlyCapW,
        historicalReference
    }
};

node.status({ fill: 'blue', shape: 'dot', text: `${condition} | ${todayKWh}kWh | peak ${todayPeakKW}kW` });
return msg;