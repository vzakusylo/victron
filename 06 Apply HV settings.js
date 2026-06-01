// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `06 Apply HV settings.js` and the embedded `func` for "Apply HV settings"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads the persisted high-voltage settings JSON from disk and stores them into
//   flow context so the battery controller and dashboard always use the latest values.
// - Called on startup and whenever the settings are saved from the dashboard.
// Config file:
// - /data/home/nodered/grid-control-config/high-voltage-settings.json
// Input:
// - msg (any) -> triggers a reload from disk
// Output (1):
// - output 1 -> msg with flow.highVoltageSettings updated
// Change notes:
// 1. Initial version.
// ==========================
const CONFIG_PATH = '/data/home/nodered/grid-control-config/high-voltage-settings.json';
const DEFAULT_SETTINGS = {
    enabled: true,
    start: 55.4,
    release: 55.2,
    full: 55.6,
    gridSupportW: 0,
    gridSupportMode: 'hybrid',
    gridSupportBatteryCapacityAh: 300,
    gridSupportReserveAh: 60,
    gridSupportStartHour: 6,
    gridSupportEndHour: 18,
    gridSupportMaxDischargeA: 20,
    gridSupportForecastConfidencePct: 70,
    gridSupportSolarAssistGainPct: 25,
    gridSupportWeakForecastBlockAh: 20,
    gridSupportMinGridImportW: 200,
    forceChargeEnabled: false,
    forceChargeGridW: 0,
    forceChargeLimiterEnabled: false,
    forceChargeLimiterStart: 53,
    forceChargeLimiterRelease: 54,
    forceChargeLimiterFull: 52
};
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

    const enabled = value.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(value.enabled);
    const start = Number(value.start);
    const release = Number(value.release);
    const full = Number(value.full);
    const rawGridSupportW = value.gridSupportW === undefined ? DEFAULT_SETTINGS.gridSupportW : Number(value.gridSupportW);
    const gridSupportMode = normalizeGridSupportMode(value.gridSupportMode === undefined ? DEFAULT_SETTINGS.gridSupportMode : value.gridSupportMode);
    const gridSupportBatteryCapacityAh = clampRounded(value.gridSupportBatteryCapacityAh === undefined ? DEFAULT_SETTINGS.gridSupportBatteryCapacityAh : value.gridSupportBatteryCapacityAh, MIN_GRID_SUPPORT_BATTERY_CAPACITY_AH, MAX_GRID_SUPPORT_BATTERY_CAPACITY_AH);
    const gridSupportReserveAh = clampRounded(value.gridSupportReserveAh === undefined ? DEFAULT_SETTINGS.gridSupportReserveAh : value.gridSupportReserveAh, MIN_GRID_SUPPORT_RESERVE_AH, MAX_GRID_SUPPORT_RESERVE_AH);
    const gridSupportStartHour = clampRounded(value.gridSupportStartHour === undefined ? DEFAULT_SETTINGS.gridSupportStartHour : value.gridSupportStartHour, MIN_GRID_SUPPORT_HOUR, MAX_GRID_SUPPORT_HOUR);
    const gridSupportEndHour = clampRounded(value.gridSupportEndHour === undefined ? DEFAULT_SETTINGS.gridSupportEndHour : value.gridSupportEndHour, MIN_GRID_SUPPORT_HOUR, MAX_GRID_SUPPORT_HOUR);
    const gridSupportMaxDischargeA = clampRounded(value.gridSupportMaxDischargeA === undefined ? DEFAULT_SETTINGS.gridSupportMaxDischargeA : value.gridSupportMaxDischargeA, MIN_GRID_SUPPORT_MAX_DISCHARGE_A, MAX_GRID_SUPPORT_MAX_DISCHARGE_A);
    const gridSupportForecastConfidencePct = clampRounded(value.gridSupportForecastConfidencePct === undefined ? DEFAULT_SETTINGS.gridSupportForecastConfidencePct : value.gridSupportForecastConfidencePct, MIN_GRID_SUPPORT_PCT, MAX_GRID_SUPPORT_PCT);
    const gridSupportSolarAssistGainPct = clampRounded(value.gridSupportSolarAssistGainPct === undefined ? DEFAULT_SETTINGS.gridSupportSolarAssistGainPct : value.gridSupportSolarAssistGainPct, MIN_GRID_SUPPORT_PCT, MAX_GRID_SUPPORT_PCT);
    const gridSupportWeakForecastBlockAh = clampRounded(value.gridSupportWeakForecastBlockAh === undefined ? DEFAULT_SETTINGS.gridSupportWeakForecastBlockAh : value.gridSupportWeakForecastBlockAh, MIN_GRID_SUPPORT_WEAK_FORECAST_AH, MAX_GRID_SUPPORT_WEAK_FORECAST_AH);
    const gridSupportMinGridImportW = clampRounded(value.gridSupportMinGridImportW === undefined ? DEFAULT_SETTINGS.gridSupportMinGridImportW : value.gridSupportMinGridImportW, MIN_GRID_SUPPORT_MIN_GRID_IMPORT_W, MAX_GRID_SUPPORT_MIN_GRID_IMPORT_W);
    const rawForceChargeGridW = value.forceChargeGridW === undefined ? DEFAULT_SETTINGS.forceChargeGridW : Number(value.forceChargeGridW);
    const forceChargeEnabled = value.forceChargeEnabled === undefined ? DEFAULT_SETTINGS.forceChargeEnabled : Boolean(value.forceChargeEnabled);
    const forceChargeLimiterEnabled = value.forceChargeLimiterEnabled === undefined ? DEFAULT_SETTINGS.forceChargeLimiterEnabled : Boolean(value.forceChargeLimiterEnabled);
    const rawFcLimiterStart = value.forceChargeLimiterStart === undefined ? DEFAULT_SETTINGS.forceChargeLimiterStart : Number(value.forceChargeLimiterStart);
    const rawFcLimiterRelease = value.forceChargeLimiterRelease === undefined ? DEFAULT_SETTINGS.forceChargeLimiterRelease : Number(value.forceChargeLimiterRelease);
    const rawFcLimiterFull = value.forceChargeLimiterFull === undefined ? DEFAULT_SETTINGS.forceChargeLimiterFull : Number(value.forceChargeLimiterFull);
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
        enabled,
        start,
        release,
        full,
        gridSupportW,
        gridSupportMode,
        gridSupportBatteryCapacityAh,
        gridSupportReserveAh,
        gridSupportStartHour,
        gridSupportEndHour,
        gridSupportMaxDischargeA,
        gridSupportForecastConfidencePct,
        gridSupportSolarAssistGainPct,
        gridSupportWeakForecastBlockAh,
        gridSupportMinGridImportW,
        forceChargeEnabled,
        forceChargeGridW,
        forceChargeLimiterEnabled,
        forceChargeLimiterStart: rawFcLimiterStart,
        forceChargeLimiterRelease: rawFcLimiterRelease,
        forceChargeLimiterFull: rawFcLimiterFull
    };
}

