// ==========================
// SAVE HV SETTINGS FROM DASHBOARD
// ==========================
// Source of the function node "Save HV settings from dashboard" in flows.json.
// Purpose:
// - Validates the Protection page form, stores it in flow `highVoltageSettings` and in the
//   config file. Invalid values are rejected with a message; nothing is saved then.
// Config file:
// - /data/home/nodered/grid-control-config/high-voltage-settings.json
// Input:
// - msg.payload : the form object (every key of DEFAULT_SETTINGS)
// Outputs (3):
// - output 1 -> file write msg
// - output 2 -> msg.hvStatus for "Build HV dashboard state" (success / error text)
// - output 3 -> topic `high-voltage-settings-saved` (controller recalculates)
// ==========================
const CONFIG_PATH = '/data/home/nodered/grid-control-config/high-voltage-settings.json';

// ---- settings model: keep this block equal in 05 and 06, and equal to 01 / 07 ----------------
const DEFAULT_SETTINGS = {
    enabled: true,
    start: 55.2,
    release: 55.0,
    full: 55.4,
    gridSupportW: 0,
    gridSupportMode: 'hybrid',
    gridSupportBatteryCapacityAh: 300,
    gridSupportReserveAh: 90,
    gridSupportStartHour: 6,
    gridSupportEndHour: 18,
    gridSupportMaxDischargeA: 15,
    gridSupportForecastConfidencePct: 60,
    gridSupportSolarAssistGainPct: 25,
    gridSupportWeakForecastBlockAh: 30,
    gridSupportMinGridImportW: 300,
    gridSupportDisableNoSun: false,
    gridSupportDisableNoSunBelowW: 200,
    exportGuardEnabled: true,
    forceChargeEnabled: false,
    forceChargeGridW: 0,
    forceChargeLimiterEnabled: false,
    forceChargeLimiterStart: 53,
    forceChargeLimiterRelease: 54,
    forceChargeLimiterFull: 52
};
const BOOLEAN_FIELDS = ['enabled', 'gridSupportDisableNoSun', 'exportGuardEnabled', 'forceChargeEnabled', 'forceChargeLimiterEnabled'];
// Whole numbers clamped to [min, max]; a value that is not a number becomes the default.
const CLAMPED_FIELDS = {
    gridSupportBatteryCapacityAh: [0, 2000],
    gridSupportReserveAh: [0, 1000],
    gridSupportStartHour: [0, 23],
    gridSupportEndHour: [0, 23],
    gridSupportMaxDischargeA: [0, 50],
    gridSupportForecastConfidencePct: [0, 100],
    gridSupportSolarAssistGainPct: [0, 100],
    gridSupportWeakForecastBlockAh: [0, 500],
    gridSupportMinGridImportW: [200, 1000],
    gridSupportDisableNoSunBelowW: [0, 5000]
};
// Whole numbers that must be inside the range, otherwise the settings are rejected.
const STRICT_FIELDS = { gridSupportW: [0, 1000], forceChargeGridW: [0, 3000] };
const HV_VOLTAGE_RANGE = [50, 60];
const FORCE_CHARGE_VOLTAGE_RANGE = [40, 60];
const VALIDATION_HINT = 'HV: 50–60 V, full > start >= release. Grid support 0–1000 W. Force charge 0–3000 W. '
    + 'FC limiter: 40–60 V, release > start > full.';

function inRange(value, range) {
    return Number.isFinite(value) && value >= range[0] && value <= range[1];
}

// Returns the settings in the order of DEFAULT_SETTINGS, or null when they are not valid.
function normalizeSettings(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const raw = value[key] === undefined ? DEFAULT_SETTINGS[key] : value[key];
        const numeric = Number(raw);

        if (BOOLEAN_FIELDS.includes(key)) {
            settings[key] = Boolean(raw);
        }
        else if (key === 'gridSupportMode') {
            const mode = String(raw || '').toLowerCase();
            settings[key] = mode === 'adaptive-day' || mode === 'hybrid' ? mode : 'hv-only';
        }
        else if (CLAMPED_FIELDS[key]) {
            settings[key] = Number.isFinite(numeric)
                ? Math.min(Math.max(Math.round(numeric), CLAMPED_FIELDS[key][0]), CLAMPED_FIELDS[key][1])
                : DEFAULT_SETTINGS[key];
        }
        else if (STRICT_FIELDS[key]) {
            if (!inRange(Math.round(numeric), STRICT_FIELDS[key])) {
                return null;
            }
            settings[key] = Math.round(numeric);
        }
        else {
            // voltages; start / release / full have no fallback
            settings[key] = ['start', 'release', 'full'].includes(key) ? Number(value[key]) : numeric;
        }
    }

    const hvValid = [settings.start, settings.release, settings.full].every(v => inRange(v, HV_VOLTAGE_RANGE))
        && settings.full > settings.start
        && settings.start >= settings.release;
    const limiterValid = [settings.forceChargeLimiterStart, settings.forceChargeLimiterRelease, settings.forceChargeLimiterFull]
        .every(v => inRange(v, FORCE_CHARGE_VOLTAGE_RANGE))
        && settings.forceChargeLimiterRelease > settings.forceChargeLimiterStart
        && settings.forceChargeLimiterStart > settings.forceChargeLimiterFull;

    return hvValid && limiterValid ? settings : null;
}
// ---- end of the settings model ------------------------------------------------------------------

const normalized = normalizeSettings(msg.payload);

if (!normalized) {
    return [null, { hvStatus: { level: 'error', message: 'Invalid values, nothing saved. ' + VALIDATION_HINT } }, null];
}

const settings = Object.assign(normalized, { updatedAt: new Date().toISOString(), source: 'dashboard' });

flow.set('highVoltageSettings', settings);

return [
    { filename: CONFIG_PATH, payload: JSON.stringify(settings, null, 2), encoding: 'utf8' },
    { hvStatus: { level: 'success', message: 'High-voltage settings saved.' } },
    { topic: 'high-voltage-settings-saved', payload: settings }
];
