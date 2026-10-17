// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Flow version rule:
// - the Node-RED tab label in `flows.json` uses `d#<n>` as the deployed flow version marker
// - increment that marker every time `flows.json` changes so the active Node-RED flow version is visible
// - keep this file, the embedded controller function, and the tab version rule synchronized
// Current behavior implemented after iterative tuning:
// 1. This function now has 7 outputs:
//    - output 1 -> DVCC charge current limit (A)
//    - output 2 -> ESS grid setpoint (W)
//    - output 3 -> VE.Bus AC input current limit (A)
//    - output 4 -> notification/log message when the grid setpoint changes
//    - output 5 -> hourly energy rollover message for log/summary writers
//    - output 6 -> structured controller trace payload for debugging
//    - output 7 -> `tariff-history` shell command for the exec node that reads the month's energy files
// 2. The function accepts multiple message types:
//    - `topic = battery-voltage` -> updates battery voltage state
//    - `topic = battery-consumed-ah` -> updates the BMS net consumed Ah deficit
//    - `topic = grid-power` -> updates measured grid import power in W
//      (preferred source: GX System GRID CT sensor, e.g. `/Ac/Grid/L1/Power`)
//    - `topic = ac-load-power` -> updates measured AC loads power in W
//      (source: GX System `/Ac/Consumption/L1/Power`)
//    - `topic = dc-power` -> updates measured DC bus power in W
//      (source: GX System `/Dc/System/Power`; negative = DC source producing power onto the bus)
//    - `topic = pv-charger-power` -> updates measured PV charger power in W
//      (source: GX System `/Dc/Pv/Power`; always positive; MPPT charger output)
//    - `topic = manual-discharge` -> starts/stops a manual discharge override
//    - `topic = manual-discharge-stop-voltage` -> updates the manual discharge auto-stop voltage
//    - any other topic / inject -> recalculates outputs using stored state
// 3. Battery restoration uses BMS Consumed Amphours as the net deficit to refill.
// 4. Grid charging happens only in NIGHT and MORNING windows and runs at 25A when needed.
// 5. Night charging starts only when the remaining deficit can no longer be covered by
//    the remaining MORNING window alone; MORNING charges any remaining grid deficit.
// 6. Base grid setpoint schedule (see item 26, now derived from the tariff season):
//    - summer (tier 1): 2850W at night, 1950W during the rest of the day
//    - winter (tier 2): 6440W at night, 4950W during the rest of the day
// 7. High-voltage protection for unknown external MPPT charging:
//    - start limiting when battery voltage rises above 55.4V
//    - release only after voltage drops back to 55.2V or lower
//    - taper grid setpoint smoothly down to a minimum of 200W by 55.6V
// 8. Hourly import Wh is tracked for display only:
//    - integrates positive grid import within the current clock hour
//    - shows accumulated Wh together with the actual accumulation start/end time in status
//    - does not change charge current, grid setpoint, or any other output
// 9. Solar prediction is connected to restoration planning:
//    - reads `flow.solarForecastToday`
//    - accepts forecast only when it is for the current day and <= 18h old
//    - converts forecast energy to estimated battery Ah restoration
//    - subtracts predicted solar restoration from the grid-restoration target
//    - uses the forecasted energy amount directly; condition stays informational
//    - does not change grid setpoint directly
// 10. Remaining average watts left in the current hour are shown for info only when
//    tracking for that hour started at the beginning of the hour.
// 11. Final grid setpoint is the minimum of:
//    - base schedule
//    - high-voltage limit
// 12. Grid setpoint reduction due to battery over-voltage is smoothed so the battery does not
//     see large sudden load changes.
// 13. VE.Bus Input 1 current limit is controlled again by this function (output 3), see item 26.
// 14. A VRM notification is emitted when the grid setpoint changes.
// 15. `boostActive`, `activeWindow`, battery voltage, grid power, and display-only hourly Wh are
//     all stored in context.
// 16. `day-night.txt` and the embedded `func` in `flows.json` must always stay synchronized.
// 17. Increment the `d#<n>` tab version in `flows.json` every time the flow file changes.
// 18. AC loads hourly Wh is tracked for display only (same integration logic as grid import Wh).
// 19. Notifications are written to a daily file at `/data/grid-control-logs/grid-control-YYYY-MM-DD.log`.
//     Log files are kept forever (the 45-day cleanup is disabled, full history is required).
// 20. Manual discharge can be started/stopped with inject nodes:
//     - while active it overrides the normal schedule
//     - ESS grid setpoint is raised/lowered dynamically but never below 200W import
//     - battery discharge is capped to the equivalent of 20A using the live battery voltage
//     - the override is suspended whenever AC loads rise above 3000W
//     - when suspended by high load, normal day/night grid setpoint control is used
//     - the override auto-stops when battery voltage reaches the configured stop voltage or lower
// 21. DC bus power (`/Dc/System/Power` from GX System) is now captured as topic `dc-power`.
//     - negative value means a DC source (e.g. MPPT solar charger) is producing onto the bus
//     - stored in context as `dcPowerW`; shown in node status and included in controller trace
//     - informational only: does not affect grid setpoint or charge current decisions
// 22. Solar generation = PV charger power only.
//     - `solarGenerationW = pvChargerPowerW`
//     - DC System Power remains informational only and is not used as a solar source
//     - `solarBudget` integrates `solarGenerationW` per hour using the same `advanceHourBudget` logic
//     - on hour rollover `solarWh` is included in the hourly-energy message alongside gridWh and acWh
//     - live `solarUsedWh` is shown in node status as `Sol <n>Wh`
// 24. PV charger power (`/Dc/Pv/Power`) is captured as topic `pv-charger-power`.
//     - stored in context as `pvChargerPowerW`; this is the only live solar-generation input
// 23. AC Force Charging has optional voltage-based limiters (same concept as Grid CT Support).
//     - `forceChargeLimiterEnabled` enables automatic voltage-based activation/deactivation
//     - `forceChargeLimiterStart` (V): activate force charging when battery voltage drops to this
//     - `forceChargeLimiterRelease` (V): deactivate force charging when battery voltage rises to this
//     - `forceChargeLimiterFull` (V): charge at maximum DVCC (25A) when voltage is at or below this
//     - between Full and Start, effective charge power tapers from max down to forceChargeGridW
//     - when limiter is disabled, force charge behaves as before (always on when enabled flag is set)
// 25. Grid export guard (`exportGuardEnabled`, default on): power must never be pushed to the grid.
//     - `grid-power` is now stored signed; a negative GRID CT reading means export
//     - when export is detected the battery becomes the compensating load:
//       the DVCC charge limit is raised to (PV charger power + boost) / V so the Multi stops
//       inverting the external MPPT surplus, and the ESS setpoint is floored at
//       `gridSupportMinGridImportW` (the "Minimum grid import" setting)
//     - `boost` starts at (minimum import - CT reading) and is then integrated every
//       EXPORT_GUARD_UPDATE_INTERVAL_MS until the CT sits at the minimum import
//     - the guard releases itself once the boost decays to 0 (grid import stays above the minimum
//       without help); it overrides every other window including HV taper and manual discharge
//     - shown as `EXP:+<boost>W` in status/notifications and as `exportGuard` in the trace
// 26. Capacity tariff seasons (summer / winter) with automatic switch dates.
//     - winter from WINTER_START_MMDD (default 1017 = 17 Oct), summer from SUMMER_START_MMDD (default 415)
//     - each season targets a tier (summer 1 = <=2 kW, winter 2 = <=5 kW); `TARIFF_SEASON_FORCE` 1/2 pins it
//     - day setpoint = tier limit - TARIFF_TIER_MARGIN_W; night setpoint = day + season night extra %
//       (night hours are billed at TARIFF_NIGHT_BILLING_PCT, so +30 % still bills below the tier)
//     - hourly budget = the season setpoint; the VE.Bus input current limit (output 3) is the setpoint
//       + GRID_CURRENT_HEADROOM_PCT at GRID_NOMINAL_VOLTAGE, rounded to 0.5 A, capped at GRID_CURRENT_MAX_A;
//       it is sent when it changes and re-asserted on every hour rollover
//     - constants are read live from flow `controllerConstantsOverrides` (Constants dashboard page)
//     - daily grid import, today's billable peak hour, energy left today at the season plan and the
//       month's top-3-day average (= tier the month is heading for) are tracked in context
//       `tariffDay` / `tariffMonth`, shown in status and exported as `tariff` in the trace
// 27. Monthly energy CSV + history restore.
//     - the hourly-energy message (output 5) also carries billWh (night x billing %), peakW (max grid W
//       in the hour), setpointW (season plan for that hour), season (S/W) and coverageMin (integrated
//       minutes, 60 = full hour); "Format hourly energy line" appends it to `energy-YYYY-MM.csv`
//     - once per month (and after every redeploy) output 7 asks the exec node for the month's
//       `energy-YYYY-MM.csv` + legacy `energy-YYYY-MM-DD.log`; the reply (`topic = tariff-history`)
//       restores today's grid Wh / peak and the month's per-day billable peaks
// 28. Output 6 (trace) is throttled: sensor updates arrive several times per second and every trace
//     rebuilt the Analytics / Energy dashboards (charts, tables, raw file text) and the debug sidebar,
//     which kept Node-RED busy. Now at most one trace per TRACE_MIN_INTERVAL_MS (5 s) for sensor
//     topics; hour rollovers and any other topic (inject, manual, history) still trace immediately.
//     Control outputs 1-5 and 7 are not throttled.

// ==========================
// INPUT / OUTPUT TOPICS
// ==========================
const BATTERY_TOPIC = "battery-voltage";
const BATTERY_CONSUMED_AH_TOPIC = "battery-consumed-ah";
const GRID_TOPIC = "grid-power";
const AC_LOAD_TOPIC = "ac-load-power";
const MANUAL_DISCHARGE_TOPIC = "manual-discharge";
const MANUAL_DISCHARGE_STOP_VOLTAGE_TOPIC = "manual-discharge-stop-voltage";
const DC_POWER_TOPIC = "dc-power";
const PV_CHARGER_TOPIC = "pv-charger-power";
// Output 7 request and input reply (exec stdout) for the month energy history.
const TARIFF_HISTORY_TOPIC = "tariff-history";
const TARIFF_HISTORY_RETRY_MS = 60000;
// Output 6 (trace) throttle for the high-rate sensor topics.
const SENSOR_TOPICS = [BATTERY_TOPIC, BATTERY_CONSUMED_AH_TOPIC, GRID_TOPIC, AC_LOAD_TOPIC, DC_POWER_TOPIC, PV_CHARGER_TOPIC];
const TRACE_MIN_INTERVAL_MS = 5000;
const ENERGY_LOG_DIR = "/data/home/nodered/grid-control-logs";

// ==========================
// CONSTANTS
// ==========================
const MAX_CHARGE_CURRENT = 25;
const BATTERY_NOMINAL_VOLTAGE = 53;
const SOLAR_TO_BATTERY_EFFICIENCY = 0.9;
const RESTORE_AH_DEADBAND = 0.5;

