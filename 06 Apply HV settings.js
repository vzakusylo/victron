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
    forceChargeEnabled: false,
    forceChargeGridW: 0
};
const MIN_SETTING = 50;
const MAX_SETTING = 60;
const MIN_GRID_SUPPORT_W = 0;
const MAX_GRID_SUPPORT_W = 1000;
const MIN_FORCE_CHARGE_W = 0;
const MAX_FORCE_CHARGE_W = 3000;

function normalizeSettings(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const enabled = value.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(value.enabled);
    const start = Number(value.start);
    const release = Number(value.release);
    const full = Number(value.full);
    const rawGridSupportW = value.gridSupportW === undefined ? DEFAULT_SETTINGS.gridSupportW : Number(value.gridSupportW);
    const rawForceChargeGridW = value.forceChargeGridW === undefined ? DEFAULT_SETTINGS.forceChargeGridW : Number(value.forceChargeGridW);
    const forceChargeEnabled = value.forceChargeEnabled === undefined ? DEFAULT_SETTINGS.forceChargeEnabled : Boolean(value.forceChargeEnabled);
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

    if (!inRange || !validGridSupportW || !validForceChargeGridW || !(full > start) || !(start >= release)) {
        return null;
    }

    return {
        enabled,
        start,
        release,
        full,
        gridSupportW,
        forceChargeEnabled,
        forceChargeGridW
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
const fileNeedsUpgrade = parsed && typeof parsed === 'object' && (parsed.enabled === undefined || parsed.gridSupportW === undefined || parsed.forceChargeEnabled === undefined || parsed.forceChargeGridW === undefined);
const shouldWriteDefaults = !normalized || !rawText || Boolean(fileNeedsUpgrade);
const settings = normalized
    ? {
        enabled: normalized.enabled,
        start: normalized.start,
        release: normalized.release,
        full: normalized.full,
        gridSupportW: normalized.gridSupportW,
        forceChargeEnabled: normalized.forceChargeEnabled,
        forceChargeGridW: normalized.forceChargeGridW,
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