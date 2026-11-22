//! @shared
//! lib/grid/helpers.js: pure helpers: time windows, tariffs, budgets, settings sanitizers.
//! Included into the controller and bookkeeping nodes by tools/includes.js.
// ==========================
// HELPERS
// ==========================
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

function getDayKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function getHourKey(date) {
    const key = getDayKey(date) + " " + pad2(date.getHours());
    // The local constructor chooses the first occurrence of an ambiguous hour.
    // Keep that on-disk key; qualify only the repeated interval with its offset.
    const first = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
    if (getHourStartTs(date) <= first.getTime()) return key;
    const offset = -date.getTimezoneOffset();
    return key + (offset < 0 ? "-" : "+") + pad2(Math.floor(Math.abs(offset) / 60)) + pad2(Math.abs(offset) % 60);
}

function getHourStartTs(date) {
    return date.getTime() - ((date.getMinutes() * 60 + date.getSeconds()) * 1000 + date.getMilliseconds());
}

function formatTime(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

function isValidMmdd(value) {
    if (!Number.isInteger(value)) {
        return false;
    }

    const month = Math.floor(value / 100);
    const day = value % 100;
    // 2024 is a leap year, so 29 Feb is accepted.
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(2024, month, 0).getDate();
}

function formatMmdd(value) {
    return pad2(value % 100) + "." + pad2(Math.floor(value / 100));
}

function getConstants(overrides = {}) {
    overrides = overrides || {};
    const constants = {};

    Object.keys(CONSTANT_SPECS).forEach(key => {
        const spec = CONSTANT_SPECS[key];
        const override = Number(overrides[key]);
        const value = Object.prototype.hasOwnProperty.call(overrides, key) && Number.isFinite(override)
            ? override
            : spec.def;

        if (spec.mmdd) {
            constants[key] = isValidMmdd(Math.round(value)) ? Math.round(value) : spec.def;
        }
        else if (spec.int) {
            constants[key] = Math.round(value) >= spec.min && Math.round(value) <= spec.max ? Math.round(value) : spec.def;
        }
        else {
            constants[key] = clamp(value, spec.min, spec.max);
        }
    });

    return constants;
}

// A stored sensor reading: { has, value } (value 0 until the first reading arrives).
function readStoredNumber(raw) {
    const has = raw !== undefined && raw !== null && Number.isFinite(Number(raw));
    return { has, value: has ? Number(raw) : 0 };
}

function normalizeGridSupportMode(value) {
    const normalized = String(value || "").toLowerCase();
    return normalized === GRID_SUPPORT_MODE_ADAPTIVE_DAY || normalized === GRID_SUPPORT_MODE_HYBRID
        ? normalized
        : GRID_SUPPORT_MODE_HV_ONLY;
}

function inRange(value, range) {
    return Number.isFinite(value) && value >= range[0] && value <= range[1];
}

// Returns the validated settings, or null when a required value is missing or out of range
// (the controller then runs on DEFAULT_HIGH_VOLTAGE_SETTINGS).
function sanitizeHighVoltageSettings(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const read = key => (value[key] === undefined ? DEFAULT_HIGH_VOLTAGE_SETTINGS[key] : value[key]);
    const settings = {};

    HV_BOOLEAN_FIELDS.forEach(key => {
        settings[key] = Boolean(read(key));
    });
    Object.keys(HV_CLAMPED_FIELDS).forEach(key => {
        const numeric = Number(read(key));
        settings[key] = Number.isFinite(numeric)
            ? clamp(Math.round(numeric), HV_CLAMPED_FIELDS[key][0], HV_CLAMPED_FIELDS[key][1])
            : DEFAULT_HIGH_VOLTAGE_SETTINGS[key];
    });
    settings.gridSupportMode = normalizeGridSupportMode(read("gridSupportMode"));

    for (const key of Object.keys(HV_STRICT_FIELDS)) {
        const numeric = Number(read(key));
        if (!inRange(Math.round(numeric), HV_STRICT_FIELDS[key])) {
            return null;
        }
        settings[key] = Math.round(numeric);
    }

    // start / release / full have no default: a file without them is invalid.
    settings.start = Number(value.start);
    settings.release = Number(value.release);
    settings.full = Number(value.full);
    settings.forceChargeLimiterStart = Number(read("forceChargeLimiterStart"));
    settings.forceChargeLimiterRelease = Number(read("forceChargeLimiterRelease"));
    settings.forceChargeLimiterFull = Number(read("forceChargeLimiterFull"));

    const voltagesValid = [settings.start, settings.release, settings.full].every(v => inRange(v, HV_VOLTAGE_RANGE))
        && settings.full > settings.start
        && settings.start >= settings.release;
    const limiterValid = [settings.forceChargeLimiterStart, settings.forceChargeLimiterRelease, settings.forceChargeLimiterFull]
        .every(v => inRange(v, FORCE_CHARGE_VOLTAGE_RANGE))
        && settings.forceChargeLimiterRelease > settings.forceChargeLimiterStart
        && settings.forceChargeLimiterStart > settings.forceChargeLimiterFull;

    return voltagesValid && limiterValid ? settings : null;
}

function isHourWithinWindow(hourValue, startHour, endHour) {
    if (startHour === endHour) {
        return true;
    }

    if (startHour < endHour) {
        return hourValue >= startHour && hourValue < endHour;
    }

    return hourValue >= startHour || hourValue < endHour;
}

function isNightHour(hourOfDay) {
    return isHourWithinWindow(hourOfDay, NIGHT_START_HOUR, NIGHT_END_HOUR);
}

// Hours from `date` to the end of the window, 0 outside it.
function getWindowRemainingHours(date, startHour, endHour) {
    if (!isHourWithinWindow(date.getHours(), startHour, endHour)) {
        return 0;
    }

    if (startHour === endHour) {
        return 24;
    }

    const end = new Date(date);
    end.setHours(endHour, 0, 0, 0);

    // The end hour is today when it is still ahead (e.g. 02:00 in a 22-06 window), else tomorrow.
    if (end <= date) {
        end.setDate(end.getDate() + 1);
    }

    return Math.max(0, (end.getTime() - date.getTime()) / 3600000);
}

// The whole MORNING window is still ahead during the night.
function getRemainingMorningHours(date) {
    return isNightHour(date.getHours())
        ? MORNING_END_HOUR - NIGHT_END_HOUR
        : getWindowRemainingHours(date, NIGHT_END_HOUR, MORNING_END_HOUR);
}

// Shade-adjusted forecast (Wh) from now to the end of the window, today only.
function getRemainingForecastWh(date, startHour, endHour, rawAdjustedForecast) {
    const adjustedResult = rawAdjustedForecast && typeof rawAdjustedForecast.adjustedResult === "object"
        ? rawAdjustedForecast.adjustedResult
        : null;

    if (!adjustedResult) {
        return 0;
    }

    const todayPrefix = getDayKey(date);
    const currentHour = date.getHours();
    const currentHourFractionLeft = Math.max(0, 1 - ((date.getMinutes() * 60 + date.getSeconds()) / 3600));

    return Object.keys(adjustedResult).reduce((total, key) => {
        if (!String(key).startsWith(todayPrefix)) {
            return total;
        }

        const forecastHour = Number(String(key).substring(11, 13));
        const hourlyForecastW = Math.max(0, Number(adjustedResult[key]) || 0);

        if (!Number.isInteger(forecastHour) || hourlyForecastW <= 0
            || !isHourWithinWindow(forecastHour, startHour, endHour) || forecastHour < currentHour) {
            return total;
        }

        return total + hourlyForecastW * (forecastHour === currentHour ? currentHourFractionLeft : 1);
    }, 0);
}

function getSolarForecastSummary(date, rawForecast, C) {

    if (!rawForecast || typeof rawForecast !== "object") {
        return { valid: false, condition: "unknown", energyKWh: 0, peakKW: 0 };
    }

    const updatedAt = new Date(rawForecast.updatedAt);
    const hasTimestamp = Number.isFinite(updatedAt.getTime());
    const ageHours = hasTimestamp ? (date.getTime() - updatedAt.getTime()) / 3600000 : Number.POSITIVE_INFINITY;
    const sameDay = hasTimestamp && getDayKey(updatedAt) === getDayKey(date);

    return {
        valid: sameDay && ageHours >= 0 && ageHours <= C.SOLAR_FORECAST_MAX_AGE_HOURS,
        condition: String(rawForecast.condition || "unknown").toLowerCase(),
        energyKWh: Number(rawForecast.energyKWh) || 0,
        peakKW: Number(rawForecast.peakKW) || 0
    };
}

// The BMS reports the deficit as a negative number; some drivers report it positive.
function normalizeConsumedAh(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.abs(numeric) : Number.NaN;
}

function emptyBudget() {
    return { hourKey: "", lastTs: 0, usedWh: 0, startTs: 0, fullHourCoverage: false };
}

// Integrates `powerW` into the Wh counter of the current clock hour; a new hour starts at 0.
function advanceHourBudget(state, date, powerW) {
    const nextState = {
        hourKey: state.hourKey || "",
        lastTs: Number(state.lastTs) || 0,
        usedWh: Number(state.usedWh) || 0,
        startTs: Number(state.startTs) || 0,
        fullHourCoverage: Boolean(state.fullHourCoverage)
    };

    const nowTs = date.getTime();
    const hourKey = getHourKey(date);
    const hourStartTs = getHourStartTs(date);

    if (!nextState.lastTs || nextState.hourKey !== hourKey || nextState.lastTs < hourStartTs) {
        nextState.hourKey = hourKey;
        nextState.lastTs = hourStartTs;
        nextState.usedWh = 0;
        nextState.startTs = date.getMinutes() === 0 ? hourStartTs : nowTs;
        nextState.fullHourCoverage = date.getMinutes() === 0;
    }

    if (nowTs > nextState.lastTs) {
        nextState.usedWh += Math.max(0, powerW) * ((nowTs - nextState.lastTs) / 3600000);
        nextState.lastTs = nowTs;
    }

    return nextState;
}

function getBillingFactor(hourOfDay, C) {
    return isNightHour(hourOfDay) ? C.TARIFF_NIGHT_BILLING_PCT / 100 : 1;
}

function getTariffSeason(date, C) {
    const mmdd = (date.getMonth() + 1) * 100 + date.getDate();
    const winterStart = C.WINTER_START_MMDD;
    const summerStart = C.SUMMER_START_MMDD;
    const autoWinter = winterStart > summerStart
        ? (mmdd >= winterStart || mmdd < summerStart)
        : (mmdd >= winterStart && mmdd < summerStart);
    const forced = C.TARIFF_SEASON_FORCE;
    const nextMmdd = autoWinter ? summerStart : winterStart;
    const nextSwitch = new Date(date.getFullYear(), Math.floor(nextMmdd / 100) - 1, nextMmdd % 100);

    if (nextSwitch.getTime() <= date.getTime()) {
        nextSwitch.setFullYear(nextSwitch.getFullYear() + 1);
    }

    return {
        winter: forced === 2 ? true : (forced === 1 ? false : autoWinter),
        mode: forced === 0 ? "auto" : "forced",
        nextSwitchKey: winterStart === summerStart ? "" : getDayKey(nextSwitch),
        nextSeason: autoWinter ? "SUMMER" : "WINTER"
    };
}

// Safe VE.Bus input current: setpoint + headroom at nominal grid voltage, rounded to 0.5 A.
// The ESS loop holds the setpoint; the current limit is only the hard backstop for spikes.
function getGridCurrentForSetpoint(setpointW, C) {
    const rawA = setpointW * (1 + C.GRID_CURRENT_HEADROOM_PCT / 100) / C.GRID_NOMINAL_VOLTAGE;
    return clamp(Math.round(rawA * 2) / 2, 1, C.GRID_CURRENT_MAX_A);
}

function buildSeasonProfile(winter, C) {
    const tier = winter ? C.WINTER_TARIFF_TIER : C.SUMMER_TARIFF_TIER;
    const tierLimitW = TARIFF_TIER_LIMITS_W[tier - 1];
    const nightBonusPct = winter ? C.WINTER_NIGHT_BONUS_PCT : C.SUMMER_NIGHT_BONUS_PCT;
    const daySetpointW = Math.max(C.MIN_GRID_SETPOINT, Math.round(tierLimitW - C.TARIFF_TIER_MARGIN_W));
    const nightSetpointW = Math.round(daySetpointW * (1 + nightBonusPct / 100) / 10) * 10;
    const nightBillableW = Math.round(nightSetpointW * C.TARIFF_NIGHT_BILLING_PCT / 100);

    return {
        season: winter ? "WINTER" : "SUMMER",
        startMmdd: winter ? C.WINTER_START_MMDD : C.SUMMER_START_MMDD,
        tier,
        tierLimitW,
        nightBonusPct,
        daySetpointW,
        nightSetpointW,
        nightBillableW,
        nightOverTier: nightBillableW > tierLimitW,
        dayCurrentA: getGridCurrentForSetpoint(daySetpointW, C),
        nightCurrentA: getGridCurrentForSetpoint(nightSetpointW, C)
    };
}

// Shell script (run by the exec node as `sh -c <payload>`) that prints the month's legacy
// daily logs and the monthly CSV.
function buildEnergyHistoryCommand(monthKey) {
    const script = 'cd "' + ENERGY_LOG_DIR + '" 2>/dev/null && cat energy-' + monthKey + '-*.log energy-' + monthKey + '.csv 2>/dev/null; true';
    return "'" + script.replace(/'/g, "'\\''") + "'";
}

// Accepts both formats; later lines win for the same hour.
//   CSV:    2026-10-17 22,2450,2432,0,1715,2610,6440,W,60  (bill_wh = 5th column)
//   legacy: 2026-10-17 22:00 | Grid 2450Wh | AC 2432Wh | Sol 0Wh
function parseEnergyHistory(rawText, monthKey, C) {
    const history = {};

    String(rawText || "").split(/\r?\n/).forEach(line => {
        const csv = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}(?:[+-]\d{4})?),(-?\d+),-?\d+,-?\d+(?:,(-?\d+))?/);
        const legacy = csv ? null : line.match(/^(\d{4}-\d{2}-\d{2} \d{2}):00 \| Grid (-?\d+)Wh/);
        const match = csv || legacy;

        if (!match || match[1].substring(0, 7) !== monthKey) {
            return;
        }

        const gridWh = Math.max(0, Number(match[2]) || 0);
        const billWh = csv && csv[3] !== undefined
            ? Math.max(0, Number(csv[3]) || 0)
            : Math.round(gridWh * getBillingFactor(Number(match[1].slice(11, 13)), C));

        history[match[1]] = { gridWh, billWh };
    });

    return history;
}

function getTierForAverageW(averageW) {
    const index = TARIFF_TIER_LIMITS_W.findIndex(limitW => averageW <= limitW);
    return index === -1 ? TARIFF_TIER_LIMITS_W.length + 1 : index + 1;
}

// Moves from `previousValue` towards `targetValue` by at most `maxStep`.
function stepTowards(previousValue, targetValue, maxStep) {
    return Number.isFinite(previousValue)
        ? clamp(targetValue, previousValue - maxStep, previousValue + maxStep)
        : targetValue;
}

function parseManualDischargeCommand(input) {
    if (input === true || input === "start" || input === "on") {
        return { active: true, source: "inject" };
    }

    if (input === false || input === "stop" || input === "off") {
        return { active: false, source: "inject" };
    }

    if (!input || typeof input !== "object") {
        return null;
    }

    const source = String(input.source || input.reason || "inject");

    if (input.active === true || input.enabled === true || input.command === "start") {
        return { active: true, source };
    }

    if (input.active === false || input.enabled === false || input.command === "stop") {
        return { active: false, source };
    }

    return null;
}