const SOLAR_FORECAST_MAX_AGE_HOURS = 18;

// Elvenett kapasitetsledd tiers: upper bound of the monthly average (W) for tier 1..6.
// Tier = average of the 3 highest hourly imports on 3 different days of the month.
const TARIFF_TIER_LIMITS_W = [2000, 5000, 10000, 15000, 20000, 25000];
// Season / tier constants. Every key can be overridden on the dashboard Constants page
// (flow `controllerConstantsOverrides`, written by "Build/Save controller constants").
// Day setpoint = tier limit - margin; night setpoint = day setpoint + night extra %.
// Summer defaults reproduce the old fixed schedule: 1950 W day / 2850 W night (tier 1).
const DEFAULT_TARIFF_CONSTANTS = Object.freeze({
    WINTER_START_MMDD: 1017,
    SUMMER_START_MMDD: 415,
    SUMMER_TARIFF_TIER: 1,
    WINTER_TARIFF_TIER: 2,
    SUMMER_NIGHT_BONUS_PCT: 46,
    WINTER_NIGHT_BONUS_PCT: 30,
    TARIFF_TIER_MARGIN_W: 50,
    TARIFF_NIGHT_BILLING_PCT: 70,
    TARIFF_SEASON_FORCE: 0,
    GRID_NOMINAL_VOLTAGE: 230,
    GRID_CURRENT_HEADROOM_PCT: 10,
    GRID_CURRENT_MAX_A: 32
});

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
const HIGH_VOLTAGE_SETTINGS_MIN = 50;
const HIGH_VOLTAGE_SETTINGS_MAX = 60;
const HIGH_VOLTAGE_GRID_SUPPORT_MIN_W = 0;
const HIGH_VOLTAGE_GRID_SUPPORT_MAX_W = 1000;
const GRID_SUPPORT_MODE_HV_ONLY = "hv-only";
const GRID_SUPPORT_MODE_ADAPTIVE_DAY = "adaptive-day";
const GRID_SUPPORT_MODE_HYBRID = "hybrid";
const GRID_SUPPORT_BATTERY_CAPACITY_MIN_AH = 0;
const GRID_SUPPORT_BATTERY_CAPACITY_MAX_AH = 2000;
const GRID_SUPPORT_RESERVE_MIN_AH = 0;
const GRID_SUPPORT_RESERVE_MAX_AH = 1000;
const GRID_SUPPORT_HOUR_MIN = 0;
const GRID_SUPPORT_HOUR_MAX = 23;
const GRID_SUPPORT_MAX_DISCHARGE_MIN_A = 0;
const GRID_SUPPORT_MAX_DISCHARGE_MAX_A = 50;
const GRID_SUPPORT_FORECAST_CONFIDENCE_MIN_PCT = 0;
const GRID_SUPPORT_FORECAST_CONFIDENCE_MAX_PCT = 100;
const GRID_SUPPORT_SOLAR_ASSIST_GAIN_MIN_PCT = 0;
const GRID_SUPPORT_SOLAR_ASSIST_GAIN_MAX_PCT = 100;
const GRID_SUPPORT_WEAK_FORECAST_BLOCK_MIN_AH = 0;
const GRID_SUPPORT_WEAK_FORECAST_BLOCK_MAX_AH = 500;
const GRID_SUPPORT_MIN_GRID_IMPORT_MIN_W = 200;
const GRID_SUPPORT_MIN_GRID_IMPORT_MAX_W = 1000;
const GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MIN_W = 0;
const GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MAX_W = 5000;
const FORCE_CHARGE_MIN_W = 0;
const FORCE_CHARGE_MAX_W = 3000;
const MIN_GRID_SETPOINT = 200;
const MAX_GRID_STEP_W = 100;
const MANUAL_DISCHARGE_MIN_GRID_W = 200;
const MANUAL_DISCHARGE_MAX_AC_LOAD_W = 3000;
const MANUAL_DISCHARGE_STOP_VOLTAGE = 54;
const MANUAL_DISCHARGE_MAX_CURRENT = 20;
const DAY_HIGH_AC_LOAD_THRESHOLD_W = 4000;
const DAY_HIGH_AC_LOAD_REDUCTION_W = 100;
// Grid export guard tuning
const EXPORT_GUARD_GAIN = 0.5;
const EXPORT_GUARD_MAX_STEP_W = 200;
const EXPORT_GUARD_MAX_BOOST_W = 2000;
const EXPORT_GUARD_RELEASE_DEADBAND_W = 50;
const EXPORT_GUARD_UPDATE_INTERVAL_MS = 15000;

// ==========================
// TIME
// ==========================
const now = new Date();
const hour = now.getHours();
const minute = now.getMinutes();
const second = now.getSeconds();

// ==========================
// CONTEXT MEMORY
// ==========================
let boostActive = context.get("boostActive") || false;
const previousWindow = context.get("activeWindow") || "none";
let batteryVoltage = Number(context.get("batteryVoltage"));
const rawStoredConsumedAh = context.get("batteryConsumedAh");
let consumedAhDeficit = Number.isFinite(Number(rawStoredConsumedAh)) ? Math.max(0, Number(rawStoredConsumedAh)) : Number.NaN;
const rawStoredGridPower = context.get("gridPowerW");
let hasGridPowerReading = rawStoredGridPower !== undefined && rawStoredGridPower !== null && Number.isFinite(Number(rawStoredGridPower));
// Signed CT reading (negative = export); the clamped value feeds import-Wh tracking and floors.
const storedGridPowerSignedW = hasGridPowerReading ? Number(rawStoredGridPower) : 0;
const storedGridPowerW = Math.max(0, storedGridPowerSignedW);
let gridPowerW = storedGridPowerW;
let gridPowerSignedW = storedGridPowerSignedW;
let exportGuard = context.get("exportGuard") || {
    active: false,
    boostW: 0,
    since: "",
    lastAdjustTs: 0
};
const rawStoredAcLoadPower = context.get("acLoadPowerW");
const hasAcLoadReading = rawStoredAcLoadPower !== undefined && rawStoredAcLoadPower !== null && Number.isFinite(Number(rawStoredAcLoadPower));
const storedAcLoadPowerW = hasAcLoadReading ? Math.max(0, Number(rawStoredAcLoadPower)) : 0;
const rawStoredDcPower = context.get("dcPowerW");
const hasDcPowerReading = rawStoredDcPower !== undefined && rawStoredDcPower !== null && Number.isFinite(Number(rawStoredDcPower));
const storedDcPowerW = hasDcPowerReading ? Number(rawStoredDcPower) : 0;
const rawStoredPvChargerPower = context.get("pvChargerPowerW");
const storedPvChargerPowerW = rawStoredPvChargerPower !== undefined && rawStoredPvChargerPower !== null && Number.isFinite(Number(rawStoredPvChargerPower))
    ? Math.max(0, Number(rawStoredPvChargerPower))
    : 0;
const rawStoredManualDischargeStopVoltage = context.get("manualDischargeStopVoltage");
let voltageLimitActive = context.get("voltageLimitActive") || false;
const previousGridSetpoint = Number(context.get("gridSetpoint"));
let manualDischargeStopVoltage = Number.isFinite(Number(rawStoredManualDischargeStopVoltage))
    ? Number(rawStoredManualDischargeStopVoltage)
    : MANUAL_DISCHARGE_STOP_VOLTAGE;
let manualDischarge = context.get("manualDischarge") || {
    active: false,
    startedAt: "",
    source: ""
};
let hourBudget = context.get("hourBudget") || {
    hourKey: "",
    lastTs: 0,
    usedWh: 0,
    startTs: 0,
    fullHourCoverage: false
};
let acLoadBudget = context.get("acLoadBudget") || {
    hourKey: "",
    lastTs: 0,
    usedWh: 0,
    startTs: 0,
    fullHourCoverage: false
};
let solarBudget = context.get("solarBudget") || {
    hourKey: "",
    lastTs: 0,
    usedWh: 0,
    startTs: 0,
    fullHourCoverage: false
};
let forceChargeLimiterActive = context.get("forceChargeLimiterActive") || false;

// ==========================
// HELPERS
// ==========================
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function normalizeGridSupportMode(value) {
    const normalized = String(value || "").toLowerCase();

    if (normalized === GRID_SUPPORT_MODE_ADAPTIVE_DAY || normalized === GRID_SUPPORT_MODE_HYBRID) {
        return normalized;
    }

    return GRID_SUPPORT_MODE_HV_ONLY;
}

function sanitizeRoundedNumber(value, fallback, min, max) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return clamp(Math.round(numeric), min, max);
}

function isHourWithinWindow(hourValue, startHour, endHour) {
    if (startHour === endHour) {
        return true;
    }

    if (startHour < endHour) {
        return hourValue >= startHour && hourValue < endHour;
    }

    return hourValue >= startHour || hourValue < endHour;
}

function getWindowRemainingHours(date, startHour, endHour) {
    if (!isHourWithinWindow(date.getHours(), startHour, endHour)) {
        return 0;
    }

    if (startHour === endHour) {
        return 24;
    }

    const end = new Date(date);
    end.setHours(endHour, 0, 0, 0);

    if (startHour > endHour || end <= date) {
        end.setDate(end.getDate() + 1);
    }

    return Math.max(0, (end.getTime() - date.getTime()) / 3600000);
}

function getRemainingForecastWh(date, startHour, endHour) {
    const rawAdjustedForecast = flow.get("solarForecastAdjusted");
    const adjustedResult = rawAdjustedForecast && typeof rawAdjustedForecast.adjustedResult === "object"
        ? rawAdjustedForecast.adjustedResult
        : null;

    if (!adjustedResult) {
        return 0;
    }

    const todayKey = getDayKey(date);
    const currentHour = date.getHours();
    const currentHourFractionLeft = Math.max(0, 1 - ((date.getMinutes() * 60 + date.getSeconds()) / 3600));

    return Object.keys(adjustedResult).reduce((total, key) => {
        if (!String(key).startsWith(todayKey)) {
            return total;
        }

        const hourToken = String(key).substring(11, 13);
        const forecastHour = Number(hourToken);
        const hourlyForecastW = Math.max(0, Number(adjustedResult[key]) || 0);

        if (!Number.isInteger(forecastHour) || hourlyForecastW <= 0) {
            return total;
        }

        if (!isHourWithinWindow(forecastHour, startHour, endHour) || forecastHour < currentHour) {
            return total;
        }

        const fraction = forecastHour === currentHour ? currentHourFractionLeft : 1;
        return total + hourlyForecastW * fraction;
    }, 0);
}

