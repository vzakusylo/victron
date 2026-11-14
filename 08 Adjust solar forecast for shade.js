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
// 3. Seasonal cap from real output: each hour is capped at the highest actual solar Wh of that
//    hour in the last 14 days (energy-YYYY-MM.csv, needs the `fs` module in the node setup) x 1.25.
//    On 13 Nov 2026 the June tables forecast 4.1 kWh / 1.06 kW "sunny" while November days gave
//    0-0.13 kWh, so the controller expected solar that never came. Fewer than 7 logged days ->
//    the June tables alone, as before.
// 4. d#167 (review of PR #20): each day's peak is scaled up by the sun elevation gain from that day to
//    today (max x2), so in spring the cap follows the returning sun instead of trailing it.
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

// Seasonal correction from what the panels really produced. The tables above come from
// June; with the low autumn / winter sun the trees shade the panels almost all day, so the
// June caps overestimate November ~20x. Per hour, the forecast is capped at the highest
// actual solar Wh of that hour in the last OBSERVED_DAYS days x OBSERVED_HEADROOM.
const LOG_DIR = '/data/home/nodered/grid-control-logs/';
const OBSERVED_DAYS = 14;
const OBSERVED_MIN_DAYS = 7;
const OBSERVED_HEADROOM = 1.25;
// d#167: in spring the sun climbs during the 14 days, so the peak of an older day is scaled by the clear-sky
// gain of today over that day (sun elevation at that hour, Hokksund), at most SUN_GAIN_MAX; never scaled down.
const LAT = 59.77 * Math.PI / 180;
const SOLAR_NOON = 12.35;   // local clock hour of the solar noon (CET, 9.9° E)
const SUN_GAIN_MAX = 2;
function sunSin(dayKey, hour) {
    const d = new Date(dayKey + 'T12:00:00');
    const doy = Math.round((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
    const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + doy) / 365);
    const ha = 15 * (hour + 0.5 - SOLAR_NOON) * Math.PI / 180;
    return Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(ha);
}
function sunGain(fromKey, toKey, hour) {
    const a = sunSin(fromKey, hour), b = sunSin(toKey, hour);
    if (b <= 0) return 1;
    if (a <= 0.02) return SUN_GAIN_MAX;
    return Math.max(1, Math.min(SUN_GAIN_MAX, b / a));
}

function readObservedDays(now) {
    // Cached per day in node context; tests set `observedSolar` directly.
    const cached = context.get('observedSolar');
    const todayKey = localDayKey(now);
    if (cached && cached.readOn === todayKey) {
        return cached;
    }
    if (typeof fs === 'undefined') {
        return cached || null;
    }
    const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - OBSERVED_DAYS);
    const months = [localDayKey(first).substring(0, 7), todayKey.substring(0, 7)];
    const days = {};
    Array.from(new Set(months)).forEach(month => {
        let text = '';
        try {
            text = fs.readFileSync(LOG_DIR + 'energy-' + month + '.csv', 'utf8');
        } catch (error) {
            return;
        }
        text.split(/\r?\n/).forEach(line => {
            const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}),[-]?\d+,[-]?\d+,([-]?\d+)/);
            if (!m || m[1] < localDayKey(first) || m[1] >= todayKey) {
                return;
            }
            const day = days[m[1]] || (days[m[1]] = {});
            day[Number(m[2])] = Math.max(0, Number(m[3]) || 0);
        });
    });
    const state = { readOn: todayKey, days };
    context.set('observedSolar', state);
    return state;
}

function observedCapByHour(now) {
    const observed = readObservedDays(now);
    const dayKeys = observed && observed.days ? Object.keys(observed.days) : [];
    if (dayKeys.length < OBSERVED_MIN_DAYS) {
        return null;
    }
    const caps = {};
    for (let hour = 0; hour < 24; hour += 1) {
        const todayKey = localDayKey(now);
        const peak = dayKeys.reduce((max, key) => Math.max(max, (Number(observed.days[key][hour]) || 0) * sunGain(key, todayKey, hour)), 0);
        caps[hour] = Math.round(peak * OBSERVED_HEADROOM);
    }
    return { caps, days: dayKeys.length };
}

const observedCap = observedCapByHour(new Date());

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
    const tableCapW = hourlyCapW[hour] || 0;
    const capW = observedCap ? Math.min(tableCapW, observedCap.caps[hour]) : tableCapW;
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
        observedCapW: observedCap ? observedCap.caps : null,
        observedDays: observedCap ? observedCap.days : 0,
        historicalReference
    }
};

node.status({ fill: 'blue', shape: 'dot', text: `${condition} | ${todayKWh}kWh | peak ${todayPeakKW}kW | ${observedCap ? 'obs ' + observedCap.days + 'd' : 'June caps'}` });
return msg;