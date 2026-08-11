// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `05 Save HV settings from dashboard.js` and the embedded `func` for "Save HV settings from dashboard"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Validates and persists high-voltage protection settings submitted from the dashboard.
// - Rejects invalid values; sends an error status on validation failure.
// Config file:
// - /data/home/nodered/grid-control-config/high-voltage-settings.json
// Input:
// - msg.payload : form object with fields:
//   enabled, start, release, full (V), gridSupportW (W), forceChargeEnabled, forceChargeGridW (W)
//   gridSupportMode, gridSupportBatteryCapacityAh, gridSupportReserveAh,
//   gridSupportStartHour, gridSupportEndHour, gridSupportMaxDischargeA,
//   gridSupportForecastConfidencePct, gridSupportSolarAssistGainPct,
//   gridSupportWeakForecastBlockAh, gridSupportMinGridImportW,
//   gridSupportDisableNoSun, gridSupportDisableNoSunBelowW,
//   forceChargeLimiterEnabled, forceChargeLimiterStart (V), forceChargeLimiterRelease (V), forceChargeLimiterFull (V)
// Validation limits:
// - HV voltage: 50–60 V; required: full > start >= release
// - gridSupportW: 0–1000 W;  forceChargeGridW: 0–3000 W
// - adaptive support: battery capacity 0–2000 Ah, reserve 0–1000 Ah, hours 0–23,
//   max discharge 0–50 A, confidence/gain 0–100 %, min grid import 200–1000 W,
//   low-sun threshold 0–5000 W
// - FC limiter voltage: 40–60 V; required: release > start > full
// Output (1):
// - output 1 -> success confirmation payload after saving
// Change notes:
// 1. Initial version.
// 2. Added forceChargeLimiterEnabled/Start/Release/Full: voltage-based activation for AC Force Charging.
// ==========================
const CONFIG_PATH = '/data/home/nodered/grid-control-config/high-voltage-settings.json';
const GRID_SUPPORT_MODE_HV_ONLY = 'hv-only';
const GRID_SUPPORT_MODE_ADAPTIVE_DAY = 'adaptive-day';
const GRID_SUPPORT_MODE_HYBRID = 'hybrid';
const MIN_SETTING = 50;
const MAX_SETTING = 60;
const MIN_GRID_SUPPORT_W = 0;
const MAX_GRID_SUPPORT_W = 1000;
const MIN_GRID_SUPPORT_BATTERY_CAPACITY_AH = 0;
const MAX_GRID_SUPPORT_BATTERY_CAPACITY_AH = 2000;
const MIN_GRID_SUPPORT_RESERVE_AH = 0;
const MAX_GRID_SUPPORT_RESERVE_AH = 1000;
const MIN_GRID_SUPPORT_HOUR = 0;
const MAX_GRID_SUPPORT_HOUR = 23;
const MIN_GRID_SUPPORT_MAX_DISCHARGE_A = 0;
const MAX_GRID_SUPPORT_MAX_DISCHARGE_A = 50;
const MIN_GRID_SUPPORT_PCT = 0;
const MAX_GRID_SUPPORT_PCT = 100;
const MIN_GRID_SUPPORT_WEAK_FORECAST_AH = 0;
const MAX_GRID_SUPPORT_WEAK_FORECAST_AH = 500;
const MIN_GRID_SUPPORT_MIN_GRID_IMPORT_W = 200;
const MAX_GRID_SUPPORT_MIN_GRID_IMPORT_W = 1000;
const MIN_GRID_SUPPORT_DISABLE_NO_SUN_BELOW_W = 0;
const MAX_GRID_SUPPORT_DISABLE_NO_SUN_BELOW_W = 5000;
const MIN_FORCE_CHARGE_W = 0;
const MAX_FORCE_CHARGE_W = 3000;
const MIN_FC_LIMITER = 40;
const MAX_FC_LIMITER = 60;

function normalizeGridSupportMode(value) {
    const normalized = String(value || '').toLowerCase();

    if (normalized === GRID_SUPPORT_MODE_ADAPTIVE_DAY || normalized === GRID_SUPPORT_MODE_HYBRID) {
        return normalized;
    }

    return GRID_SUPPORT_MODE_HV_ONLY;
}