function sanitizeHighVoltageSettings(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const enabled = value.enabled === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.enabled
        : Boolean(value.enabled);
    const start = Number(value.start);
    const release = Number(value.release);
    const full = Number(value.full);
    const rawGridSupportW = value.gridSupportW === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportW
        : Number(value.gridSupportW);
    const gridSupportMode = normalizeGridSupportMode(
        value.gridSupportMode === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportMode
            : value.gridSupportMode
    );
    const gridSupportBatteryCapacityAh = sanitizeRoundedNumber(
        value.gridSupportBatteryCapacityAh === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportBatteryCapacityAh
            : value.gridSupportBatteryCapacityAh,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportBatteryCapacityAh,
        GRID_SUPPORT_BATTERY_CAPACITY_MIN_AH,
        GRID_SUPPORT_BATTERY_CAPACITY_MAX_AH
    );
    const gridSupportReserveAh = sanitizeRoundedNumber(
        value.gridSupportReserveAh === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportReserveAh
            : value.gridSupportReserveAh,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportReserveAh,
        GRID_SUPPORT_RESERVE_MIN_AH,
        GRID_SUPPORT_RESERVE_MAX_AH
    );
    const gridSupportStartHour = sanitizeRoundedNumber(
        value.gridSupportStartHour === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportStartHour
            : value.gridSupportStartHour,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportStartHour,
        GRID_SUPPORT_HOUR_MIN,
        GRID_SUPPORT_HOUR_MAX
    );
    const gridSupportEndHour = sanitizeRoundedNumber(
        value.gridSupportEndHour === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportEndHour
            : value.gridSupportEndHour,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportEndHour,
        GRID_SUPPORT_HOUR_MIN,
        GRID_SUPPORT_HOUR_MAX
    );
    const gridSupportMaxDischargeA = sanitizeRoundedNumber(
        value.gridSupportMaxDischargeA === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportMaxDischargeA
            : value.gridSupportMaxDischargeA,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportMaxDischargeA,
        GRID_SUPPORT_MAX_DISCHARGE_MIN_A,
        GRID_SUPPORT_MAX_DISCHARGE_MAX_A
    );
    const gridSupportForecastConfidencePct = sanitizeRoundedNumber(
        value.gridSupportForecastConfidencePct === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportForecastConfidencePct
            : value.gridSupportForecastConfidencePct,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportForecastConfidencePct,
        GRID_SUPPORT_FORECAST_CONFIDENCE_MIN_PCT,
        GRID_SUPPORT_FORECAST_CONFIDENCE_MAX_PCT
    );
    const gridSupportSolarAssistGainPct = sanitizeRoundedNumber(
        value.gridSupportSolarAssistGainPct === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportSolarAssistGainPct
            : value.gridSupportSolarAssistGainPct,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportSolarAssistGainPct,
        GRID_SUPPORT_SOLAR_ASSIST_GAIN_MIN_PCT,
        GRID_SUPPORT_SOLAR_ASSIST_GAIN_MAX_PCT
    );
    const gridSupportWeakForecastBlockAh = sanitizeRoundedNumber(
        value.gridSupportWeakForecastBlockAh === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportWeakForecastBlockAh
            : value.gridSupportWeakForecastBlockAh,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportWeakForecastBlockAh,
        GRID_SUPPORT_WEAK_FORECAST_BLOCK_MIN_AH,
        GRID_SUPPORT_WEAK_FORECAST_BLOCK_MAX_AH
    );
    const gridSupportMinGridImportW = sanitizeRoundedNumber(
        value.gridSupportMinGridImportW === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportMinGridImportW
            : value.gridSupportMinGridImportW,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportMinGridImportW,
        GRID_SUPPORT_MIN_GRID_IMPORT_MIN_W,
        GRID_SUPPORT_MIN_GRID_IMPORT_MAX_W
    );
    const gridSupportDisableNoSun = value.gridSupportDisableNoSun === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportDisableNoSun
        : Boolean(value.gridSupportDisableNoSun);
    const gridSupportDisableNoSunBelowW = sanitizeRoundedNumber(
        value.gridSupportDisableNoSunBelowW === undefined
            ? DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportDisableNoSunBelowW
            : value.gridSupportDisableNoSunBelowW,
        DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportDisableNoSunBelowW,
        GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MIN_W,
        GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MAX_W
    );
    const exportGuardEnabled = value.exportGuardEnabled === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.exportGuardEnabled
        : Boolean(value.exportGuardEnabled);
    const forceChargeEnabled = value.forceChargeEnabled === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeEnabled
        : Boolean(value.forceChargeEnabled);
    const rawForceChargeGridW = value.forceChargeGridW === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeGridW
        : Number(value.forceChargeGridW);
    const forceChargeLimiterEnabled = value.forceChargeLimiterEnabled === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeLimiterEnabled
        : Boolean(value.forceChargeLimiterEnabled);
    const fcLimiterStart = value.forceChargeLimiterStart === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeLimiterStart
        : Number(value.forceChargeLimiterStart);
    const fcLimiterRelease = value.forceChargeLimiterRelease === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeLimiterRelease
        : Number(value.forceChargeLimiterRelease);
    const fcLimiterFull = value.forceChargeLimiterFull === undefined
        ? DEFAULT_HIGH_VOLTAGE_SETTINGS.forceChargeLimiterFull
        : Number(value.forceChargeLimiterFull);
    const allFinite = [start, release, full].every(Number.isFinite);
    const inRange = [start, release, full].every(
        setting => setting >= HIGH_VOLTAGE_SETTINGS_MIN && setting <= HIGH_VOLTAGE_SETTINGS_MAX
    );
    const gridSupportW = Math.round(rawGridSupportW);
    const validGridSupportW = Number.isFinite(rawGridSupportW)
        && gridSupportW >= HIGH_VOLTAGE_GRID_SUPPORT_MIN_W
        && gridSupportW <= HIGH_VOLTAGE_GRID_SUPPORT_MAX_W;
    const forceChargeGridW = Math.round(rawForceChargeGridW);
    const validForceChargeGridW = Number.isFinite(rawForceChargeGridW)
        && forceChargeGridW >= FORCE_CHARGE_MIN_W
        && forceChargeGridW <= FORCE_CHARGE_MAX_W;
    const fcLimiterFinite = [fcLimiterStart, fcLimiterRelease, fcLimiterFull].every(Number.isFinite);
    const fcLimiterInRange = [fcLimiterStart, fcLimiterRelease, fcLimiterFull].every(
        v => v >= HIGH_VOLTAGE_SETTINGS_MIN && v <= HIGH_VOLTAGE_SETTINGS_MAX
    );

    if (!allFinite || !inRange || !validGridSupportW || !validForceChargeGridW || !(full > start) || !(start >= release)
        || !fcLimiterFinite || !fcLimiterInRange
        || !(fcLimiterRelease > fcLimiterStart) || !(fcLimiterStart > fcLimiterFull)) {
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
        gridSupportDisableNoSun,
        gridSupportDisableNoSunBelowW,
        exportGuardEnabled,
        forceChargeEnabled,
        forceChargeGridW,
        forceChargeLimiterEnabled,
        forceChargeLimiterStart: fcLimiterStart,
        forceChargeLimiterRelease: fcLimiterRelease,
        forceChargeLimiterFull: fcLimiterFull
    };
}

function getHighVoltageSettings() {
    const storedSettings = sanitizeHighVoltageSettings(flow.get("highVoltageSettings"));

    return storedSettings || DEFAULT_HIGH_VOLTAGE_SETTINGS;
}

function getHourKey(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-") + " " + String(date.getHours()).padStart(2, "0");
}

function getHourStartTs(date) {
    return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        0,
        0,
        0
    ).getTime();
}

function getDayKey(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");
}

function formatTime(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getSolarForecastSummary(date) {
    const rawForecast = flow.get("solarForecastToday");

    if (!rawForecast || typeof rawForecast !== "object") {
        return {
            valid: false,
            condition: "unknown",
            energyKWh: 0,
            peakKW: 0
        };
    }

    const updatedAt = new Date(rawForecast.updatedAt);
    const ageHours = Number.isFinite(updatedAt.getTime())
        ? (date.getTime() - updatedAt.getTime()) / 3600000
        : Number.POSITIVE_INFINITY;
    const sameDay = Number.isFinite(updatedAt.getTime())
        ? getDayKey(updatedAt) === getDayKey(date)
        : false;

    return {
        valid: sameDay && ageHours >= 0 && ageHours <= SOLAR_FORECAST_MAX_AGE_HOURS,
        condition: String(rawForecast.condition || "unknown").toLowerCase(),
        energyKWh: Number(rawForecast.energyKWh) || 0,
        peakKW: Number(rawForecast.peakKW) || 0
    };
}

function normalizeConsumedAh(value) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        return Number.NaN;
    }

    if (numeric < 0) {
        return Math.max(0, -numeric);
    }

    return Math.max(0, numeric);
}

function getForecastRestoreAh(forecast, voltage) {
    if (!forecast.valid || forecast.energyKWh <= 0) {
        return 0;
    }

    const referenceVoltage = Number.isFinite(voltage) && voltage > 0
        ? voltage
        : BATTERY_NOMINAL_VOLTAGE;

    return (forecast.energyKWh * 1000 * SOLAR_TO_BATTERY_EFFICIENCY) / referenceVoltage;
}

function getRemainingNightHours(date) {
    const currentHour = date.getHours();
    const inNightWindow = currentHour >= 22 || currentHour < 6;

    if (!inNightWindow) {
        return 0;
    }

    const end = new Date(date);
    if (currentHour >= 22) {
        end.setDate(end.getDate() + 1);
    }
    end.setHours(6, 0, 0, 0);
    return Math.max(0, (end.getTime() - date.getTime()) / 3600000);
}

function getRemainingMorningHours(date) {
    const currentHour = date.getHours();

    if (currentHour < 6 || currentHour >= 22) {
        return 6;
    }

    if (currentHour >= 6 && currentHour < 12) {
        const end = new Date(date);
        end.setHours(12, 0, 0, 0);
        return Math.max(0, (end.getTime() - date.getTime()) / 3600000);
    }

    return 0;
}

function advanceHourBudget(state, date, importPowerW) {
    const nextState = {
        hourKey: state.hourKey || "",
        lastTs: Number(state.lastTs) || 0,
        usedWh: Number(state.usedWh) || 0,
        startTs: Number(state.startTs) || 0,
        fullHourCoverage: Boolean(state.fullHourCoverage)
    };

    const nowTs = date.getTime();
    const hourKey = getHourKey(date);
    const hourStartTs = getHourStartTs(date);

    if (!nextState.lastTs || nextState.hourKey !== hourKey || nextState.lastTs < hourStartTs) {
        nextState.hourKey = hourKey;
        nextState.lastTs = hourStartTs;
        nextState.usedWh = 0;
        nextState.startTs = date.getMinutes() === 0 ? hourStartTs : nowTs;
        nextState.fullHourCoverage = date.getMinutes() === 0;
    }

    if (nowTs > nextState.lastTs) {
        const deltaHours = (nowTs - nextState.lastTs) / 3600000;
        nextState.usedWh += Math.max(0, importPowerW) * deltaHours;
        nextState.lastTs = nowTs;
    }

    return nextState;
}

function isValidMmdd(value) {
    if (!Number.isInteger(value)) {
        return false;
    }

    const month = Math.floor(value / 100);
    const day = value % 100;
    // 2024 is a leap year, so 29 Feb is accepted.
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(2024, month, 0).getDate();
}

