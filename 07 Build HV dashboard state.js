// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `07 Build HV dashboard state.js` and the embedded `func` for "Build HV dashboard state"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads highVoltageSettings from flow context and the latest controller trace,
//   then builds the complete UI state payload for the HV settings / diagnostics dashboard panel.
// Input:
// - msg (any) -> triggers a rebuild from flow context
// Flow context read:
// - `highVoltageSettings`  -> current HV protection settings
// - `dashboardControllerTrace` -> latest controller trace for live diagnostics
// Output (1):
// - output 1 -> dashboard state payload { settings, trace } for the HV panel
// Change notes:
// 1. Initial version.
// ==========================
const DEFAULT_SETTINGS = {
    enabled: true,
    start: 55.4,
    release: 55.2,
    full: 55.6,
    gridSupportW: 0,
    forceChargeEnabled: false,
    forceChargeGridW: 0,
    forceChargeLimiterEnabled: false,
    forceChargeLimiterStart: 53,
    forceChargeLimiterRelease: 54,
    forceChargeLimiterFull: 52,
    source: 'default',
    updatedAt: ''
};

const current = flow.get('highVoltageSettings') || DEFAULT_SETTINGS;
const status = msg.hvStatus || {};
const trace = flow.get('dashboardControllerTrace') || null;
const protectionEnabled = current.enabled !== false;
const protectionRunning = protectionEnabled && Boolean(trace && trace.voltageLimitActive);
const protectionStatusLabel = protectionEnabled ? (protectionRunning ? 'Running' : 'Idle') : 'Disabled';
const forceChargeEnabled = current.forceChargeEnabled === true;
const forceChargeGridW = Math.max(0, Math.round(Number(current.forceChargeGridW) || 0));
const currentChargingPowerW = Math.max(0, Math.round(Number(trace && trace.currentChargingPowerW) || 0));
const forceChargeRunning = forceChargeEnabled && currentChargingPowerW > 0;
const forceChargeStatusLabel = forceChargeEnabled ? (forceChargeRunning ? 'Running' : 'Armed') : 'Disabled';

return {
    topic: 'high-voltage-settings-ui',
    payload: {
        enabled: protectionEnabled,
        start: Number(current.start) || DEFAULT_SETTINGS.start,
        release: Number(current.release) || DEFAULT_SETTINGS.release,
        full: Number(current.full) || DEFAULT_SETTINGS.full,
        gridSupportW: Math.max(0, Math.round(Number(current.gridSupportW) || 0)),
        forceChargeEnabled,
        forceChargeGridW,
        forceChargeLimiterEnabled: current.forceChargeLimiterEnabled === true,
        forceChargeLimiterStart: Number(current.forceChargeLimiterStart) || DEFAULT_SETTINGS.forceChargeLimiterStart,
        forceChargeLimiterRelease: Number(current.forceChargeLimiterRelease) || DEFAULT_SETTINGS.forceChargeLimiterRelease,
        forceChargeLimiterFull: Number(current.forceChargeLimiterFull) || DEFAULT_SETTINGS.forceChargeLimiterFull
    },
    meta: {
        source: current.source || DEFAULT_SETTINGS.source,
        updatedAt: current.updatedAt || '',
        level: status.level || 'info',
        protectionStatus: protectionStatusLabel,
        forceChargeStatus: forceChargeStatusLabel,
        currentChargingPowerW,
        gridSupportW: Math.max(0, Math.round(Number(current.gridSupportW) || 0)),
        forceChargeGridW,
        message: status.message || 'Use Save to persist protection changes.'
    }
};