function clampRounded(value, min, max) {
    return Math.min(Math.max(Math.round(Number(value) || 0), min), max);
}

function normalizeSettings(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const enabled = Boolean(value.enabled);
    const start = Number(value.start);
    const release = Number(value.release);
    const full = Number(value.full);
    const rawGridSupportW = Number(value.gridSupportW);
    const gridSupportMode = normalizeGridSupportMode(value.gridSupportMode);
    const gridSupportBatteryCapacityAh = clampRounded(value.gridSupportBatteryCapacityAh, MIN_GRID_SUPPORT_BATTERY_CAPACITY_AH, MAX_GRID_SUPPORT_BATTERY_CAPACITY_AH);
    const gridSupportReserveAh = clampRounded(value.gridSupportReserveAh, MIN_GRID_SUPPORT_RESERVE_AH, MAX_GRID_SUPPORT_RESERVE_AH);
    const gridSupportStartHour = clampRounded(value.gridSupportStartHour, MIN_GRID_SUPPORT_HOUR, MAX_GRID_SUPPORT_HOUR);
    const gridSupportEndHour = clampRounded(value.gridSupportEndHour, MIN_GRID_SUPPORT_HOUR, MAX_GRID_SUPPORT_HOUR);
    const gridSupportMaxDischargeA = clampRounded(value.gridSupportMaxDischargeA, MIN_GRID_SUPPORT_MAX_DISCHARGE_A, MAX_GRID_SUPPORT_MAX_DISCHARGE_A);
    const gridSupportForecastConfidencePct = clampRounded(value.gridSupportForecastConfidencePct, MIN_GRID_SUPPORT_PCT, MAX_GRID_SUPPORT_PCT);
    const gridSupportSolarAssistGainPct = clampRounded(value.gridSupportSolarAssistGainPct, MIN_GRID_SUPPORT_PCT, MAX_GRID_SUPPORT_PCT);
    const gridSupportWeakForecastBlockAh = clampRounded(value.gridSupportWeakForecastBlockAh, MIN_GRID_SUPPORT_WEAK_FORECAST_AH, MAX_GRID_SUPPORT_WEAK_FORECAST_AH);
    const gridSupportMinGridImportW = clampRounded(value.gridSupportMinGridImportW, MIN_GRID_SUPPORT_MIN_GRID_IMPORT_W, MAX_GRID_SUPPORT_MIN_GRID_IMPORT_W);
    const gridSupportDisableNoSun = Boolean(value.gridSupportDisableNoSun);
    const gridSupportDisableNoSunBelowW = clampRounded(value.gridSupportDisableNoSunBelowW, MIN_GRID_SUPPORT_DISABLE_NO_SUN_BELOW_W, MAX_GRID_SUPPORT_DISABLE_NO_SUN_BELOW_W);
    const rawForceChargeGridW = Number(value.forceChargeGridW);
    const forceChargeEnabled = Boolean(value.forceChargeEnabled);
    const forceChargeLimiterEnabled = Boolean(value.forceChargeLimiterEnabled);
    const rawFcLimiterStart = Number(value.forceChargeLimiterStart);
    const rawFcLimiterRelease = Number(value.forceChargeLimiterRelease);
    const rawFcLimiterFull = Number(value.forceChargeLimiterFull);
    const gridSupportW = Math.round(rawGridSupportW);
    const forceChargeGridW = Math.round(rawForceChargeGridW);
    const inRange = [start, release, full].every(
        setting => Number.isFinite(setting) && setting >= MIN_SETTING && setting <= MAX_SETTING
    );
    const validGridSupportW = Number.isFinite(rawGridSupportW)
        && gridSupportW >= MIN_GRID_SUPPORT_W
        && gridSupportW <= MAX_GRID_SUPPORT_W;
    const validForceChargeGridW = Number.isFinite(rawForceChargeGridW)
        && forceChargeGridW >= MIN_FORCE_CHARGE_W
        && forceChargeGridW <= MAX_FORCE_CHARGE_W;
    const fcLimiterFinite = [rawFcLimiterStart, rawFcLimiterRelease, rawFcLimiterFull].every(Number.isFinite);
    const fcLimiterInRange = fcLimiterFinite && [rawFcLimiterStart, rawFcLimiterRelease, rawFcLimiterFull].every(
        v => v >= MIN_FC_LIMITER && v <= MAX_FC_LIMITER
    );

    if (!inRange || !validGridSupportW || !validForceChargeGridW || !(full > start) || !(start >= release)
        || !fcLimiterFinite || !fcLimiterInRange
        || !(rawFcLimiterRelease > rawFcLimiterStart) || !(rawFcLimiterStart > rawFcLimiterFull)) {
        return null;
    }

    return {
        enabled, start, release, full, gridSupportW, gridSupportMode,
        gridSupportBatteryCapacityAh, gridSupportReserveAh, gridSupportStartHour, gridSupportEndHour,
        gridSupportMaxDischargeA, gridSupportForecastConfidencePct, gridSupportSolarAssistGainPct,
        gridSupportWeakForecastBlockAh, gridSupportMinGridImportW,
        gridSupportDisableNoSun, gridSupportDisableNoSunBelowW,
        forceChargeEnabled, forceChargeGridW,
        forceChargeLimiterEnabled,
        forceChargeLimiterStart: rawFcLimiterStart,
        forceChargeLimiterRelease: rawFcLimiterRelease,
        forceChargeLimiterFull: rawFcLimiterFull
    };
}

