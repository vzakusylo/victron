//! @shared
//! lib/grid/constants.js: tariff / window constants and the settings specs.
//! Included into the controller and bookkeeping nodes by `// #include`; it runs in each
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ==========================
// CONSTANTS
// ==========================
// Elvenett kapasitetsledd tiers: upper bound of the monthly average (W) for tier 1..6.
// Tier = average of the 3 highest hourly imports on 3 different days of the month.
const TARIFF_TIER_LIMITS_W = [2000, 5000, 10000, 15000, 20000, 25000];
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;
const MORNING_END_HOUR = 12;
const EVENING_START_HOUR = 17;
const MORNING_SOLAR_HOLD_VOLTAGE = 53.7;

// Every key can be overridden on the Constants page (flow `controllerConstantsOverrides`).
// Keep defaults and ranges equal to "24 Build controller constants state.js" (checked by the tests).
// - mmdd: a calendar day as MMDD; int: whole number, a value outside the range falls back to the default;
// - everything else is clamped to [min, max].
const CONSTANT_SPECS = Object.freeze({
    WINTER_START_MMDD: { def: 1017, mmdd: true },
    SUMMER_START_MMDD: { def: 415, mmdd: true },
    SUMMER_TARIFF_TIER: { def: 1, min: 1, max: TARIFF_TIER_LIMITS_W.length, int: true },
    WINTER_TARIFF_TIER: { def: 2, min: 1, max: TARIFF_TIER_LIMITS_W.length, int: true },
    SUMMER_NIGHT_BONUS_PCT: { def: 46, min: 0, max: 60 },
    WINTER_NIGHT_BONUS_PCT: { def: 30, min: 0, max: 60 },
    TARIFF_TIER_MARGIN_W: { def: 50, min: 0, max: 1000 },
    TARIFF_NIGHT_BILLING_PCT: { def: 70, min: 10, max: 100 },
    TARIFF_SEASON_FORCE: { def: 0, min: 0, max: 2, int: true },
    GRID_NOMINAL_VOLTAGE: { def: 230, min: 200, max: 250 },
    GRID_CURRENT_HEADROOM_PCT: { def: 10, min: 0, max: 30 },
    GRID_CURRENT_MAX_A: { def: 32, min: 5, max: 50 },
    MIN_GRID_SETPOINT: { def: 200, min: 50, max: 1000 },
    MAX_GRID_STEP_W: { def: 100, min: 10, max: 500 },
    MAX_CHARGE_CURRENT: { def: 25, min: 1, max: 50 },
    RESTORE_AH_DEADBAND: { def: 0.5, min: 0, max: 10 },
    BATTERY_NOMINAL_VOLTAGE: { def: 53, min: 40, max: 60 },
    SOLAR_TO_BATTERY_EFFICIENCY: { def: 0.9, min: 0.5, max: 1 },
    SOLAR_FORECAST_MAX_AGE_HOURS: { def: 18, min: 1, max: 48 },
    MANUAL_DISCHARGE_MAX_CURRENT: { def: 20, min: 1, max: 50 },
    MANUAL_DISCHARGE_STOP_VOLTAGE: { def: 54, min: 40, max: 60 },
    MANUAL_DISCHARGE_MIN_GRID_W: { def: 200, min: 0, max: 1000 },
    MANUAL_DISCHARGE_MAX_AC_LOAD_W: { def: 3000, min: 0, max: 10000 },
    DAY_HIGH_AC_LOAD_THRESHOLD_W: { def: 4000, min: 1000, max: 10000 },
    DAY_HIGH_AC_LOAD_REDUCTION_W: { def: 100, min: 0, max: 1000 }
});

// Protection page settings (flow `highVoltageSettings`). Keep equal to 05 / 06 / 07.
const DEFAULT_HIGH_VOLTAGE_SETTINGS = Object.freeze({
    enabled: true,
    start: 55.2,
    release: 55.0,
    full: 55.4,
    gridSupportW: 0,
    gridSupportMode: "hybrid",
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
});
const HV_BOOLEAN_FIELDS = ["enabled", "gridSupportDisableNoSun", "exportGuardEnabled", "forceChargeEnabled", "forceChargeLimiterEnabled"];
// Whole numbers clamped to [min, max]; a value that is not a number falls back to the default.
const HV_CLAMPED_FIELDS = Object.freeze({
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
});
// Whole numbers that make the whole settings object invalid when out of range.
const HV_STRICT_FIELDS = Object.freeze({
    gridSupportW: [0, 1000],
    forceChargeGridW: [0, 3000]
});
const HV_VOLTAGE_RANGE = [50, 60];
const FORCE_CHARGE_VOLTAGE_RANGE = [40, 60];
const GRID_SUPPORT_MODE_HV_ONLY = "hv-only";
const GRID_SUPPORT_MODE_ADAPTIVE_DAY = "adaptive-day";
const GRID_SUPPORT_MODE_HYBRID = "hybrid";

// Grid export guard tuning
const EXPORT_GUARD_GAIN = 0.5;
const EXPORT_GUARD_MAX_STEP_W = 200;
const EXPORT_GUARD_MAX_BOOST_W = 2000;
const EXPORT_GUARD_RELEASE_DEADBAND_W = 50;
const EXPORT_GUARD_UPDATE_INTERVAL_MS = 15000;
