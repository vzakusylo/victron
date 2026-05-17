// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `25 Save controller constants.js` and the embedded `func` for "Save controller constants"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Receives a 'save-controller-constants' message from the dashboard.
// - Validates each field against its allowed range.
// - Persists only values that differ from the hardcoded defaults.
// - Returns a file-write message and a status message.
// Config file:
// - /data/home/nodered/grid-control-config/controller-constants.json
// Input:
// - msg.topic = 'save-controller-constants'
// - msg.payload = { KEY: value, ... }  (only fields the user changed)
// Outputs (2):
// - output 1 -> file write msg (filename + payload JSON string)
// - output 2 -> status msg for the dashboard
// Change notes:
// 1. Initial version.
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/controller-constants.json';

const DEFAULTS = {
    DAY_BASE_GRID_SETPOINT:     1950,
    NIGHT_BASE_GRID_SETPOINT:   2850,
    DAY_HOURLY_BUDGET_W:        1950,
    NIGHT_HOURLY_BUDGET_W:      2850,
    MAX_CHARGE_CURRENT:         25,
    RESTORE_AH_DEADBAND:        0.5,
    BATTERY_NOMINAL_VOLTAGE:    52,
    SOLAR_TO_BATTERY_EFFICIENCY: 0.9,
    SOLAR_FORECAST_MAX_AGE_HOURS: 18,
    MIN_GRID_SETPOINT:          200,
    MAX_GRID_STEP_W:            100,
    MANUAL_DISCHARGE_MAX_CURRENT:  20,
    MANUAL_DISCHARGE_STOP_VOLTAGE: 54,
    MANUAL_DISCHARGE_MIN_GRID_W:   200,
    MANUAL_DISCHARGE_MAX_AC_LOAD_W: 3000,
    HV_START:    55.4,
    HV_RELEASE:  55.2,
    HV_FULL:     55.6,
    HV_GRID_SUPPORT_MAX_W:  1000,
    FORCE_CHARGE_MAX_W:     3000,
    HEAVY_LOAD_THRESHOLD_W:    4000,
    HEAVY_LOAD_RELEASE_W:      2500,
    HEAVY_LOAD_GRID_SETPOINT_W: 1700
};

const RANGES = {
    DAY_BASE_GRID_SETPOINT:     { min: 500,  max: 5000 },
    NIGHT_BASE_GRID_SETPOINT:   { min: 500,  max: 5000 },
    DAY_HOURLY_BUDGET_W:        { min: 500,  max: 5000 },
    NIGHT_HOURLY_BUDGET_W:      { min: 500,  max: 5000 },
    MAX_CHARGE_CURRENT:         { min: 1,    max: 50   },
    RESTORE_AH_DEADBAND:        { min: 0,    max: 10   },
    BATTERY_NOMINAL_VOLTAGE:    { min: 40,   max: 60   },
    SOLAR_TO_BATTERY_EFFICIENCY: { min: 0.5, max: 1.0  },
    SOLAR_FORECAST_MAX_AGE_HOURS: { min: 1,  max: 48   },
    MIN_GRID_SETPOINT:          { min: 50,   max: 1000 },
    MAX_GRID_STEP_W:            { min: 10,   max: 500  },
    MANUAL_DISCHARGE_MAX_CURRENT:  { min: 1, max: 50   },
    MANUAL_DISCHARGE_STOP_VOLTAGE: { min: 40, max: 60  },
    MANUAL_DISCHARGE_MIN_GRID_W:   { min: 0, max: 1000 },
    MANUAL_DISCHARGE_MAX_AC_LOAD_W: { min: 0, max: 10000 },
    HEAVY_LOAD_THRESHOLD_W:    { min: 1000, max: 10000 },
    HEAVY_LOAD_RELEASE_W:      { min: 500,  max: 9000  },
    HEAVY_LOAD_GRID_SETPOINT_W: { min: 200, max: 3000  }
};

if (msg.topic !== 'save-controller-constants' || !msg.payload || typeof msg.payload !== 'object') {
    return null;
}

const incoming = msg.payload;
const errors = [];
const overrides = {};

Object.keys(incoming).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        return; // ignore unknown keys
    }
    const raw = Number(incoming[key]);
    if (!Number.isFinite(raw)) {
        errors.push(`${key}: not a number`);
        return;
    }
    const range = RANGES[key];
    if (range && (raw < range.min || raw > range.max)) {
        errors.push(`${key}: ${raw} out of range [${range.min}–${range.max}]`);
        return;
    }
    // Only persist if different from default
    if (raw !== DEFAULTS[key]) {
        overrides[key] = raw;
    }
});

// Cross-field: HEAVY_LOAD_THRESHOLD > HEAVY_LOAD_RELEASE
const hlThresh = overrides.HEAVY_LOAD_THRESHOLD_W !== undefined
    ? overrides.HEAVY_LOAD_THRESHOLD_W
    : DEFAULTS.HEAVY_LOAD_THRESHOLD_W;
const hlRelease = overrides.HEAVY_LOAD_RELEASE_W !== undefined
    ? overrides.HEAVY_LOAD_RELEASE_W
    : DEFAULTS.HEAVY_LOAD_RELEASE_W;
if (hlThresh <= hlRelease) {
    errors.push(`HEAVY_LOAD_THRESHOLD_W (${hlThresh}) must be > HEAVY_LOAD_RELEASE_W (${hlRelease})`);
}

if (errors.length > 0) {
    return [
        null,
        {
            topic: 'controller-constants-save-status',
            payload: { ok: false, message: 'Validation errors: ' + errors.join('; '), errors }
        }
    ];
}

flow.set('controllerConstantsOverrides', overrides);

const fileMsg = {
    filename: CONFIG_PATH,
    payload: JSON.stringify(overrides, null, 2),
    encoding: 'utf8'
};

const statusMsg = {
    topic: 'controller-constants-save-status',
    payload: {
        ok: true,
        message: `Saved ${Object.keys(overrides).length} override(s). Restart controller or reload settings to apply.`,
        overrideCount: Object.keys(overrides).length,
        savedAt: new Date().toISOString()
    }
};

return [fileMsg, statusMsg];