function getTariffConstants() {
    const overrides = flow.get("controllerConstantsOverrides") || {};
    const read = key => {
        const value = Number(overrides[key]);
        return Object.prototype.hasOwnProperty.call(overrides, key) && Number.isFinite(value)
            ? value
            : DEFAULT_TARIFF_CONSTANTS[key];
    };
    const readInt = (key, min, max) => {
        const value = Math.round(read(key));
        return value >= min && value <= max ? value : DEFAULT_TARIFF_CONSTANTS[key];
    };
    const readMmdd = key => {
        const value = Math.round(read(key));
        return isValidMmdd(value) ? value : DEFAULT_TARIFF_CONSTANTS[key];
    };

    return {
        WINTER_START_MMDD: readMmdd("WINTER_START_MMDD"),
        SUMMER_START_MMDD: readMmdd("SUMMER_START_MMDD"),
        SUMMER_TARIFF_TIER: readInt("SUMMER_TARIFF_TIER", 1, TARIFF_TIER_LIMITS_W.length),
        WINTER_TARIFF_TIER: readInt("WINTER_TARIFF_TIER", 1, TARIFF_TIER_LIMITS_W.length),
        SUMMER_NIGHT_BONUS_PCT: clamp(read("SUMMER_NIGHT_BONUS_PCT"), 0, 100),
        WINTER_NIGHT_BONUS_PCT: clamp(read("WINTER_NIGHT_BONUS_PCT"), 0, 100),
        TARIFF_TIER_MARGIN_W: clamp(read("TARIFF_TIER_MARGIN_W"), 0, 1000),
        TARIFF_NIGHT_BILLING_PCT: clamp(read("TARIFF_NIGHT_BILLING_PCT"), 10, 100),
        TARIFF_SEASON_FORCE: readInt("TARIFF_SEASON_FORCE", 0, 2),
        GRID_NOMINAL_VOLTAGE: clamp(read("GRID_NOMINAL_VOLTAGE"), 200, 250),
        GRID_CURRENT_HEADROOM_PCT: clamp(read("GRID_CURRENT_HEADROOM_PCT"), 0, 30),
        GRID_CURRENT_MAX_A: clamp(read("GRID_CURRENT_MAX_A"), 5, 50)
    };
}

function isNightHour(hourOfDay) {
    return hourOfDay >= 22 || hourOfDay < 6;
}

function getBillingFactor(hourOfDay, tariffConstants) {
    return isNightHour(hourOfDay) ? tariffConstants.TARIFF_NIGHT_BILLING_PCT / 100 : 1;
}

function formatMmdd(value) {
    return String(value % 100).padStart(2, "0") + "." + String(Math.floor(value / 100)).padStart(2, "0");
}

function getTariffSeason(date, tariffConstants) {
    const mmdd = (date.getMonth() + 1) * 100 + date.getDate();
    const winterStart = tariffConstants.WINTER_START_MMDD;
    const summerStart = tariffConstants.SUMMER_START_MMDD;
    const autoWinter = winterStart > summerStart
        ? (mmdd >= winterStart || mmdd < summerStart)
        : (mmdd >= winterStart && mmdd < summerStart);
    const forced = tariffConstants.TARIFF_SEASON_FORCE;
    const winter = forced === 2 ? true : (forced === 1 ? false : autoWinter);
    const nextMmdd = autoWinter ? summerStart : winterStart;
    const nextSwitch = new Date(date.getFullYear(), Math.floor(nextMmdd / 100) - 1, nextMmdd % 100);

    if (nextSwitch.getTime() <= date.getTime()) {
        nextSwitch.setFullYear(nextSwitch.getFullYear() + 1);
    }

    return {
        winter,
        mode: forced === 0 ? "auto" : "forced",
        nextSwitchKey: winterStart === summerStart ? "" : getDayKey(nextSwitch),
        nextSeason: autoWinter ? "SUMMER" : "WINTER"
    };
}

// Safe VE.Bus input current: setpoint + headroom at nominal grid voltage, rounded to 0.5 A.
// The ESS loop holds the setpoint; the current limit is only the hard backstop for spikes.
function getGridCurrentForSetpoint(setpointW, tariffConstants) {
    const rawA = setpointW * (1 + tariffConstants.GRID_CURRENT_HEADROOM_PCT / 100) / tariffConstants.GRID_NOMINAL_VOLTAGE;
    return clamp(Math.round(rawA * 2) / 2, 1, tariffConstants.GRID_CURRENT_MAX_A);
}

function buildSeasonProfile(winter, tariffConstants) {
    const tier = winter ? tariffConstants.WINTER_TARIFF_TIER : tariffConstants.SUMMER_TARIFF_TIER;
    const tierLimitW = TARIFF_TIER_LIMITS_W[tier - 1];
    const nightBonusPct = winter ? tariffConstants.WINTER_NIGHT_BONUS_PCT : tariffConstants.SUMMER_NIGHT_BONUS_PCT;
    const daySetpointW = Math.max(MIN_GRID_SETPOINT, Math.round(tierLimitW - tariffConstants.TARIFF_TIER_MARGIN_W));
    const nightSetpointW = Math.round(daySetpointW * (1 + nightBonusPct / 100) / 10) * 10;
    const nightBillableW = Math.round(nightSetpointW * tariffConstants.TARIFF_NIGHT_BILLING_PCT / 100);

    return {
        season: winter ? "WINTER" : "SUMMER",
        startMmdd: winter ? tariffConstants.WINTER_START_MMDD : tariffConstants.SUMMER_START_MMDD,
        tier,
        tierLimitW,
        nightBonusPct,
        daySetpointW,
        nightSetpointW,
        nightBillableW,
        nightOverTier: nightBillableW > tierLimitW,
        dayCurrentA: getGridCurrentForSetpoint(daySetpointW, tariffConstants),
        nightCurrentA: getGridCurrentForSetpoint(nightSetpointW, tariffConstants)
    };
}

// Shell script (run by the exec node as `sh -c <payload>`) that prints the month's legacy
// daily logs and the monthly CSV.
function buildEnergyHistoryCommand(monthKey) {
    const script = 'cd "' + ENERGY_LOG_DIR + '" 2>/dev/null && cat energy-' + monthKey + '-*.log energy-' + monthKey + '.csv 2>/dev/null; true';
    return "'" + script.replace(/'/g, "'\\''") + "'";
}

// Accepts both formats; later lines win for the same hour.
//   CSV:    2026-10-17 22,2450,2432,0,1715,2610,6440,W,60  (bill_wh = 5th column)
//   legacy: 2026-10-17 22:00 | Grid 2450Wh | AC 2432Wh | Sol 0Wh
function parseEnergyHistory(rawText, monthKey, tariffConstants) {
    const history = {};

    String(rawText || "").split(/\r?\n/).forEach(line => {
        const csv = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}),(-?\d+),-?\d+,-?\d+(?:,(-?\d+))?/);
        const legacy = csv ? null : line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):00 \| Grid (-?\d+)Wh/);
        const match = csv || legacy;

        if (!match || match[1].substring(0, 7) !== monthKey) {
            return;
        }

        const gridWh = Math.max(0, Number(match[3]) || 0);
        const billWh = csv && csv[4] !== undefined
            ? Math.max(0, Number(csv[4]) || 0)
            : Math.round(gridWh * getBillingFactor(Number(match[2]), tariffConstants));

        history[match[1] + " " + match[2]] = { gridWh, billWh };
    });

    return history;
}

function getTierForAverageW(averageW) {
    const index = TARIFF_TIER_LIMITS_W.findIndex(limitW => averageW <= limitW);
    return index === -1 ? TARIFF_TIER_LIMITS_W.length + 1 : index + 1;
}

function smoothReduction(previousValue, targetValue, maxStep) {
    if (!Number.isFinite(previousValue)) {
        return targetValue;
    }

    if (targetValue < previousValue - maxStep) {
        return previousValue - maxStep;
    }

    if (targetValue > previousValue + maxStep) {
        return previousValue + maxStep;
    }

    return targetValue;
}

function parseManualDischargeCommand(input) {
    if (input === true || input === "start" || input === "on") {
        return { active: true, source: "inject" };
    }

    if (input === false || input === "stop" || input === "off") {
        return { active: false, source: "inject" };
    }

    if (!input || typeof input !== "object") {
        return null;
    }

    if (input.active === true || input.enabled === true || input.command === "start") {
        return {
            active: true,
            source: String(input.source || input.reason || "inject")
        };
    }

    if (input.active === false || input.enabled === false || input.command === "stop") {
        return {
            active: false,
            source: String(input.source || input.reason || "inject")
        };
    }

    return null;
}

function buildNotification(window, gridSetpoint) {
    const parts = [
        `${window}`,
        `V=${batteryVoltage.toFixed(2)}V`,
        `Grid setpoint=${gridSetpoint}W`
    ];

    if (limitFlags.length > 0) {
        parts.push(`Limit=${limitFlags.join("+")}`);
    }

    return {
        topic: "vrm-notification",
        payload: parts.join(" | "),
        notification: {
            message: parts.join(" | "),
            level: "info",
            timestamp: now.toISOString()
        }
    };
}