const normalized = normalizeSettings(msg.payload);

if (!normalized) {
    return [
        null,
        { hvStatus: { level: 'error', message: 'Invalid values. HV: 50–60 V, full > start >= release. Grid support 0–1000 W. Adaptive support: capacity 0–2000 Ah, reserve 0–1000 Ah, hours 0–23, max discharge 0–50 A, confidence/gain 0–100 %, min grid import 200–1000 W, low-sun threshold 0–5000 W. Force charge 0–3000 W. FC limiter: 40–60 V, release > start > full.' } },
        null
    ];
}

const settings = {
    enabled: normalized.enabled,
    start: normalized.start,
    release: normalized.release,
    full: normalized.full,
    gridSupportW: normalized.gridSupportW,
    gridSupportMode: normalized.gridSupportMode,
    gridSupportBatteryCapacityAh: normalized.gridSupportBatteryCapacityAh,
    gridSupportReserveAh: normalized.gridSupportReserveAh,
    gridSupportStartHour: normalized.gridSupportStartHour,
    gridSupportEndHour: normalized.gridSupportEndHour,
    gridSupportMaxDischargeA: normalized.gridSupportMaxDischargeA,
    gridSupportForecastConfidencePct: normalized.gridSupportForecastConfidencePct,
    gridSupportSolarAssistGainPct: normalized.gridSupportSolarAssistGainPct,
    gridSupportWeakForecastBlockAh: normalized.gridSupportWeakForecastBlockAh,
    gridSupportMinGridImportW: normalized.gridSupportMinGridImportW,
    gridSupportDisableNoSun: normalized.gridSupportDisableNoSun,
    gridSupportDisableNoSunBelowW: normalized.gridSupportDisableNoSunBelowW,
    forceChargeEnabled: normalized.forceChargeEnabled,
    forceChargeGridW: normalized.forceChargeGridW,
    forceChargeLimiterEnabled: normalized.forceChargeLimiterEnabled,
    forceChargeLimiterStart: normalized.forceChargeLimiterStart,
    forceChargeLimiterRelease: normalized.forceChargeLimiterRelease,
    forceChargeLimiterFull: normalized.forceChargeLimiterFull,
    updatedAt: new Date().toISOString(),
    source: 'dashboard'
};

flow.set('highVoltageSettings', settings);

return [
    {
        filename: CONFIG_PATH,
        payload: JSON.stringify(settings, null, 2),
        encoding: 'utf8'
    },
    { hvStatus: { level: 'success', message: 'High-voltage settings saved.' } },
    { topic: 'high-voltage-settings-saved', payload: settings }
];