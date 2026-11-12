// ==========================
// BUILD CONTROLLER CONSTANTS STATE
// ==========================
// Source of the function node "Build controller constants state" in flows.json.
// Purpose:
// - Holds the one list of constants the Constants page can edit: label, unit, default and range.
//   Every key is read live by "01 Battery + Grid Controller.js" (CONSTANT_SPECS there must have
//   the same defaults and ranges; the tests compare the two lists).
// - Reads the overrides file (exec stdout) into flow `controllerConstantsOverrides` and builds
//   the page payload: value, default and "custom" badge per field.
// - Publishes the list as flow `controllerConstantsSpec`, which "Save controller constants" (25)
//   validates against.
// Config file:
// - /data/home/nodered/grid-control-config/controller-constants.json (only the overridden keys)
// Input:
// - exec stdout (string payload) -> reload the overrides; any other msg -> rebuild from flow context
// Output (1):
// - output 1 -> topic `controller-constants-ui` for the "Controller constants editor" template
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/controller-constants.json';

// kind: 'mmdd' = calendar day as MMDD, 'int' = whole number; everything else is a decimal number.
const GROUPS = [
    {
        key: 'tariff_season',
        label: 'Capacity Tariff Season (summer / winter)',
        fields: [
            { key: 'WINTER_START_MMDD',         def: 1017, label: 'Winter starts (MMDD, 1017 = 17 Oct)', unit: '',  step: 1,   min: 101, max: 1231, kind: 'mmdd' },
            { key: 'SUMMER_START_MMDD',         def: 415,  label: 'Summer starts (MMDD, 415 = 15 Apr)',  unit: '',  step: 1,   min: 101, max: 1231, kind: 'mmdd' },
            { key: 'SUMMER_TARIFF_TIER',        def: 1,    label: 'Summer tier (1 = 0-2 kW)',            unit: '',  step: 1,   min: 1,   max: 6,    kind: 'int' },
            { key: 'WINTER_TARIFF_TIER',        def: 2,    label: 'Winter tier (2 = 2-5 kW)',            unit: '',  step: 1,   min: 1,   max: 6,    kind: 'int' },
            { key: 'SUMMER_NIGHT_BONUS_PCT',    def: 46,   label: 'Summer night extra (22-06)',          unit: '%', step: 1,   min: 0,   max: 60 },
            { key: 'WINTER_NIGHT_BONUS_PCT',    def: 30,   label: 'Winter night extra (22-06)',          unit: '%', step: 1,   min: 0,   max: 60 },
            { key: 'TARIFF_TIER_MARGIN_W',      def: 50,   label: 'Day setpoint margin below tier',      unit: 'W', step: 10,  min: 0,   max: 1000 },
            { key: 'TARIFF_NIGHT_BILLING_PCT',  def: 70,   label: 'Night billing weight',                unit: '%', step: 1,   min: 10,  max: 100 },
            { key: 'TARIFF_SEASON_FORCE',       def: 0,    label: 'Season mode (0 auto, 1 summer, 2 winter)', unit: '', step: 1, min: 0, max: 2,    kind: 'int' },
            { key: 'GRID_NOMINAL_VOLTAGE',      def: 230,  label: 'Grid voltage for current calc',       unit: 'V', step: 1,   min: 200, max: 250 },
            { key: 'GRID_CURRENT_HEADROOM_PCT', def: 10,   label: 'Grid current headroom over setpoint', unit: '%', step: 1,   min: 0,   max: 30 },
            { key: 'GRID_CURRENT_MAX_A',        def: 32,   label: 'Max grid input current (fuse)',       unit: 'A', step: 0.5, min: 5,   max: 50 }
        ]
    },
    {
        key: 'schedule',
        label: 'Grid Setpoint Limits',
        fields: [
            { key: 'MIN_GRID_SETPOINT',         def: 200,  label: 'Minimum grid setpoint',               unit: 'W', step: 10,  min: 50,  max: 1000 },
            { key: 'MAX_GRID_STEP_W',           def: 100,  label: 'Max high-voltage step per update',    unit: 'W', step: 10,  min: 10,  max: 500 }
        ]
    },
    {
        key: 'charge',
        label: 'Battery Charging',
        fields: [
            { key: 'MAX_CHARGE_CURRENT',        def: 25,   label: 'Max charge current',                  unit: 'A',  step: 1,   min: 1,  max: 50 },
            { key: 'RESTORE_AH_DEADBAND',       def: 0.5,  label: 'Restore Ah deadband',                 unit: 'Ah', step: 0.1, min: 0,  max: 10 },
            { key: 'BATTERY_NOMINAL_VOLTAGE',   def: 53,   label: 'Nominal battery voltage (fallback)',  unit: 'V',  step: 1,   min: 40, max: 60 }
        ]
    },
    {
        key: 'solar',
        label: 'Solar Forecast',
        fields: [
            { key: 'SOLAR_TO_BATTERY_EFFICIENCY',  def: 0.9, label: 'Solar→battery efficiency',          unit: '',  step: 0.01, min: 0.5, max: 1 },
            { key: 'SOLAR_FORECAST_MAX_AGE_HOURS', def: 18,  label: 'Max forecast age',                  unit: 'h', step: 1,    min: 1,   max: 48 }
        ]
    },
    {
        key: 'manual_discharge',
        label: 'Manual Discharge',
        fields: [
            { key: 'MANUAL_DISCHARGE_MAX_CURRENT',   def: 20,   label: 'Max discharge current',          unit: 'A', step: 1,   min: 1,  max: 50 },
            { key: 'MANUAL_DISCHARGE_STOP_VOLTAGE',  def: 54,   label: 'Auto-stop voltage',              unit: 'V', step: 0.1, min: 40, max: 60 },
            { key: 'MANUAL_DISCHARGE_MIN_GRID_W',    def: 200,  label: 'Min grid during discharge',      unit: 'W', step: 10,  min: 0,  max: 1000 },
            { key: 'MANUAL_DISCHARGE_MAX_AC_LOAD_W', def: 3000, label: 'Max AC load to allow discharge', unit: 'W', step: 100, min: 0,  max: 10000 }
        ]
    },
    {
        key: 'day_high_load',
        label: 'Day High Load (setpoint reduction outside 22-06)',
        fields: [
            { key: 'DAY_HIGH_AC_LOAD_THRESHOLD_W', def: 4000, label: 'AC load above which the setpoint is lowered', unit: 'W', step: 100, min: 1000, max: 10000 },
            { key: 'DAY_HIGH_AC_LOAD_REDUCTION_W', def: 100,  label: 'Setpoint reduction',                          unit: 'W', step: 10,  min: 0,    max: 1000 }
        ]
    }
];