function buildTraceOutput(chargeCurrent, gridSetpoint, hourlyLogMsg) {
    return {
        topic: "controller-trace",
        payload: {
            timestamp: now.toISOString(),
            inputTopic: msg.topic || "",
            inputPayload: msg.topic === TARIFF_HISTORY_TOPIC ? `(${String(msg.payload || "").length} chars of energy history)` : msg.payload,
            window: windowName,
            previousWindow,
            batteryVoltage: round1(batteryVoltage),
            highVoltageSettings,
            consumedAhDeficit: round1(consumedAhDeficit),
            solarForecast: {
                valid: solarForecast.valid,
                condition: solarForecast.condition,
                energyKWh: round1(solarForecast.energyKWh),
                peakKW: round1(solarForecast.peakKW)
            },
            gridSupportMode,
            gridSupportDisableNoSun,
            gridSupportDisableNoSunBelowW,
            gridSupportLowSunBlocked,
            adaptiveGridSupportActive,
            adaptiveGridSupportW: Math.round(adaptiveGridSupportW),
            plannedGridSupportW: Math.round(plannedGridSupportW),
            liveSolarAssistW: Math.round(liveSolarAssistW),
            remainingForecastWh: Math.round(remainingForecastWh),
            remainingForecastAh: round1(remainingForecastAh),
            supportWindowRemainingHours: round1(supportWindowRemainingHours),
            batteryRemainingAh: batteryRemainingAh === null ? null : round1(batteryRemainingAh),
            usableStoredSupportAh: round1(usableStoredSupportAh),
            predictedSupportAh: round1(predictedSupportAh),
            supportMinGridImportW,
            gridPowerSignedW: Math.round(gridPowerSignedW),
            exportGuardEnabled,
            exportGuard: {
                active: exportGuardActive,
                boostW: Math.round(exportGuardBoostW),
                targetW: exportGuardTargetW,
                setpointFloorW: exportGuardSetpointFloorW,
                chargeCurrentA: exportGuardChargeCurrent,
                since: exportGuard.since || ""
            },
            forecastRestoreAh: round1(forecastRestoreAh),
            gridRestoreAhNeeded: round1(gridRestoreAhNeeded),
            remainingNightHours: round1(remainingNightHours),
            remainingMorningHours: round1(remainingMorningHours),
            remainingMorningCapacityAh: round1(remainingMorningCapacityAh),
            boostActive,
            manualDischargeStopVoltage: round1(manualDischargeStopVoltage),
            manualDischarge,
            voltageLimitActive,
            baseScheduleSetpoint,
            gridCurrentLimitA,
            gridCurrentLimitSent: sendGridCurrentLimit,
            tariff: tariffView,
            requestedGridSetpoint,
            voltageLimitedSetpoint,
            finalGridSetpoint: gridSetpoint,
            baseChargeCurrent: round1(baseChargeCurrent),
            finalChargeCurrent: round1(chargeCurrent),
            currentChargingPowerW,
            forceChargeEnabled,
            forceChargeGridW,
            forceChargeLimiterActive,
            effectiveForceChargeGridW: Math.round(effectiveForceChargeGridW),
            storedGridPowerW: Math.round(storedGridPowerW),
            storedAcLoadPowerW: Math.round(storedAcLoadPowerW),
            storedDcPowerW: Math.round(storedDcPowerW),
            storedPvChargerPowerW: Math.round(storedPvChargerPowerW),
            hasDcPowerReading,
            hourBudget: {
                hourKey: hourBudget.hourKey,
                usedWh: Math.round(usedWh),
                fullHourCoverage: hourBudget.fullHourCoverage,
                startTs: hourBudget.startTs || 0
            },
            acLoadBudget: {
                hourKey: acLoadBudget.hourKey,
                usedWh: Math.round(acUsedWh),
                fullHourCoverage: acLoadBudget.fullHourCoverage,
                startTs: acLoadBudget.startTs || 0
            },
            solarBudget: {
                hourKey: solarBudget.hourKey,
                usedWh: Math.round(solarUsedWh),
                fullHourCoverage: solarBudget.fullHourCoverage,
                startTs: solarBudget.startTs || 0
            },
            solarGenerationW: Math.round(solarGenerationW),
            hourRolledOver,
            hourlyLogMsg: hourlyLogMsg || null,
            limitFlags: limitFlags.slice()
        }
    };
}

function buildOutputs(chargeCurrent, gridSetpoint, hourlyLogMsg) {
    const notifyMsg =
        gridSetpoint !== previousGridSetpoint
            ? buildNotification(windowName, gridSetpoint)
            : null;
    // The trace only feeds dashboards/debug: at most one every TRACE_MIN_INTERVAL_MS for sensor
    // updates (they arrive several times per second), immediately for everything else.
    const lastTraceTs = Number(context.get("lastTraceTs")) || 0;
    const sendTrace = Boolean(hourRolledOver)
        || !SENSOR_TOPICS.includes(msg.topic)
        || now.getTime() - lastTraceTs >= TRACE_MIN_INTERVAL_MS
        || now.getTime() < lastTraceTs;
    if (sendTrace) {
        context.set("lastTraceTs", now.getTime());
    }
    const traceMsg = sendTrace ? buildTraceOutput(chargeCurrent, gridSetpoint, hourlyLogMsg) : null;

    return [
        {
            topic: "charge-current-limit",
            payload: chargeCurrent
        },
        {
            topic: "grid-setpoint",
            payload: gridSetpoint
        },
        sendGridCurrentLimit
            ? {
                topic: "ac-input-current-limit",
                payload: gridCurrentLimitA
            }
            : null,
        notifyMsg,
        hourlyLogMsg || null,
        traceMsg,
        tariffHistoryRequestMsg
    ];
}

// ==========================
// UPDATE STORED INPUTS
// ==========================
const prevHourKey = hourBudget.hourKey;
const prevHourGridWh = Number(hourBudget.usedWh) || 0;
const prevHourAcWh = Number(acLoadBudget.usedWh) || 0;
const prevHourSolarWh = Number(solarBudget.usedWh) || 0;
// Minutes of the closed hour that were actually integrated (60 = full hour, less after a restart).
const prevHourCoverageMin = Math.round(clamp(((Number(hourBudget.lastTs) || 0) - (Number(hourBudget.startTs) || 0)) / 60000, 0, 60));
let hourPeak = context.get("hourPeak") || { hourKey: "", peakW: 0 };
const prevHourPeakW = hourPeak.hourKey === prevHourKey ? Math.round(Number(hourPeak.peakW) || 0) : 0;
// Solar generation comes only from PV charger power; DC bus power stays informational.
const solarGenerationW = storedPvChargerPowerW;
hourBudget = advanceHourBudget(hourBudget, now, storedGridPowerW);
acLoadBudget = advanceHourBudget(acLoadBudget, now, storedAcLoadPowerW);
solarBudget = advanceHourBudget(solarBudget, now, solarGenerationW);
const hourRolledOver = prevHourKey && prevHourKey !== hourBudget.hourKey;

// ==========================
// DAILY GRID ENERGY / CAPACITY TIER TRACKING
// ==========================
// Closed hours are folded into the day total and the month's per-day billable peak.
// Night hours count at TARIFF_NIGHT_BILLING_PCT, like Elvenett does for kapasitetsledd.
const tariffConstants = getTariffConstants();
const todayKey = hourBudget.hourKey.substring(0, 10);
const emptyTariffDay = dayKey => ({ dayKey, gridWh: 0, peakBillableWh: 0, peakHourKey: "" });
let tariffDay = context.get("tariffDay") || emptyTariffDay("");
let tariffMonth = context.get("tariffMonth") || { monthKey: "", dayPeaks: {} };
// Extra columns of the closed hour for the monthly energy CSV.
let closedHourRecord = null;

if (hourRolledOver) {
    const closedDayKey = prevHourKey.substring(0, 10);
    const closedHourOfDay = Number(prevHourKey.substring(11, 13));
    const closedBillableWh = prevHourGridWh * getBillingFactor(closedHourOfDay, tariffConstants);
    const closedHourDate = new Date(
        Number(prevHourKey.substring(0, 4)),
        Number(prevHourKey.substring(5, 7)) - 1,
        Number(prevHourKey.substring(8, 10)),
        closedHourOfDay
    );
    const closedProfile = buildSeasonProfile(getTariffSeason(closedHourDate, tariffConstants).winter, tariffConstants);

    closedHourRecord = {
        billWh: Math.round(closedBillableWh),
        peakW: prevHourPeakW,
        setpointW: isNightHour(closedHourOfDay) ? closedProfile.nightSetpointW : closedProfile.daySetpointW,
        season: closedProfile.season === "WINTER" ? "W" : "S",
        coverageMin: prevHourCoverageMin
    };

    if (tariffDay.dayKey !== closedDayKey) {
        tariffDay = emptyTariffDay(closedDayKey);
    }

    tariffDay.gridWh = Math.round((Number(tariffDay.gridWh) || 0) + prevHourGridWh);

    if (closedBillableWh > (Number(tariffDay.peakBillableWh) || 0)) {
        tariffDay.peakBillableWh = Math.round(closedBillableWh);
        tariffDay.peakHourKey = prevHourKey;
    }

    if (tariffMonth.monthKey !== closedDayKey.substring(0, 7)) {
        tariffMonth = { monthKey: closedDayKey.substring(0, 7), dayPeaks: {} };
    }

    tariffMonth.dayPeaks[closedDayKey] = Math.max(Number(tariffMonth.dayPeaks[closedDayKey]) || 0, Math.round(closedBillableWh));
}

if (tariffDay.dayKey !== todayKey) {
    tariffDay = emptyTariffDay(todayKey);
}

if (tariffMonth.monthKey !== todayKey.substring(0, 7)) {
    tariffMonth = { monthKey: todayKey.substring(0, 7), dayPeaks: {} };
}

// History restore: the closed hours of this month are read back from the energy files
// (monthly CSV + legacy daily energy-*.log) so Day / Month survive a restart or redeploy.
if (msg.topic === TARIFF_HISTORY_TOPIC && typeof msg.payload === "string") {
    const history = parseEnergyHistory(msg.payload, tariffMonth.monthKey, tariffConstants);
    let historyDayWh = 0;
    let historyDayPeakWh = 0;
    let historyDayPeakHourKey = "";

    Object.keys(history).forEach(historyHourKey => {
        // The live hour is still being integrated and is not in the file yet.
        if (historyHourKey === hourBudget.hourKey) {
            return;
        }

        const record = history[historyHourKey];
        const historyDayKey = historyHourKey.substring(0, 10);
        tariffMonth.dayPeaks[historyDayKey] = Math.max(Number(tariffMonth.dayPeaks[historyDayKey]) || 0, record.billWh);

        if (historyDayKey === todayKey) {
            historyDayWh += record.gridWh;

            if (record.billWh > historyDayPeakWh) {
                historyDayPeakWh = record.billWh;
                historyDayPeakHourKey = historyHourKey;
            }
        }
    });

    if (historyDayWh > (Number(tariffDay.gridWh) || 0)) {
        tariffDay.gridWh = Math.round(historyDayWh);
    }

    if (historyDayPeakWh > (Number(tariffDay.peakBillableWh) || 0)) {
        tariffDay.peakBillableWh = historyDayPeakWh;
        tariffDay.peakHourKey = historyDayPeakHourKey;
    }

    context.set("tariffHistoryState", { monthKey: tariffMonth.monthKey, loadedAt: now.getTime(), hours: Object.keys(history).length });
}

context.set("tariffDay", tariffDay);
context.set("tariffMonth", tariffMonth);

if (msg.topic === BATTERY_TOPIC) {
    const incomingVoltage = Number(msg.payload);

    if (Number.isFinite(incomingVoltage)) {
        batteryVoltage = incomingVoltage;
        context.set("batteryVoltage", batteryVoltage);
    }
}
else if (msg.topic === BATTERY_CONSUMED_AH_TOPIC) {
    const normalizedConsumedAh = normalizeConsumedAh(msg.payload);

    if (Number.isFinite(normalizedConsumedAh)) {
        consumedAhDeficit = normalizedConsumedAh;
        context.set("batteryConsumedAh", consumedAhDeficit);
    }
}
else if (msg.topic === GRID_TOPIC) {
    const incomingGridPower = Number(msg.payload);

    if (Number.isFinite(incomingGridPower)) {
        gridPowerSignedW = incomingGridPower;
        gridPowerW = Math.max(0, incomingGridPower);
        hasGridPowerReading = true;
        context.set("gridPowerW", gridPowerSignedW);
    }
}
else if (msg.topic === AC_LOAD_TOPIC) {
    const incomingAcLoadPower = Number(msg.payload);

    if (Number.isFinite(incomingAcLoadPower)) {
        context.set("acLoadPowerW", Math.max(0, incomingAcLoadPower));
    }
}
else if (msg.topic === DC_POWER_TOPIC) {
    const incomingDcPower = Number(msg.payload);

    if (Number.isFinite(incomingDcPower)) {
        context.set("dcPowerW", incomingDcPower);
    }
}
else if (msg.topic === PV_CHARGER_TOPIC) {
    const incomingPvChargerPower = Number(msg.payload);

    if (Number.isFinite(incomingPvChargerPower)) {
        context.set("pvChargerPowerW", Math.max(0, incomingPvChargerPower));
    }
}
else if (msg.topic === MANUAL_DISCHARGE_TOPIC) {
    const manualCommand = parseManualDischargeCommand(msg.payload);

    if (manualCommand) {
        manualDischarge = {
            active: manualCommand.active,
            startedAt: manualCommand.active ? now.toISOString() : "",
            source: manualCommand.source || "inject"
        };
        context.set("manualDischarge", manualDischarge);
    }
}
else if (msg.topic === MANUAL_DISCHARGE_STOP_VOLTAGE_TOPIC) {
    const incomingStopVoltage = Number(msg.payload);

    if (Number.isFinite(incomingStopVoltage) && incomingStopVoltage >= 50 && incomingStopVoltage <= 60) {
        manualDischargeStopVoltage = incomingStopVoltage;
        context.set("manualDischargeStopVoltage", manualDischargeStopVoltage);
    }
}

