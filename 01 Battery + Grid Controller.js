// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Flow version rule:
// - the Node-RED tab label in `flows.json` uses `d#<n>` as the deployed flow version marker
// - increment that marker every time `flows.json` changes so the active Node-RED flow version is visible
// - keep this file, the embedded controller function, and the tab version rule synchronized
// Current behavior implemented after iterative tuning:
// 1. This function now has 6 outputs:
//    - output 1 -> DVCC charge current limit (A)
//    - output 2 -> ESS grid setpoint (W)
//    - output 3 -> VE.Bus AC input current limit (A)
//    - output 4 -> notification/log message when the grid setpoint changes
//    - output 5 -> hourly energy rollover message for log/summary writers
//    - output 6 -> structured controller trace payload for debugging
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
// 6. Base grid setpoint schedule:
//    - 2850W at night
//    - 1950W during the rest of the day
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
// 13. VE.Bus Input 1 current limit is no longer controlled by this function.
// 14. A VRM notification is emitted when the grid setpoint changes.
// 15. `boostActive`, `activeWindow`, battery voltage, grid power, and display-only hourly Wh are
//     all stored in context.
// 16. `day-night.txt` and the embedded `func` in `flows.json` must always stay synchronized.
// 17. Increment the `d#<n>` tab version in `flows.json` every time the flow file changes.
// 18. AC loads hourly Wh is tracked for display only (same integration logic as grid import Wh).
// 19. Notifications are written to a daily file at `/data/grid-control-logs/grid-control-YYYY-MM-DD.log`.
//     Old log files are pruned automatically; files older than 45 days are deleted at midnight.
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

// ==========================
// CONSTANTS
// ==========================
const MAX_CHARGE_CURRENT = 25;
const BATTERY_NOMINAL_VOLTAGE = 53;
const SOLAR_TO_BATTERY_EFFICIENCY = 0.9;
const RESTORE_AH_DEADBAND = 0.5;

const SOLAR_FORECAST_MAX_AGE_HOURS = 18;

const DAY_BASE_GRID_SETPOINT = 1950;
const NIGHT_BASE_GRID_SETPOINT = 2850;
const DAY_HOURLY_BUDGET_W = 1950;
const NIGHT_HOURLY_BUDGET_W = 2850;

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
const hasGridPowerReading = rawStoredGridPower !== undefined && rawStoredGridPower !== null && Number.isFinite(Number(rawStoredGridPower));
const storedGridPowerW = hasGridPowerReading ? Math.max(0, Number(rawStoredGridPower)) : 0;
let gridPowerW = storedGridPowerW;
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
            inputPayload: msg.payload,
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
    const traceMsg = buildTraceOutput(chargeCurrent, gridSetpoint, hourlyLogMsg);

    return [
        {
            topic: "charge-current-limit",
            payload: chargeCurrent
        },
        {
            topic: "grid-setpoint",
            payload: gridSetpoint
        },
        {
            topic: "ac-input-current-limit",
            payload: null
        },
        notifyMsg,
        hourlyLogMsg || null,
        traceMsg
    ];
}

// ==========================
// UPDATE STORED INPUTS
// ==========================
const prevHourKey = hourBudget.hourKey;
const prevHourGridWh = Number(hourBudget.usedWh) || 0;
const prevHourAcWh = Number(acLoadBudget.usedWh) || 0;
const prevHourSolarWh = Number(solarBudget.usedWh) || 0;
// Solar generation comes only from PV charger power; DC bus power stays informational.
const solarGenerationW = storedPvChargerPowerW;
hourBudget = advanceHourBudget(hourBudget, now, storedGridPowerW);
acLoadBudget = advanceHourBudget(acLoadBudget, now, storedAcLoadPowerW);
solarBudget = advanceHourBudget(solarBudget, now, solarGenerationW);
const hourRolledOver = prevHourKey && prevHourKey !== hourBudget.hourKey;

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
        gridPowerW = Math.max(0, incomingGridPower);
        context.set("gridPowerW", gridPowerW);
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

const baseScheduleSetpoint = nightWindow ? NIGHT_BASE_GRID_SETPOINT : DAY_BASE_GRID_SETPOINT;
const hourlyBudgetLimit = nightWindow ? NIGHT_HOURLY_BUDGET_W : DAY_HOURLY_BUDGET_W;
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

const finalGridSetpoint = Math.min(rawFinalGridSetpoint, adaptiveSupportCap, supportCap, dayHighAcLoadCap);

const currentRatio = baseScheduleSetpoint > 0
    ? clamp(finalGridSetpoint / baseScheduleSetpoint, 0, 1)
    : 0;
const forceChargeAvailableW = Math.max(0, Math.round(finalGridSetpoint - Math.max(0, storedAcLoadPowerW)));
const forceChargeRatio = effectiveForceChargeGridW > 0
    ? clamp(forceChargeAvailableW / effectiveForceChargeGridW, 0, 1)
    : 0;

const finalChargeCurrent = manualDischargeEnabled
    ? 0
    : (forceChargeAllowed
        ? round1(baseChargeCurrent * forceChargeRatio)
        : (baseChargeCurrent > 0
            ? round1(baseChargeCurrent * currentRatio)
            : 0));
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

if (adaptiveGridSupportActive) {
    limitFlags.push(`GS-A:${Math.round(adaptiveGridSupportW)}W`);
}

if (forceChargeAllowed) {
    limitFlags.push(`FC:${effectiveForceChargeGridW}W${forceChargeLimiterEnabled ? '(LIM)' : ''}`);
} else if (forceChargeEnabled && forceChargeGridW > 0 && forceChargeLimiterEnabled) {
    limitFlags.push(`FC-ARMED:${forceChargeGridW}W`);
}

if (applyGridSupport || (highVoltageGridSupportW > 0 && voltageLimitActive)) {
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
    text: `${windowName} | V=${batteryVoltage.toFixed(2)}V | ${finalChargeCurrent}A | ${finalGridSetpoint}W${restoreText}${manualText} | Grid ${usedEnergyStartLabel}-${usedEnergyEndLabel} ${Math.round(usedWh)}Wh | AC ${Math.round(acUsedWh)}Wh${remainingAverageText}${dcPowerText}${forecastText}${flagsText}`
});

const hourlyLogMsg = hourRolledOver
    ? { topic: "hourly-energy", payload: { hourKey: prevHourKey, gridWh: Math.round(prevHourGridWh), acWh: Math.round(prevHourAcWh), solarWh: Math.round(prevHourSolarWh) } }
    : null;

return buildOutputs(
    finalChargeCurrent,
    finalGridSetpoint,
    hourlyLogMsg
);