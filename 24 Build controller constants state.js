// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `24 Build controller constants state.js` and the embedded `func` for "Build controller constants state"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads persisted overrides from `/data/home/nodered/grid-control-config/controller-constants.json`
//   (written by "Save controller constants") and merges them with the hardcoded defaults.
// - Emits one dashboard UI payload so the Controller Settings page shows live values
//   and distinguishes overridden vs. default values.
// Input:
// - msg (any) -> triggers a rebuild; exec stdout when topic = 'constants-file-loaded'
// Output (1):
// - output 1 -> msg with topic 'controller-constants-ui' and payload for the dashboard template
// Change notes:
// 1. Initial version.
// 2. Replaced the fixed day/night setpoints with the capacity tariff season group
//    (winter/summer start dates, tier per season, night extra %, safe grid current inputs).
//    The controller reads these keys live from flow `controllerConstantsOverrides`.
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/controller-constants.json';

// Hardcoded defaults — mirrors 01 Battery + Grid Controller.js constants
const DEFAULTS = {
    // Capacity tariff season (day/night setpoints and grid current are derived from these)
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
    // Charge
    MAX_CHARGE_CURRENT:         25,
    RESTORE_AH_DEADBAND:        0.5,
    BATTERY_NOMINAL_VOLTAGE:    52,
    // Solar
    SOLAR_TO_BATTERY_EFFICIENCY: 0.9,
    SOLAR_FORECAST_MAX_AGE_HOURS: 18,
    // Grid setpoint limits
    MIN_GRID_SETPOINT:          200,
    MAX_GRID_STEP_W:            100,
    // Manual discharge
    MANUAL_DISCHARGE_MAX_CURRENT:  20,
    MANUAL_DISCHARGE_STOP_VOLTAGE: 54,
    MANUAL_DISCHARGE_MIN_GRID_W:   200,
    MANUAL_DISCHARGE_MAX_AC_LOAD_W: 3000,
    // HV protection defaults
    HV_START:    55.4,
    HV_RELEASE:  55.2,
    HV_FULL:     55.6,
    HV_GRID_SUPPORT_MAX_W:  1000,
    FORCE_CHARGE_MAX_W:     3000,
    // Heavy-load
    HEAVY_LOAD_THRESHOLD_W:    4000,
    HEAVY_LOAD_RELEASE_W:      2500,
    HEAVY_LOAD_GRID_SETPOINT_W: 1700
};