if (hourPeak.hourKey !== hourBudget.hourKey) {
    hourPeak = { hourKey: hourBudget.hourKey, peakW: 0 };
}

hourPeak.peakW = Math.round(Math.max(Number(hourPeak.peakW) || 0, storedGridPowerW, gridPowerW));
context.set("hourPeak", hourPeak);
context.set("hourBudget", hourBudget);
context.set("acLoadBudget", acLoadBudget);
context.set("solarBudget", solarBudget);

if (!Number.isFinite(batteryVoltage)) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: "WAITING FOR BATTERY VOLTAGE"
    });
    return null;
}

if (!Number.isFinite(consumedAhDeficit) && !manualDischarge.active) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: "WAITING FOR BMS CONSUMED AH"
    });
    return null;
}

// ==========================
// TIME WINDOWS
// ==========================
const nightWindow = (hour >= 22 || hour < 6);

const morningWindow =
    (hour > 6 && hour < 11) ||
    (hour === 6) ||
    (hour === 11 && minute <= 59);

const eveningWindow = hour >= 17;

const tariffSeason = getTariffSeason(now, tariffConstants);
const summerProfile = buildSeasonProfile(false, tariffConstants);
const winterProfile = buildSeasonProfile(true, tariffConstants);
const seasonProfile = tariffSeason.winter ? winterProfile : summerProfile;
const baseScheduleSetpoint = nightWindow ? seasonProfile.nightSetpointW : seasonProfile.daySetpointW;
const hourlyBudgetLimit = baseScheduleSetpoint;
const gridCurrentLimitA = nightWindow ? seasonProfile.nightCurrentA : seasonProfile.dayCurrentA;
const previousGridCurrentLimitA = Number(context.get("gridCurrentLimitA"));
// Sent on change and re-asserted every hour so a Multi restart or manual edit is corrected.
const sendGridCurrentLimit = previousGridCurrentLimitA !== gridCurrentLimitA || Boolean(hourRolledOver);
context.set("gridCurrentLimitA", gridCurrentLimitA);
const highVoltageSettings = getHighVoltageSettings();
const highVoltageProtectionEnabled = Boolean(highVoltageSettings.enabled);
const highVoltageGridSupportW = Math.round(highVoltageSettings.gridSupportW || 0);
const gridSupportMode = normalizeGridSupportMode(highVoltageSettings.gridSupportMode);
const adaptiveGridSupportEnabled = gridSupportMode === GRID_SUPPORT_MODE_ADAPTIVE_DAY || gridSupportMode === GRID_SUPPORT_MODE_HYBRID;
const hybridGridSupportEnabled = gridSupportMode === GRID_SUPPORT_MODE_HYBRID;
const gridSupportBatteryCapacityAh = Math.max(0, Math.round(Number(highVoltageSettings.gridSupportBatteryCapacityAh) || 0));
const gridSupportReserveAh = Math.max(0, Math.round(Number(highVoltageSettings.gridSupportReserveAh) || 0));
const gridSupportStartHour = sanitizeRoundedNumber(highVoltageSettings.gridSupportStartHour, DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportStartHour, GRID_SUPPORT_HOUR_MIN, GRID_SUPPORT_HOUR_MAX);
const gridSupportEndHour = sanitizeRoundedNumber(highVoltageSettings.gridSupportEndHour, DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportEndHour, GRID_SUPPORT_HOUR_MIN, GRID_SUPPORT_HOUR_MAX);
const gridSupportMaxDischargeA = Math.max(0, Math.round(Number(highVoltageSettings.gridSupportMaxDischargeA) || 0));
const gridSupportForecastConfidencePct = clamp(Number(highVoltageSettings.gridSupportForecastConfidencePct) || 0, GRID_SUPPORT_FORECAST_CONFIDENCE_MIN_PCT, GRID_SUPPORT_FORECAST_CONFIDENCE_MAX_PCT);
const gridSupportSolarAssistGainPct = clamp(Number(highVoltageSettings.gridSupportSolarAssistGainPct) || 0, GRID_SUPPORT_SOLAR_ASSIST_GAIN_MIN_PCT, GRID_SUPPORT_SOLAR_ASSIST_GAIN_MAX_PCT);
const gridSupportWeakForecastBlockAh = Math.max(0, Math.round(Number(highVoltageSettings.gridSupportWeakForecastBlockAh) || 0));
const supportMinGridImportW = clamp(Math.round(Number(highVoltageSettings.gridSupportMinGridImportW) || MIN_GRID_SETPOINT), MIN_GRID_SETPOINT, GRID_SUPPORT_MIN_GRID_IMPORT_MAX_W);
const gridSupportDisableNoSun = Boolean(highVoltageSettings.gridSupportDisableNoSun);
const gridSupportDisableNoSunBelowW = sanitizeRoundedNumber(
    highVoltageSettings.gridSupportDisableNoSunBelowW,
    DEFAULT_HIGH_VOLTAGE_SETTINGS.gridSupportDisableNoSunBelowW,
    GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MIN_W,
    GRID_SUPPORT_DISABLE_NO_SUN_BELOW_MAX_W
);
const gridSupportLowSunBlocked = gridSupportDisableNoSun
    && highVoltageGridSupportW > 0
    && solarGenerationW < gridSupportDisableNoSunBelowW;
const exportGuardEnabled = highVoltageSettings.exportGuardEnabled === undefined
    ? DEFAULT_HIGH_VOLTAGE_SETTINGS.exportGuardEnabled
    : Boolean(highVoltageSettings.exportGuardEnabled);
const forceChargeEnabled = Boolean(highVoltageSettings.forceChargeEnabled);
const forceChargeGridW = Math.round(highVoltageSettings.forceChargeGridW || 0);
const forceChargeLimiterEnabled = Boolean(highVoltageSettings.forceChargeLimiterEnabled);
const forceChargeLimiterStart = Number(highVoltageSettings.forceChargeLimiterStart) || 53;
const forceChargeLimiterRelease = Number(highVoltageSettings.forceChargeLimiterRelease) || 54;
const forceChargeLimiterFull = Number(highVoltageSettings.forceChargeLimiterFull) || 52;

// Force charge voltage limiter hysteresis (activates at LOW voltage, opposite to HV protection)
if (forceChargeLimiterEnabled && forceChargeEnabled && forceChargeGridW > 0) {
    if (!forceChargeLimiterActive && batteryVoltage <= forceChargeLimiterStart) {
        forceChargeLimiterActive = true;
    }
    if (forceChargeLimiterActive && batteryVoltage >= forceChargeLimiterRelease) {
        forceChargeLimiterActive = false;
    }
} else {
    forceChargeLimiterActive = false;
}
context.set("forceChargeLimiterActive", forceChargeLimiterActive);

const forceChargeAllowed = forceChargeEnabled && forceChargeGridW > 0
    && (!forceChargeLimiterEnabled || forceChargeLimiterActive);

// Taper: at/below forceChargeLimiterFull charge at max (25A × V); taper down to forceChargeGridW at start V
let effectiveForceChargeGridW = forceChargeGridW;
if (forceChargeAllowed && forceChargeLimiterEnabled && forceChargeLimiterStart > forceChargeLimiterFull) {
    const fcTaper = clamp(
        (forceChargeLimiterStart - batteryVoltage) / (forceChargeLimiterStart - forceChargeLimiterFull),
        0, 1
    );
    const maxForceChargeW = Math.round(MAX_CHARGE_CURRENT * Math.max(1, batteryVoltage));
    effectiveForceChargeGridW = Math.round(
        forceChargeGridW + fcTaper * (maxForceChargeW - forceChargeGridW)
    );
}

// In FORCE-CHARGE mode the DVCC limit must reach the full target current; no MAX_CHARGE_CURRENT cap.
const forceChargeTargetCurrent = Math.round(
    effectiveForceChargeGridW / Math.max(1, Number.isFinite(batteryVoltage) && batteryVoltage > 0 ? batteryVoltage : BATTERY_NOMINAL_VOLTAGE)
);

// ==========================
// CAPACITY RESTORATION LOGIC
// ==========================
let windowName = "OUTSIDE";
let baseChargeCurrent = 0;
const solarForecast = getSolarForecastSummary(now);
const effectiveConsumedAhDeficit = Number.isFinite(consumedAhDeficit) ? consumedAhDeficit : 0;
const forecastRestoreAh = getForecastRestoreAh(solarForecast, batteryVoltage);
const gridRestoreAhNeeded = Math.max(0, effectiveConsumedAhDeficit - forecastRestoreAh);
const batteryRemainingAh = gridSupportBatteryCapacityAh > 0
    ? Math.max(0, gridSupportBatteryCapacityAh - effectiveConsumedAhDeficit)
    : null;
const usableStoredSupportAh = batteryRemainingAh === null
    ? 0
    : Math.max(0, batteryRemainingAh - gridSupportReserveAh);
const remainingNightHours = getRemainingNightHours(now);
const remainingMorningHours = getRemainingMorningHours(now);
const remainingMorningCapacityAh = remainingMorningHours * MAX_CHARGE_CURRENT;
const manualDischargeAllowedByLoad = Math.max(0, storedAcLoadPowerW) <= MANUAL_DISCHARGE_MAX_AC_LOAD_W;
const morningSolarChargeHold = solarForecast.valid && forecastRestoreAh > 0 && batteryVoltage > 53.7;
const supportWindowActive = adaptiveGridSupportEnabled && isHourWithinWindow(hour, gridSupportStartHour, gridSupportEndHour);
const supportWindowRemainingHours = supportWindowActive ? getWindowRemainingHours(now, gridSupportStartHour, gridSupportEndHour) : 0;
const remainingForecastWh = supportWindowActive ? getRemainingForecastWh(now, gridSupportStartHour, gridSupportEndHour) : 0;
const remainingForecastAh = remainingForecastWh > 0
    ? (remainingForecastWh * SOLAR_TO_BATTERY_EFFICIENCY) / Math.max(1, Number.isFinite(batteryVoltage) && batteryVoltage > 0 ? batteryVoltage : BATTERY_NOMINAL_VOLTAGE)
    : 0;
