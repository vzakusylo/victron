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
// 2. Replaced the fixed day/night setpoint keys with the capacity tariff season keys.
//    MMDD dates are validated as real calendar days; tiers and season mode must be integers.
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/controller-constants.json';

const DEFAULTS = {
    WINTER_START_MMDD:          1017,
    SUMMER_START_MMDD:          415,
    SUMMER_TARIFF_TIER:         1,
    WINTER_TARIFF_TIER:         2,
    SUMMER_NIGHT_BONUS_PCT:     46,
    WINTER_NIGHT_BONUS_PCT:     30,
    TARIFF_TIER_MARGIN_W:       50,
    TARIFF_NIGHT_BILLING_PCT:   70,
    TARIFF_SEASON_FORCE:        0,
    GRID_NOMINAL_VOLTAGE:       230,
    GRID_CURRENT_HEADROOM_PCT:  10,
    GRID_CURRENT_MAX_A:         32,
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
    WINTER_START_MMDD:          { min: 101,  max: 1231 },
    SUMMER_START_MMDD:          { min: 101,  max: 1231 },
    SUMMER_TARIFF_TIER:         { min: 1,    max: 6    },
    WINTER_TARIFF_TIER:         { min: 1,    max: 6    },
    SUMMER_NIGHT_BONUS_PCT:     { min: 0,    max: 60   },
    WINTER_NIGHT_BONUS_PCT:     { min: 0,    max: 60   },
    TARIFF_TIER_MARGIN_W:       { min: 0,    max: 1000 },
    TARIFF_NIGHT_BILLING_PCT:   { min: 10,   max: 100  },
    TARIFF_SEASON_FORCE:        { min: 0,    max: 2    },
    GRID_NOMINAL_VOLTAGE:       { min: 200,  max: 250  },
    GRID_CURRENT_HEADROOM_PCT:  { min: 0,    max: 30   },
    GRID_CURRENT_MAX_A:         { min: 5,    max: 50   },
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

const MMDD_KEYS = ['WINTER_START_MMDD', 'SUMMER_START_MMDD'];
const INTEGER_KEYS = MMDD_KEYS.concat(['SUMMER_TARIFF_TIER', 'WINTER_TARIFF_TIER', 'TARIFF_SEASON_FORCE']);

function isValidMmdd(value) {
    const month = Math.floor(value / 100);
    const day = value % 100;
    // 2024 is a leap year, so 29 Feb is accepted.
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(2024, month, 0).getDate();
}

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
    if (INTEGER_KEYS.includes(key) && !Number.isInteger(raw)) {
        errors.push(`${key}: ${raw} must be a whole number`);
        return;
    }
    if (MMDD_KEYS.includes(key) && !isValidMmdd(raw)) {
        errors.push(`${key}: ${raw} is not a valid MMDD date (e.g. 1017 = 17 Oct)`);
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