// Groups for the UI
const GROUPS = [
    {
        key: 'tariff_season',
        label: 'Capacity Tariff Season (summer / winter)',
        fields: [
            { key: 'WINTER_START_MMDD',         label: 'Winter starts (MMDD, 1017 = 17 Oct)', unit: '',  step: 1,   min: 101, max: 1231 },
            { key: 'SUMMER_START_MMDD',         label: 'Summer starts (MMDD, 415 = 15 Apr)',  unit: '',  step: 1,   min: 101, max: 1231 },
            { key: 'SUMMER_TARIFF_TIER',        label: 'Summer tier (1 = 0-2 kW)',            unit: '',  step: 1,   min: 1,   max: 6    },
            { key: 'WINTER_TARIFF_TIER',        label: 'Winter tier (2 = 2-5 kW)',            unit: '',  step: 1,   min: 1,   max: 6    },
            { key: 'SUMMER_NIGHT_BONUS_PCT',    label: 'Summer night extra (22-06)',          unit: '%', step: 1,   min: 0,   max: 60   },
            { key: 'WINTER_NIGHT_BONUS_PCT',    label: 'Winter night extra (22-06)',          unit: '%', step: 1,   min: 0,   max: 60   },
            { key: 'TARIFF_TIER_MARGIN_W',      label: 'Day setpoint margin below tier',      unit: 'W', step: 10,  min: 0,   max: 1000 },
            { key: 'TARIFF_NIGHT_BILLING_PCT',  label: 'Night billing weight',                unit: '%', step: 1,   min: 10,  max: 100  },
            { key: 'TARIFF_SEASON_FORCE',       label: 'Season mode (0 auto, 1 summer, 2 winter)', unit: '', step: 1, min: 0, max: 2    },
            { key: 'GRID_NOMINAL_VOLTAGE',      label: 'Grid voltage for current calc',       unit: 'V', step: 1,   min: 200, max: 250  },
            { key: 'GRID_CURRENT_HEADROOM_PCT', label: 'Grid current headroom over setpoint', unit: '%', step: 1,   min: 0,   max: 30   },
            { key: 'GRID_CURRENT_MAX_A',        label: 'Max grid input current (fuse)',       unit: 'A', step: 0.5, min: 5,   max: 50   }
        ]
    },
    {
        key: 'schedule',
        label: 'Grid Setpoint Limits',
        fields: [
            { key: 'MIN_GRID_SETPOINT',         label: 'Minimum grid setpoint', unit: 'W', step: 10,  min: 50,   max: 1000 },
            { key: 'MAX_GRID_STEP_W',           label: 'Max smoothing step',  unit: 'W',   step: 10,  min: 10,   max: 500  }
        ]
    },
    {
        key: 'charge',
        label: 'Battery Charging',
        fields: [
            { key: 'MAX_CHARGE_CURRENT',        label: 'Max charge current',  unit: 'A',   step: 1,   min: 1,    max: 50   },
            { key: 'RESTORE_AH_DEADBAND',       label: 'Restore Ah deadband', unit: 'Ah',  step: 0.1, min: 0,    max: 10   },
            { key: 'BATTERY_NOMINAL_VOLTAGE',   label: 'Nominal battery voltage', unit: 'V', step: 1, min: 40,   max: 60   }
        ]
    },
    {
        key: 'solar',
        label: 'Solar Forecast',
        fields: [
            { key: 'SOLAR_TO_BATTERY_EFFICIENCY',  label: 'Solar→battery efficiency', unit: '',   step: 0.01, min: 0.5, max: 1.0 },
            { key: 'SOLAR_FORECAST_MAX_AGE_HOURS', label: 'Max forecast age',           unit: 'h', step: 1,    min: 1,   max: 48  }
        ]
    },
    {
        key: 'manual_discharge',
        label: 'Manual Discharge',
        fields: [
            { key: 'MANUAL_DISCHARGE_MAX_CURRENT',  label: 'Max discharge current',  unit: 'A', step: 1,  min: 1,   max: 50   },
            { key: 'MANUAL_DISCHARGE_STOP_VOLTAGE', label: 'Auto-stop voltage',       unit: 'V', step: 0.1, min: 40, max: 60   },
            { key: 'MANUAL_DISCHARGE_MIN_GRID_W',   label: 'Min grid during discharge', unit: 'W', step: 10, min: 0, max: 1000 },
            { key: 'MANUAL_DISCHARGE_MAX_AC_LOAD_W', label: 'Max AC load to allow discharge', unit: 'W', step: 100, min: 0, max: 10000 }
        ]
    },
    {
        key: 'heavy_load',
        label: 'Heavy-Load Suppression',
        fields: [
            { key: 'HEAVY_LOAD_THRESHOLD_W',    label: 'Activation threshold', unit: 'W', step: 100, min: 1000, max: 10000 },
            { key: 'HEAVY_LOAD_RELEASE_W',      label: 'Release threshold',    unit: 'W', step: 100, min: 500,  max: 9000  },
            { key: 'HEAVY_LOAD_GRID_SETPOINT_W', label: 'Grid cap during heavy load', unit: 'W', step: 50, min: 200, max: 3000 }
        ]
    }
];

// Parse persisted overrides — exec stdout always has string payload
let overrides = {};
if (typeof msg.payload === 'string') {
    const raw = msg.payload.trim();
    if (raw && raw !== '{}') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                overrides = parsed;
            }
        } catch (e) {
            // malformed file - ignore, use defaults
        }
    }
    flow.set('controllerConstantsOverrides', overrides);
} else {
    overrides = flow.get('controllerConstantsOverrides') || {};
}

// Build merged values
const merged = {};
Object.keys(DEFAULTS).forEach(k => {
    merged[k] = Object.prototype.hasOwnProperty.call(overrides, k)
        ? overrides[k]
        : DEFAULTS[k];
});

// Build UI payload
const groupPayloads = GROUPS.map(group => ({
    key: group.key,
    label: group.label,
    fields: group.fields.map(f => ({
        key: f.key,
        label: f.label,
        unit: f.unit,
        step: f.step,
        min: f.min,
        max: f.max,
        value: merged[f.key],
        defaultValue: DEFAULTS[f.key],
        isOverridden: Object.prototype.hasOwnProperty.call(overrides, f.key)
    }))
}));

return {
    topic: 'controller-constants-ui',
    payload: {
        groups: groupPayloads,
        configPath: CONFIG_PATH,
        overrideCount: Object.keys(overrides).length,
        updatedAt: new Date().toISOString()
    }
};