const predictedSupportAh = Math.max(0, (remainingForecastAh * (gridSupportForecastConfidencePct / 100)) - gridSupportWeakForecastBlockAh);

if (manualDischarge.active && batteryVoltage <= manualDischargeStopVoltage) {
    manualDischarge = {
        active: false,
        startedAt: "",
        source: "auto-stop-low-voltage"
    };
    context.set("manualDischarge", manualDischarge);
}

const manualDischargeEnabled = manualDischarge.active && manualDischargeAllowedByLoad;

if (manualDischargeEnabled) {
    windowName = "MANUAL-DISCHARGE";
    boostActive = false;
    baseChargeCurrent = 0;
}
else if (forceChargeAllowed) {
    windowName = "FORCE-CHARGE";
    boostActive = false;
    baseChargeCurrent = forceChargeTargetCurrent;
}
else if (nightWindow) {
    windowName = "NIGHT";
    boostActive = gridRestoreAhNeeded > Math.max(RESTORE_AH_DEADBAND, remainingMorningCapacityAh);
    baseChargeCurrent = boostActive ? MAX_CHARGE_CURRENT : 0;
}
else if (morningWindow) {
    windowName = "MORNING";
    boostActive = !morningSolarChargeHold && gridRestoreAhNeeded > RESTORE_AH_DEADBAND;
    baseChargeCurrent = boostActive ? MAX_CHARGE_CURRENT : 0;
}
else if (eveningWindow) {
    windowName = "EVENING";
    boostActive = false;
    baseChargeCurrent = boostActive ? MAX_CHARGE_CURRENT : 0;
}
else {
    boostActive = false;
    baseChargeCurrent = 0;
}

// ==========================
// HIGH-VOLTAGE GRID SETPOINT LIMIT
// ==========================
if (!highVoltageProtectionEnabled) {
    voltageLimitActive = false;
}
else if (!voltageLimitActive && batteryVoltage > highVoltageSettings.start) {
    voltageLimitActive = true;
}

if (voltageLimitActive && batteryVoltage <= highVoltageSettings.release) {
    voltageLimitActive = false;
}

const requestedGridSetpoint = forceChargeAllowed
    ? Math.min(
        baseScheduleSetpoint,
        Math.round(Math.max(0, storedAcLoadPowerW) + effectiveForceChargeGridW)
    )
    : baseScheduleSetpoint;
// Start at the full requested setpoint; voltage-limit block reduces it only when battery voltage is high.
let voltageLimitedSetpoint = requestedGridSetpoint;

if (voltageLimitActive) {
    const forceChargeFloorSetpoint = Math.round(Math.max(0, storedAcLoadPowerW));
    const voltageLimitFloorSetpoint = forceChargeAllowed
        ? Math.min(requestedGridSetpoint, forceChargeFloorSetpoint)
        : (hasGridPowerReading
            ? Math.min(requestedGridSetpoint, Math.max(0, Math.round(storedGridPowerW)))
            : 0);
    const taper = clamp(
        (highVoltageSettings.full - batteryVoltage) /
        (highVoltageSettings.full - highVoltageSettings.start),
        0,
        1
    );

    voltageLimitedSetpoint = Math.round(
        voltageLimitFloorSetpoint + (requestedGridSetpoint - voltageLimitFloorSetpoint) * taper
    );
}

// Apply smoothing only to the voltage-based reduction so the battery does not see large jumps.
if (voltageLimitActive) {
    voltageLimitedSetpoint = Math.round(
        smoothReduction(
            previousGridSetpoint,
            voltageLimitedSetpoint,
            MAX_GRID_STEP_W
        )
    );
}

// ==========================
// FINAL OUTPUTS
// ==========================
const manualDischargePowerW = Math.round(
    Math.max(0, batteryVoltage) * MANUAL_DISCHARGE_MAX_CURRENT
);

const manualGridSetpoint = Math.max(
    MANUAL_DISCHARGE_MIN_GRID_W,
    Math.round(Math.max(0, storedAcLoadPowerW) - manualDischargePowerW)
);

const rawFinalGridSetpoint = manualDischargeEnabled
    ? manualGridSetpoint
    : Math.max(
        0,
        Math.round(
            Math.min(
                requestedGridSetpoint,
                voltageLimitedSetpoint
            )
        )
    );

// Grid CT battery support: active only when HV protection is enabled AND voltage is in the
// limiter range (voltageLimitActive). Target setpoint = max(200, ACloads - supportW) so
// the battery covers exactly supportW watts of AC load, pulling grid CT down by that amount.
const applyGridSupport = highVoltageGridSupportW > 0
    && highVoltageProtectionEnabled
    && voltageLimitActive
    && hasGridPowerReading
    && !forceChargeAllowed
    && !gridSupportLowSunBlocked
    && !manualDischargeEnabled;

const supportCap = applyGridSupport
    ? Math.max(MIN_GRID_SETPOINT, Math.round(storedAcLoadPowerW - highVoltageGridSupportW))
    : Number.POSITIVE_INFINITY;

const plannedGridSupportW = supportWindowActive && supportWindowRemainingHours > 0 && highVoltageGridSupportW > 0
    ? Math.min(
        highVoltageGridSupportW,
        Math.max(
            0,
            Math.round(
                ((usableStoredSupportAh + predictedSupportAh) * Math.max(1, Number.isFinite(batteryVoltage) && batteryVoltage > 0 ? batteryVoltage : BATTERY_NOMINAL_VOLTAGE)) /
                supportWindowRemainingHours
            )
        )
    )
    : 0;
const liveSolarAssistW = supportWindowActive
    ? Math.round(Math.max(0, solarGenerationW) * (gridSupportSolarAssistGainPct / 100))
    : 0;
const adaptiveGridSupportW = supportWindowActive
    ? Math.min(
        highVoltageGridSupportW,
        Math.round(Math.max(0, batteryVoltage) * gridSupportMaxDischargeA),
        Math.max(0, plannedGridSupportW + liveSolarAssistW)
    )
    : 0;
const adaptiveGridSupportActive = adaptiveGridSupportW > 0
    && adaptiveGridSupportEnabled
    && !boostActive
    && !forceChargeAllowed
    && !gridSupportLowSunBlocked
    && !manualDischargeEnabled
    && !nightWindow
    && hasGridPowerReading
    && (!highVoltageProtectionEnabled || !voltageLimitActive || hybridGridSupportEnabled);
const adaptiveSupportCap = adaptiveGridSupportActive
    ? Math.max(supportMinGridImportW, Math.round(storedAcLoadPowerW - adaptiveGridSupportW))
    : Number.POSITIVE_INFINITY;

const applyDayHighAcLoadReduction = !nightWindow
    && storedAcLoadPowerW > DAY_HIGH_AC_LOAD_THRESHOLD_W
    && !forceChargeAllowed
    && !manualDischargeEnabled;
const dayHighAcLoadCap = applyDayHighAcLoadReduction
    ? Math.max(0, rawFinalGridSetpoint - DAY_HIGH_AC_LOAD_REDUCTION_W)
    : Number.POSITIVE_INFINITY;

const cappedGridSetpoint = Math.min(rawFinalGridSetpoint, adaptiveSupportCap, supportCap, dayHighAcLoadCap);

// ==========================
// GRID EXPORT GUARD
// ==========================
// Power must never be pushed to the grid. A negative GRID CT reading means the Multi is
// inverting surplus from the external MPPT because DVCC does not let the battery absorb it.
// The battery becomes the compensating load: the DVCC limit is raised to cover PV + boost and
// the ESS setpoint is floored at the minimum grid import. The boost integrates the CT error
// (slowly, respecting the output delay) until the CT sits at the minimum import, and the guard
// releases itself once the boost decays to 0.
const exportGuardTargetW = supportMinGridImportW;
const exportGuardVoltage = Math.max(1, Number.isFinite(batteryVoltage) && batteryVoltage > 0 ? batteryVoltage : BATTERY_NOMINAL_VOLTAGE);
let exportGuardActive = Boolean(exportGuard.active);
let exportGuardBoostW = Math.max(0, Number(exportGuard.boostW) || 0);
let exportGuardSince = String(exportGuard.since || "");
let exportGuardLastAdjustTs = Number(exportGuard.lastAdjustTs) || 0;

if (!exportGuardEnabled || !hasGridPowerReading) {
    exportGuardActive = false;
    exportGuardBoostW = 0;
    exportGuardSince = "";
    exportGuardLastAdjustTs = 0;
}
else {
    const exportGuardErrorW = exportGuardTargetW - gridPowerSignedW;

    if (!exportGuardActive && gridPowerSignedW < 0) {
        exportGuardActive = true;
        exportGuardSince = now.toISOString();
        exportGuardLastAdjustTs = now.getTime();
        exportGuardBoostW = clamp(Math.round(exportGuardErrorW), 0, EXPORT_GUARD_MAX_BOOST_W);
    }
    else if (exportGuardActive && now.getTime() - exportGuardLastAdjustTs >= EXPORT_GUARD_UPDATE_INTERVAL_MS) {
        const belowTarget = exportGuardErrorW > 0;
        const aboveTarget = gridPowerSignedW > exportGuardTargetW + EXPORT_GUARD_RELEASE_DEADBAND_W;

        if (belowTarget || aboveTarget) {
            const stepW = clamp(exportGuardErrorW * EXPORT_GUARD_GAIN, -EXPORT_GUARD_MAX_STEP_W, EXPORT_GUARD_MAX_STEP_W);
            exportGuardBoostW = clamp(Math.round(exportGuardBoostW + stepW), 0, EXPORT_GUARD_MAX_BOOST_W);
        }

        exportGuardLastAdjustTs = now.getTime();

        if (exportGuardBoostW <= 0) {
            exportGuardActive = false;
            exportGuardSince = "";
            exportGuardLastAdjustTs = 0;
        }
    }
}

exportGuard = {
    active: exportGuardActive,
    boostW: exportGuardBoostW,
    since: exportGuardSince,
    lastAdjustTs: exportGuardLastAdjustTs
};

const exportGuardSetpointFloorW = exportGuardActive ? exportGuardTargetW : 0;
const exportGuardChargeCurrent = exportGuardActive
    ? round1(clamp((Math.max(0, storedPvChargerPowerW) + exportGuardBoostW) / exportGuardVoltage, 0, MAX_CHARGE_CURRENT))
    : 0;

const finalGridSetpoint = Math.max(cappedGridSetpoint, exportGuardSetpointFloorW);

const currentRatio = baseScheduleSetpoint > 0
    ? clamp(finalGridSetpoint / baseScheduleSetpoint, 0, 1)
    : 0;