const rawText = typeof msg.payload === 'string' ? msg.payload.trim() : '';
let parsed = null;

if (rawText) {
    try {
        parsed = JSON.parse(rawText);
    }
    catch (error) {
        parsed = null;
    }
}

const normalized = normalizeSettings(parsed);
const fileNeedsUpgrade = parsed && typeof parsed === 'object' && (
    parsed.enabled === undefined
    || parsed.gridSupportW === undefined
    || parsed.gridSupportMode === undefined
    || parsed.gridSupportBatteryCapacityAh === undefined
    || parsed.gridSupportReserveAh === undefined
    || parsed.gridSupportStartHour === undefined
    || parsed.gridSupportEndHour === undefined
    || parsed.gridSupportMaxDischargeA === undefined
    || parsed.gridSupportForecastConfidencePct === undefined
    || parsed.gridSupportSolarAssistGainPct === undefined
    || parsed.gridSupportWeakForecastBlockAh === undefined
    || parsed.gridSupportMinGridImportW === undefined
    || parsed.forceChargeEnabled === undefined
    || parsed.forceChargeGridW === undefined
    || parsed.forceChargeLimiterEnabled === undefined
    || parsed.forceChargeLimiterStart === undefined
    || parsed.forceChargeLimiterRelease === undefined
    || parsed.forceChargeLimiterFull === undefined
);
const shouldWriteDefaults = !normalized || !rawText || Boolean(fileNeedsUpgrade);
const settings = normalized
    ? {
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
        forceChargeEnabled: normalized.forceChargeEnabled,
        forceChargeGridW: normalized.forceChargeGridW,
        forceChargeLimiterEnabled: normalized.forceChargeLimiterEnabled,
        forceChargeLimiterStart: normalized.forceChargeLimiterStart,
        forceChargeLimiterRelease: normalized.forceChargeLimiterRelease,
        forceChargeLimiterFull: normalized.forceChargeLimiterFull,
        updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : new Date().toISOString(),
        source: parsed && parsed.source ? String(parsed.source) : 'file'
    }
    : {
        ...DEFAULT_SETTINGS,
        updatedAt: new Date().toISOString(),
        source: rawText ? 'default-invalid-file' : 'default'
    };

flow.set('highVoltageSettings', settings);

node.status({
    fill: shouldWriteDefaults ? 'yellow' : 'green',
    shape: 'dot',
    text: shouldWriteDefaults ? 'HV defaults loaded' : 'HV settings loaded'
});

const refreshMsg = {
    topic: 'high-voltage-settings-loaded',
    payload: settings
};

const fileMsg = shouldWriteDefaults
    ? {
        filename: CONFIG_PATH,
        payload: JSON.stringify(settings, null, 2),
        encoding: 'utf8'
    }
    : null;

return [refreshMsg, fileMsg];