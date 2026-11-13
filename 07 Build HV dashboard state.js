// ==========================
// BUILD HV DASHBOARD STATE
// ==========================
// Source of the function node "Build HV dashboard state" in flows.json.
// Purpose:
// - Builds the payload of the Protection page: the saved settings (flow `highVoltageSettings`,
//   already validated by 05 / 06) plus live status from the controller trace.
// Input:
// - any msg -> rebuild; msg.hvStatus = { level, message } from "Save HV settings from dashboard"
// Output (1):
// - output 1 -> topic `high-voltage-settings-ui` { payload: settings, meta: status }
// ==========================
// Keep equal to DEFAULT_SETTINGS in 05 / 06 and DEFAULT_HIGH_VOLTAGE_SETTINGS in 01.
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

const stored = flow.get('highVoltageSettings') || {};
const status = msg.hvStatus || {};
const trace = flow.get('dashboardControllerTrace') || {};

// A stored value wins, also when it is 0 or false; a missing one shows the default.
const settings = {};
Object.keys(DEFAULT_SETTINGS).forEach(key => {
    const value = stored[key];
    settings[key] = value === undefined || value === null || typeof value !== typeof DEFAULT_SETTINGS[key]
        ? DEFAULT_SETTINGS[key]
        : value;
});

const watts = value => Math.max(0, Math.round(Number(value) || 0));
const currentChargingPowerW = watts(trace.currentChargingPowerW);
const exportGuard = trace.exportGuard && typeof trace.exportGuard === 'object' ? trace.exportGuard : {};
const remainingForecastAh = Number(trace.remainingForecastAh);
const batteryRemainingAh = trace.batteryRemainingAh === null || trace.batteryRemainingAh === undefined
    ? Number.NaN
    : Number(trace.batteryRemainingAh);

return {
    topic: 'high-voltage-settings-ui',
    payload: settings,
    meta: {
        source: stored.source || 'default',
        updatedAt: stored.updatedAt || '',
        level: status.level || 'info',
        message: status.message || 'Use Save to persist protection changes.',
        protectionStatus: settings.enabled ? (trace.voltageLimitActive ? 'Running' : 'Idle') : 'Disabled',
        forceChargeStatus: settings.forceChargeEnabled ? (currentChargingPowerW > 0 ? 'Running' : 'Armed') : 'Disabled',
        currentChargingPowerW,
        forceChargeGridW: settings.forceChargeGridW,
        gridSupportW: settings.gridSupportW,
        gridSupportMode: settings.gridSupportMode,
        adaptiveGridSupportW: watts(trace.adaptiveGridSupportW),
        plannedGridSupportW: watts(trace.plannedGridSupportW),
        gridSupportLowSunBlocked: Boolean(trace.gridSupportLowSunBlocked),
        exportGuardStatus: settings.exportGuardEnabled ? (exportGuard.active ? 'Compensating' : 'Watching') : 'Disabled',
        exportGuardActive: Boolean(exportGuard.active),
        exportGuardBoostW: watts(exportGuard.boostW),
        gridPowerSignedW: Math.round(Number(trace.gridPowerSignedW) || 0),
        solarGenerationW: watts(trace.solarGenerationW),
        remainingForecastAh: Number.isFinite(remainingForecastAh) ? remainingForecastAh.toFixed(1) : '0.0',
        batteryRemainingAh: Number.isFinite(batteryRemainingAh) ? batteryRemainingAh.toFixed(1) : 'n/a'
    }
};