const forceChargeAvailableW = Math.max(0, Math.round(finalGridSetpoint - Math.max(0, storedAcLoadPowerW)));
const forceChargeRatio = effectiveForceChargeGridW > 0
    ? clamp(forceChargeAvailableW / effectiveForceChargeGridW, 0, 1)
    : 0;

const scheduledChargeCurrent = manualDischargeEnabled
    ? 0
    : (forceChargeAllowed
        ? round1(baseChargeCurrent * forceChargeRatio)
        : (baseChargeCurrent > 0
            ? round1(baseChargeCurrent * currentRatio)
            : 0));
// The export guard may only raise the DVCC limit, never lower a scheduled charge.
const finalChargeCurrent = Math.max(scheduledChargeCurrent, exportGuardChargeCurrent);
const usedWh = hourBudget.usedWh || 0;
const acUsedWh = acLoadBudget.usedWh || 0;
const solarUsedWh = solarBudget.usedWh || 0;
const usedEnergyStartLabel = formatTime(new Date(hourBudget.startTs || now.getTime()));
const usedEnergyEndLabel = formatTime(now);
const secondsIntoHour = minute * 60 + second;
const secondsLeftInHour = Math.max(1, 3600 - secondsIntoHour);
const hoursLeftInHour = secondsLeftInHour / 3600;
const remainingWh = clamp(hourlyBudgetLimit - usedWh, 0, hourlyBudgetLimit);
const remainingAverageW = Math.round(remainingWh / hoursLeftInHour);
const remainingAverageText = hourBudget.fullHourCoverage
    ? ` | ${remainingAverageW}W left`
    : "";

// Live tariff view: today's import, energy still allowed today at the season plan, billable peaks.
const liveHourBillableWh = usedWh * getBillingFactor(hour, tariffConstants);
const todayGridWh = (Number(tariffDay.gridWh) || 0) + usedWh;
const todayPeakBillableWh = Math.max(Number(tariffDay.peakBillableWh) || 0, liveHourBillableWh);
let todayRemainingWh = remainingWh;

for (let futureHour = hour + 1; futureHour < 24; futureHour += 1) {
    todayRemainingWh += isNightHour(futureHour) ? seasonProfile.nightSetpointW : seasonProfile.daySetpointW;
}

const monthDayPeaks = Object.assign({}, tariffMonth.dayPeaks);
monthDayPeaks[todayKey] = Math.max(Number(monthDayPeaks[todayKey]) || 0, Math.round(todayPeakBillableWh));
const monthTopPeaksWh = Object.keys(monthDayPeaks)
    .map(dayKey => Number(monthDayPeaks[dayKey]) || 0)
    // A day without import yet (e.g. just after midnight) must not dilute the average.
    .filter(value => value > 0)
    .sort((a, b) => b - a)
    .slice(0, 3);
const monthTop3AverageW = monthTopPeaksWh.length > 0
    ? Math.round(monthTopPeaksWh.reduce((sum, value) => sum + value, 0) / monthTopPeaksWh.length)
    : 0;
const monthTier = getTierForAverageW(monthTop3AverageW);
const tariffView = {
    season: seasonProfile.season,
    seasonMode: tariffSeason.mode,
    nextSeason: tariffSeason.nextSeason,
    nextSwitchKey: tariffSeason.nextSwitchKey,
    winterStart: formatMmdd(tariffConstants.WINTER_START_MMDD),
    summerStart: formatMmdd(tariffConstants.SUMMER_START_MMDD),
    nightBillingPct: tariffConstants.TARIFF_NIGHT_BILLING_PCT,
    tier: seasonProfile.tier,
    tierLimitW: seasonProfile.tierLimitW,
    gridCurrentLimitA,
    summer: summerProfile,
    winter: winterProfile,
    todayKey,
    todayGridWh: Math.round(todayGridWh),
    todayRemainingWh: Math.round(todayRemainingWh),
    hourRemainingWh: Math.round(remainingWh),
    todayPeakBillableWh: Math.round(todayPeakBillableWh),
    todayPeakHourKey: liveHourBillableWh >= (Number(tariffDay.peakBillableWh) || 0) ? hourBudget.hourKey : tariffDay.peakHourKey,
    todayPeakHeadroomWh: Math.round(seasonProfile.tierLimitW - todayPeakBillableWh),
    monthKey: tariffMonth.monthKey,
    monthTrackedDays: Object.keys(monthDayPeaks).length,
    monthTopPeaksWh,
    monthTop3AverageW,
    monthTier,
    monthFitsTier: monthTier <= seasonProfile.tier
};
const tariffText = ` | ${seasonProfile.season === "WINTER" ? "WIN" : "SUM"} T${seasonProfile.tier} ${gridCurrentLimitA}A`
    + ` | Day ${(todayGridWh / 1000).toFixed(1)}kWh left ${(todayRemainingWh / 1000).toFixed(1)}kWh`
    + ` | Month T${monthTier}`;
const estimatedDischargeW = manualDischargeEnabled
    ? Math.max(0, Math.round(Math.max(0, storedAcLoadPowerW) - finalGridSetpoint))
    : 0;
const estimatedDischargeA = manualDischargeEnabled && batteryVoltage > 0
    ? round1(estimatedDischargeW / batteryVoltage)
    : 0;
const currentChargingPowerW = Math.max(0, Math.round(Math.max(0, batteryVoltage) * finalChargeCurrent));

context.set("boostActive", boostActive);
context.set("activeWindow", windowName);
context.set("voltageLimitActive", voltageLimitActive);
context.set("gridSetpoint", finalGridSetpoint);
context.set("manualDischarge", manualDischarge);
context.set("exportGuard", exportGuard);

// ==========================
// STATUS
// ==========================
const limitFlags = [];

if (voltageLimitActive && finalGridSetpoint <= voltageLimitedSetpoint) {
    limitFlags.push("HV");
}

if (solarForecast.valid && forecastRestoreAh > 0) {
    limitFlags.push(`SOL:${solarForecast.condition.toUpperCase()}`);
}

if (manualDischargeEnabled) {
    limitFlags.push(`MD:${MANUAL_DISCHARGE_MAX_CURRENT}A`);
}
else if (manualDischarge.active && !manualDischargeAllowedByLoad) {
    limitFlags.push(`MD-HOLD>${MANUAL_DISCHARGE_MAX_AC_LOAD_W}W`);
}

if (applyDayHighAcLoadReduction) {
    limitFlags.push(`AC-HIGH:-${DAY_HIGH_AC_LOAD_REDUCTION_W}W`);
}

if (gridSupportLowSunBlocked) {
    limitFlags.push(`GS-SUN<${gridSupportDisableNoSunBelowW}W`);
}

if (exportGuardActive) {
    limitFlags.push(`EXP:+${Math.round(exportGuardBoostW)}W@${Math.round(gridPowerSignedW)}W`);
}

if (adaptiveGridSupportActive) {
    limitFlags.push(`GS-A:${Math.round(adaptiveGridSupportW)}W`);
}

if (forceChargeAllowed) {
    limitFlags.push(`FC:${effectiveForceChargeGridW}W${forceChargeLimiterEnabled ? '(LIM)' : ''}`);
} else if (forceChargeEnabled && forceChargeGridW > 0 && forceChargeLimiterEnabled) {
    limitFlags.push(`FC-ARMED:${forceChargeGridW}W`);
}

if (applyGridSupport || (highVoltageGridSupportW > 0 && voltageLimitActive && !gridSupportLowSunBlocked)) {
    limitFlags.push(`GS:${highVoltageGridSupportW}W${voltageLimitActive ? '(HV)' : ''}`);
}

let fill = "grey";

if (windowName === "MANUAL-DISCHARGE") {
    fill = "red";
}
else if (windowName === "FORCE-CHARGE") {
    fill = finalChargeCurrent > 0 ? "blue" : "yellow";
}
else if (windowName === "NIGHT") {
    fill = finalChargeCurrent > 0 ? "blue" : "yellow";
}
else if (windowName === "MORNING" || windowName === "EVENING") {
    fill = finalChargeCurrent > 0 ? "green" : "yellow";
}

const flagsText = limitFlags.length > 0 ? ` | ${limitFlags.join("+")}` : "";
const dcPowerText = storedPvChargerPowerW > 0
    ? ` | PV ${Math.round(storedPvChargerPowerW)}W | Sol ${Math.round(solarUsedWh)}Wh`
    : "";
const forecastText = solarForecast.valid
    ? ` | SOL ${solarForecast.condition} ${forecastRestoreAh.toFixed(1)}Ah`
    : "";
const restoreText = ` | Def ${effectiveConsumedAhDeficit.toFixed(1)}Ah | Grid ${gridRestoreAhNeeded.toFixed(1)}Ah`;
const manualText = manualDischarge.active
    ? (manualDischargeEnabled
        ? ` | Grid>=${MANUAL_DISCHARGE_MIN_GRID_W}W | Dis ${estimatedDischargeA.toFixed(1)}A/${MANUAL_DISCHARGE_MAX_CURRENT}A | AC<=${MANUAL_DISCHARGE_MAX_AC_LOAD_W}W | Stop<=${manualDischargeStopVoltage.toFixed(1)}V`
        : ` | MD hold AC>${MANUAL_DISCHARGE_MAX_AC_LOAD_W}W | Using schedule | Stop<=${manualDischargeStopVoltage.toFixed(1)}V`)
    : "";

node.status({
    fill,
    shape: finalChargeCurrent > 0 || finalGridSetpoint !== 0 ? "dot" : "ring",
    text: `${windowName} | V=${batteryVoltage.toFixed(2)}V | ${finalChargeCurrent}A | ${finalGridSetpoint}W${restoreText}${manualText} | Grid ${usedEnergyStartLabel}-${usedEnergyEndLabel} ${Math.round(usedWh)}Wh | AC ${Math.round(acUsedWh)}Wh${remainingAverageText}${tariffText}${dcPowerText}${forecastText}${flagsText}`
});

const hourlyLogMsg = hourRolledOver
    ? {
        topic: "hourly-energy",
        payload: Object.assign(
            { hourKey: prevHourKey, gridWh: Math.round(prevHourGridWh), acWh: Math.round(prevHourAcWh), solarWh: Math.round(prevHourSolarWh) },
            closedHourRecord
        )
    }
    : null;

// Ask for the month history once per month (and again after a redeploy resets the context).
// Decided here, after the early returns, so the request is never dropped.
const tariffHistoryState = context.get("tariffHistoryState") || { monthKey: "", requestedAt: 0 };
let tariffHistoryRequestMsg = null;

if (tariffHistoryState.monthKey !== tariffMonth.monthKey
    && now.getTime() - (Number(tariffHistoryState.requestedAt) || 0) >= TARIFF_HISTORY_RETRY_MS) {
    tariffHistoryRequestMsg = {
        topic: TARIFF_HISTORY_TOPIC,
        payload: buildEnergyHistoryCommand(tariffMonth.monthKey)
    };
    context.set("tariffHistoryState", { monthKey: "", requestedAt: now.getTime() });
}

return buildOutputs(
    finalChargeCurrent,
    finalGridSetpoint,
    hourlyLogMsg
);