const spec = {};
GROUPS.forEach(group => group.fields.forEach(field => {
    spec[field.key] = { def: field.def, min: field.min, max: field.max, kind: field.kind || 'number' };
}));
flow.set('controllerConstantsSpec', spec);

// Overrides: from the file (exec stdout is always a string) or from flow context.
let overrides = flow.get('controllerConstantsOverrides') || {};
if (typeof msg.payload === 'string') {
    overrides = {};
    try {
        const parsed = JSON.parse(msg.payload.trim() || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            overrides = parsed;
        }
    } catch (e) {
        // malformed file - use the defaults
    }
    flow.set('controllerConstantsOverrides', overrides);
}

const isOverridden = key => Object.prototype.hasOwnProperty.call(overrides, key);

return {
    topic: 'controller-constants-ui',
    payload: {
        groups: GROUPS.map(group => ({
            key: group.key,
            label: group.label,
            fields: group.fields.map(field => ({
                key: field.key,
                label: field.label,
                unit: field.unit,
                step: field.step,
                min: field.min,
                max: field.max,
                value: isOverridden(field.key) ? overrides[field.key] : field.def,
                defaultValue: field.def,
                isOverridden: isOverridden(field.key)
            }))
        })),
        configPath: CONFIG_PATH,
        // Keys of older versions that are still in the file are not counted.
        overrideCount: Object.keys(spec).filter(isOverridden).length,
        updatedAt: new Date().toISOString()
    }
};
