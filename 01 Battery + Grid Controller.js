// ==========================
// BATTERY + GRID CONTROLLER
// ==========================
// Source of the function node "Battery + Grid Controller" in flows.json
// (sync: `node tools/flows.js sync`, every flows.json change bumps the tab label d#<n>).
//
// Outputs (7):
//   1 -> DVCC charge current limit (A)
//   2 -> ESS grid setpoint (W)
//   3 -> VE.Bus AC input current limit (A), sent on change and on every hour rollover
//   4 -> notification / log message when the grid setpoint changes
//   5 -> hourly energy record of the closed hour (monthly CSV + daily summary)
//   6 -> controller trace for the dashboards (throttled, see TRACE_MIN_INTERVAL_MS)
//   7 -> shell command for the exec node that reads the month's energy files
//
// Inputs (msg.topic):
//   battery-voltage, battery-consumed-ah, grid-power (signed, negative = export), ac-load-power,
//   dc-power (informational), pv-charger-power, manual-discharge, manual-discharge-stop-voltage,
//   tariff-history (reply of output 7); any other topic only recalculates.
//
// Logic:
// - Restoration: the BMS consumed Ah is the deficit to refill, less the Ah today's solar forecast is
//   expected to bring. NIGHT (22-06) charges only when the MORNING window (06-12) alone can no longer
//   cover the rest; MORNING charges whatever is left. Charging runs at MAX_CHARGE_CURRENT.
// - Grid setpoint: the tariff season plan (summer tier 1, winter tier 2 by default). Day setpoint =
//   tier limit - margin, night setpoint = day + night extra % (night hours are billed at
//   TARIFF_NIGHT_BILLING_PCT). The VE.Bus input current limit is the setpoint + headroom at the
//   nominal grid voltage, rounded to 0.5 A and capped at GRID_CURRENT_MAX_A.
// - High-voltage protection: above `start` V the setpoint tapers down towards the measured grid import
//   (fully at `full` V), released at `release` V. One recalculation moves the setpoint by at most
//   MAX_GRID_STEP_W. While it is active, Grid CT support lets the battery carry `gridSupportW` of the load.
// - Adaptive day support (modes adaptive-day / hybrid): spreads the usable battery Ah plus the
//   remaining solar forecast over the support window.
// - Force charge: charges from the grid at `forceChargeGridW`; with the limiter it starts at or below
//   `forceChargeLimiterStart` V, stops at `forceChargeLimiterRelease` V and tapers up to the full
//   charge current at `forceChargeLimiterFull` V.
// - Manual discharge (inject): the battery covers the load down to MANUAL_DISCHARGE_MIN_GRID_W import,
//   at most MANUAL_DISCHARGE_MAX_CURRENT; paused above MANUAL_DISCHARGE_MAX_AC_LOAD_W, stopped at the
//   stop voltage.
// - Day high load: above DAY_HIGH_AC_LOAD_THRESHOLD_W of AC load (outside the night window) the setpoint
//   is lowered by DAY_HIGH_AC_LOAD_REDUCTION_W.
// - Export guard: on a negative GRID CT reading the DVCC limit is raised to PV + boost and the setpoint
//   is floored at the minimum grid import; the boost integrates the CT error and the guard releases
//   itself when the boost is back at 0. It overrides every other window.
// - Hour / day / month tracking: grid, AC and solar Wh per clock hour; today's import and billable peak;
//   the month's top-3 day peaks (= the tier the month is heading for). After a restart the closed hours
//   are read back from the energy files (output 7 -> `tariff-history`).
// - Settings are read live from flow context: `highVoltageSettings` (Protection page) and
//   `controllerConstantsOverrides` (Constants page, every key of CONSTANT_SPECS).

// ==========================
// TOPICS
// ==========================
const BATTERY_TOPIC = "battery-voltage";
const BATTERY_CONSUMED_AH_TOPIC = "battery-consumed-ah";
const GRID_TOPIC = "grid-power";
const AC_LOAD_TOPIC = "ac-load-power";
const MANUAL_DISCHARGE_TOPIC = "manual-discharge";
const MANUAL_DISCHARGE_STOP_VOLTAGE_TOPIC = "manual-discharge-stop-voltage";
const DC_POWER_TOPIC = "dc-power";
const PV_CHARGER_TOPIC = "pv-charger-power";
const TARIFF_HISTORY_TOPIC = "tariff-history";
const TARIFF_HISTORY_RETRY_MS = 60000;
// Sensor updates arrive several times per second; the trace (output 6) rebuilds dashboards,
// so for these topics it is sent at most once per TRACE_MIN_INTERVAL_MS.
const SENSOR_TOPICS = [BATTERY_TOPIC, BATTERY_CONSUMED_AH_TOPIC, GRID_TOPIC, AC_LOAD_TOPIC, DC_POWER_TOPIC, PV_CHARGER_TOPIC];
const TRACE_MIN_INTERVAL_MS = 5000;
const ENERGY_LOG_DIR = "/data/home/nodered/grid-control-logs";

// #include lib/grid/constants.js

// #include lib/grid/helpers.js

// ==========================
// TIME, SETTINGS, STORED STATE
// ==========================
const now = new Date();
const nowTs = now.getTime();
const hour = now.getHours();
const C = getConstants();
const highVoltageSettings = sanitizeHighVoltageSettings(flow.get("highVoltageSettings")) || DEFAULT_HIGH_VOLTAGE_SETTINGS;

let boostActive = context.get("boostActive") || false;
const previousWindow = context.get("activeWindow") || "none";
let batteryVoltage = Number(context.get("batteryVoltage"));
const rawStoredConsumedAh = context.get("batteryConsumedAh");
let consumedAhDeficit = Number.isFinite(Number(rawStoredConsumedAh)) ? Math.max(0, Number(rawStoredConsumedAh)) : Number.NaN;
// Signed CT reading (negative = export); the clamped value feeds import-Wh tracking and floors.
const storedGrid = readStoredNumber("gridPowerW");
let hasGridPowerReading = storedGrid.has;
const storedGridPowerW = Math.max(0, storedGrid.value);
let gridPowerW = storedGridPowerW;
let gridPowerSignedW = storedGrid.value;
const storedAcLoadPowerW = Math.max(0, readStoredNumber("acLoadPowerW").value);
const storedDc = readStoredNumber("dcPowerW");
const storedDcPowerW = storedDc.value;
const hasDcPowerReading = storedDc.has;
const storedPvChargerPowerW = Math.max(0, readStoredNumber("pvChargerPowerW").value);
// Solar generation is the PV charger power only; DC bus power stays informational.
const solarGenerationW = storedPvChargerPowerW;
const rawStoredManualDischargeStopVoltage = context.get("manualDischargeStopVoltage");
let manualDischargeStopVoltage = Number.isFinite(Number(rawStoredManualDischargeStopVoltage))
    ? Number(rawStoredManualDischargeStopVoltage)
    : C.MANUAL_DISCHARGE_STOP_VOLTAGE;
let manualDischarge = context.get("manualDischarge") || { active: false, startedAt: "", source: "" };
let voltageLimitActive = context.get("voltageLimitActive") || false;
let forceChargeLimiterActive = context.get("forceChargeLimiterActive") || false;
const previousGridSetpoint = Number(context.get("gridSetpoint"));
const storedExportGuard = context.get("exportGuard") || {};
let hourBudget = context.get("hourBudget") || emptyBudget();
let acLoadBudget = context.get("acLoadBudget") || emptyBudget();
let solarBudget = context.get("solarBudget") || emptyBudget();
let hourPeak = context.get("hourPeak") || { hourKey: "", peakW: 0 };

// ==========================
// HOURLY ENERGY COUNTERS
// ==========================
const prevHourKey = hourBudget.hourKey;
const prevHourGridWh = Number(hourBudget.usedWh) || 0;
const prevHourAcWh = Number(acLoadBudget.usedWh) || 0;
const prevHourSolarWh = Number(solarBudget.usedWh) || 0;
// Minutes of the closed hour that were actually integrated (60 = full hour, less after a restart).
const prevHourCoverageMin = Math.round(clamp(((Number(hourBudget.lastTs) || 0) - (Number(hourBudget.startTs) || 0)) / 60000, 0, 60));
const prevHourPeakW = hourPeak.hourKey === prevHourKey ? Math.round(Number(hourPeak.peakW) || 0) : 0;
hourBudget = advanceHourBudget(hourBudget, now, storedGridPowerW);
acLoadBudget = advanceHourBudget(acLoadBudget, now, storedAcLoadPowerW);
solarBudget = advanceHourBudget(solarBudget, now, solarGenerationW);
const hourRolledOver = Boolean(prevHourKey) && prevHourKey !== hourBudget.hourKey;

// ==========================
// DAILY GRID ENERGY / CAPACITY TIER TRACKING
// ==========================
// Closed hours are folded into the day total and the month's per-day billable peak.
// Night hours count at TARIFF_NIGHT_BILLING_PCT, like Elvenett does for kapasitetsledd.
const todayKey = hourBudget.hourKey.substring(0, 10);
const monthKey = todayKey.substring(0, 7);
const emptyTariffDay = dayKey => ({ dayKey, gridWh: 0, peakBillableWh: 0, peakHourKey: "" });
let tariffDay = context.get("tariffDay") || emptyTariffDay("");
let tariffMonth = context.get("tariffMonth") || { monthKey: "", dayPeaks: {} };
// Extra columns of the closed hour for the monthly energy CSV.
let closedHourRecord = null;

if (hourRolledOver) {
    const closedDayKey = prevHourKey.substring(0, 10);
    const closedHourOfDay = Number(prevHourKey.substring(11, 13));
    const closedBillableWh = prevHourGridWh * getBillingFactor(closedHourOfDay);
    const closedHourDate = new Date(
        Number(prevHourKey.substring(0, 4)),
        Number(prevHourKey.substring(5, 7)) - 1,
        Number(prevHourKey.substring(8, 10)),
        closedHourOfDay
    );
    const closedProfile = buildSeasonProfile(getTariffSeason(closedHourDate).winter);

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

if (tariffMonth.monthKey !== monthKey) {
    tariffMonth = { monthKey, dayPeaks: {} };
}

// History restore: the closed hours of this month are read back from the energy files
// (monthly CSV + legacy daily energy-*.log) so Day / Month survive a restart or redeploy.
if (msg.topic === TARIFF_HISTORY_TOPIC && typeof msg.payload === "string") {
    const history = parseEnergyHistory(msg.payload, monthKey);
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

    context.set("tariffHistoryState", { monthKey, loadedAt: nowTs, hours: Object.keys(history).length });
}

context.set("tariffDay", tariffDay);
context.set("tariffMonth", tariffMonth);

// ==========================
// UPDATE STORED INPUTS
// ==========================
const incoming = Number(msg.payload);

if (msg.topic === BATTERY_TOPIC && Number.isFinite(incoming)) {
    batteryVoltage = incoming;
    context.set("batteryVoltage", batteryVoltage);
}
else if (msg.topic === BATTERY_CONSUMED_AH_TOPIC && Number.isFinite(normalizeConsumedAh(msg.payload))) {
    consumedAhDeficit = normalizeConsumedAh(msg.payload);
    context.set("batteryConsumedAh", consumedAhDeficit);
}
else if (msg.topic === GRID_TOPIC && Number.isFinite(incoming)) {
    gridPowerSignedW = incoming;
    gridPowerW = Math.max(0, incoming);
    hasGridPowerReading = true;
    context.set("gridPowerW", gridPowerSignedW);
}
else if (msg.topic === AC_LOAD_TOPIC && Number.isFinite(incoming)) {
    context.set("acLoadPowerW", Math.max(0, incoming));
}
else if (msg.topic === DC_POWER_TOPIC && Number.isFinite(incoming)) {
    context.set("dcPowerW", incoming);
}
else if (msg.topic === PV_CHARGER_TOPIC && Number.isFinite(incoming)) {
    context.set("pvChargerPowerW", Math.max(0, incoming));
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
else if (msg.topic === MANUAL_DISCHARGE_STOP_VOLTAGE_TOPIC && incoming >= 50 && incoming <= 60) {
    manualDischargeStopVoltage = incoming;
    context.set("manualDischargeStopVoltage", manualDischargeStopVoltage);
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
    node.status({ fill: "grey", shape: "ring", text: "WAITING FOR BATTERY VOLTAGE" });
    return null;
}

if (!Number.isFinite(consumedAhDeficit) && !manualDischarge.active) {
    node.status({ fill: "grey", shape: "ring", text: "WAITING FOR BMS CONSUMED AH" });
    return null;
}

// Voltage used to convert between W / Wh and A / Ah.
const referenceVoltage = Math.max(1, batteryVoltage > 0 ? batteryVoltage : C.BATTERY_NOMINAL_VOLTAGE);

// ==========================
// SEASON PLAN
// ==========================
const nightWindow = isNightHour(hour);
const morningWindow = isHourWithinWindow(hour, NIGHT_END_HOUR, MORNING_END_HOUR);
const eveningWindow = hour >= EVENING_START_HOUR;

const tariffSeason = getTariffSeason(now);
const summerProfile = buildSeasonProfile(false);
const winterProfile = buildSeasonProfile(true);
const seasonProfile = tariffSeason.winter ? winterProfile : summerProfile;
const baseScheduleSetpoint = nightWindow ? seasonProfile.nightSetpointW : seasonProfile.daySetpointW;
const gridCurrentLimitA = nightWindow ? seasonProfile.nightCurrentA : seasonProfile.dayCurrentA;
// Sent on change and re-asserted every hour so a Multi restart or manual edit is corrected.
const sendGridCurrentLimit = Number(context.get("gridCurrentLimitA")) !== gridCurrentLimitA || hourRolledOver;
context.set("gridCurrentLimitA", gridCurrentLimitA);

// ==========================
// PROTECTION SETTINGS
// ==========================
const highVoltageProtectionEnabled = highVoltageSettings.enabled;
const highVoltageGridSupportW = highVoltageSettings.gridSupportW;
const gridSupportMode = highVoltageSettings.gridSupportMode;
const adaptiveGridSupportEnabled = gridSupportMode !== GRID_SUPPORT_MODE_HV_ONLY;
const hybridGridSupportEnabled = gridSupportMode === GRID_SUPPORT_MODE_HYBRID;
const gridSupportStartHour = highVoltageSettings.gridSupportStartHour;
const gridSupportEndHour = highVoltageSettings.gridSupportEndHour;
const supportMinGridImportW = clamp(highVoltageSettings.gridSupportMinGridImportW, C.MIN_GRID_SETPOINT, HV_CLAMPED_FIELDS.gridSupportMinGridImportW[1]);
const gridSupportDisableNoSun = highVoltageSettings.gridSupportDisableNoSun;
const gridSupportDisableNoSunBelowW = highVoltageSettings.gridSupportDisableNoSunBelowW;
const gridSupportLowSunBlocked = gridSupportDisableNoSun
    && highVoltageGridSupportW > 0
    && solarGenerationW < gridSupportDisableNoSunBelowW;
const exportGuardEnabled = highVoltageSettings.exportGuardEnabled;
const forceChargeEnabled = highVoltageSettings.forceChargeEnabled;
const forceChargeGridW = highVoltageSettings.forceChargeGridW;
const forceChargeLimiterEnabled = highVoltageSettings.forceChargeLimiterEnabled;
const forceChargeLimiterStart = highVoltageSettings.forceChargeLimiterStart;
const forceChargeLimiterFull = highVoltageSettings.forceChargeLimiterFull;

// ==========================
// FORCE CHARGE
// ==========================
// The limiter has its own hysteresis: on at or below `start` V, off at or above `release` V.
if (forceChargeLimiterEnabled && forceChargeEnabled && forceChargeGridW > 0) {
    if (!forceChargeLimiterActive && batteryVoltage <= forceChargeLimiterStart) {
        forceChargeLimiterActive = true;
    }
    if (forceChargeLimiterActive && batteryVoltage >= highVoltageSettings.forceChargeLimiterRelease) {
        forceChargeLimiterActive = false;
    }
}
else {
    forceChargeLimiterActive = false;
}
context.set("forceChargeLimiterActive", forceChargeLimiterActive);

const forceChargeAllowed = forceChargeEnabled && forceChargeGridW > 0
    && (!forceChargeLimiterEnabled || forceChargeLimiterActive);

// With the limiter: `forceChargeGridW` at the start voltage, rising to the full charge power at `full` V.
let effectiveForceChargeGridW = forceChargeGridW;
if (forceChargeAllowed && forceChargeLimiterEnabled) {
    const fcTaper = clamp((forceChargeLimiterStart - batteryVoltage) / (forceChargeLimiterStart - forceChargeLimiterFull), 0, 1);
    const maxForceChargeW = Math.round(C.MAX_CHARGE_CURRENT * Math.max(1, batteryVoltage));
    effectiveForceChargeGridW = Math.round(forceChargeGridW + fcTaper * (maxForceChargeW - forceChargeGridW));
}

// In FORCE-CHARGE the DVCC limit follows the target power; it is not capped at MAX_CHARGE_CURRENT.
const forceChargeTargetCurrent = Math.round(effectiveForceChargeGridW / referenceVoltage);

// ==========================
// CAPACITY RESTORATION
// ==========================
const solarForecast = getSolarForecastSummary(now);
const effectiveConsumedAhDeficit = Number.isFinite(consumedAhDeficit) ? consumedAhDeficit : 0;
const forecastRestoreAh = solarForecast.valid && solarForecast.energyKWh > 0
    ? (solarForecast.energyKWh * 1000 * C.SOLAR_TO_BATTERY_EFFICIENCY) / referenceVoltage
    : 0;
const gridRestoreAhNeeded = Math.max(0, effectiveConsumedAhDeficit - forecastRestoreAh);
const remainingNightHours = getWindowRemainingHours(now, NIGHT_START_HOUR, NIGHT_END_HOUR);
const remainingMorningHours = getRemainingMorningHours(now);
const remainingMorningCapacityAh = remainingMorningHours * C.MAX_CHARGE_CURRENT;
const morningSolarChargeHold = solarForecast.valid && forecastRestoreAh > 0 && batteryVoltage > MORNING_SOLAR_HOLD_VOLTAGE;

if (manualDischarge.active && batteryVoltage <= manualDischargeStopVoltage) {
    manualDischarge = { active: false, startedAt: "", source: "auto-stop-low-voltage" };
    context.set("manualDischarge", manualDischarge);
}

const manualDischargeAllowedByLoad = storedAcLoadPowerW <= C.MANUAL_DISCHARGE_MAX_AC_LOAD_W;
const manualDischargeEnabled = manualDischarge.active && manualDischargeAllowedByLoad;

let windowName = "OUTSIDE";
let baseChargeCurrent = 0;
boostActive = false;

if (manualDischargeEnabled) {
    windowName = "MANUAL-DISCHARGE";
}
else if (forceChargeAllowed) {
    windowName = "FORCE-CHARGE";
    baseChargeCurrent = forceChargeTargetCurrent;
}
else if (nightWindow) {
    windowName = "NIGHT";
    boostActive = gridRestoreAhNeeded > Math.max(C.RESTORE_AH_DEADBAND, remainingMorningCapacityAh);
}
else if (morningWindow) {
    windowName = "MORNING";
    boostActive = !morningSolarChargeHold && gridRestoreAhNeeded > C.RESTORE_AH_DEADBAND;
}
else if (eveningWindow) {
    windowName = "EVENING";
}

if (boostActive) {
    baseChargeCurrent = C.MAX_CHARGE_CURRENT;
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
    ? Math.min(baseScheduleSetpoint, Math.round(storedAcLoadPowerW + effectiveForceChargeGridW))
    : baseScheduleSetpoint;
let voltageLimitedSetpoint = requestedGridSetpoint;

if (voltageLimitActive) {
    // Taper from the requested setpoint down to what the house really takes from the grid.
    const floorSetpoint = forceChargeAllowed
        ? Math.min(requestedGridSetpoint, Math.round(storedAcLoadPowerW))
        : (hasGridPowerReading ? Math.min(requestedGridSetpoint, Math.round(storedGridPowerW)) : 0);
    const taper = clamp(
        (highVoltageSettings.full - batteryVoltage) / (highVoltageSettings.full - highVoltageSettings.start),
        0,
        1
    );

    voltageLimitedSetpoint = Math.round(stepTowards(
        previousGridSetpoint,
        Math.round(floorSetpoint + (requestedGridSetpoint - floorSetpoint) * taper),
        C.MAX_GRID_STEP_W
    ));
}

// ==========================
// GRID SETPOINT CAPS
// ==========================
const manualDischargePowerW = Math.round(Math.max(0, batteryVoltage) * C.MANUAL_DISCHARGE_MAX_CURRENT);
const rawFinalGridSetpoint = manualDischargeEnabled
    ? Math.max(C.MANUAL_DISCHARGE_MIN_GRID_W, Math.round(storedAcLoadPowerW - manualDischargePowerW))
    : Math.max(0, Math.round(Math.min(requestedGridSetpoint, voltageLimitedSetpoint)));

// Grid CT support: while the HV limiter is active the battery carries `gridSupportW` of the AC load.
const applyGridSupport = highVoltageGridSupportW > 0
    && highVoltageProtectionEnabled
    && voltageLimitActive
    && hasGridPowerReading
    && !forceChargeAllowed
    && !gridSupportLowSunBlocked
    && !manualDischargeEnabled;
const supportCap = applyGridSupport
    ? Math.max(C.MIN_GRID_SETPOINT, Math.round(storedAcLoadPowerW - highVoltageGridSupportW))
    : Number.POSITIVE_INFINITY;

// Adaptive day support: usable stored Ah + the forecast still to come, spread over the support window.
const batteryRemainingAh = highVoltageSettings.gridSupportBatteryCapacityAh > 0
    ? Math.max(0, highVoltageSettings.gridSupportBatteryCapacityAh - effectiveConsumedAhDeficit)
    : null;
const usableStoredSupportAh = batteryRemainingAh === null
    ? 0
    : Math.max(0, batteryRemainingAh - highVoltageSettings.gridSupportReserveAh);
const supportWindowActive = adaptiveGridSupportEnabled && isHourWithinWindow(hour, gridSupportStartHour, gridSupportEndHour);
const supportWindowRemainingHours = supportWindowActive ? getWindowRemainingHours(now, gridSupportStartHour, gridSupportEndHour) : 0;
const remainingForecastWh = supportWindowActive ? getRemainingForecastWh(now, gridSupportStartHour, gridSupportEndHour) : 0;
const remainingForecastAh = remainingForecastWh > 0
    ? (remainingForecastWh * C.SOLAR_TO_BATTERY_EFFICIENCY) / referenceVoltage
    : 0;
const predictedSupportAh = Math.max(
    0,
    remainingForecastAh * (highVoltageSettings.gridSupportForecastConfidencePct / 100) - highVoltageSettings.gridSupportWeakForecastBlockAh
);
const plannedGridSupportW = supportWindowActive && supportWindowRemainingHours > 0 && highVoltageGridSupportW > 0
    ? Math.min(
        highVoltageGridSupportW,
        Math.max(0, Math.round((usableStoredSupportAh + predictedSupportAh) * referenceVoltage / supportWindowRemainingHours))
    )
    : 0;
const liveSolarAssistW = supportWindowActive
    ? Math.round(solarGenerationW * (highVoltageSettings.gridSupportSolarAssistGainPct / 100))
    : 0;
const adaptiveGridSupportW = supportWindowActive
    ? Math.min(
        highVoltageGridSupportW,
        Math.round(Math.max(0, batteryVoltage) * highVoltageSettings.gridSupportMaxDischargeA),
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
    && storedAcLoadPowerW > C.DAY_HIGH_AC_LOAD_THRESHOLD_W
    && !forceChargeAllowed
    && !manualDischargeEnabled;
const dayHighAcLoadCap = applyDayHighAcLoadReduction
    ? Math.max(0, rawFinalGridSetpoint - C.DAY_HIGH_AC_LOAD_REDUCTION_W)
    : Number.POSITIVE_INFINITY;

const cappedGridSetpoint = Math.min(rawFinalGridSetpoint, adaptiveSupportCap, supportCap, dayHighAcLoadCap);

// ==========================
// GRID EXPORT GUARD
// ==========================
// A negative GRID CT reading means the Multi is inverting surplus from the external MPPT because
// DVCC does not let the battery absorb it. The battery becomes the compensating load: the DVCC
// limit is raised to cover PV + boost and the setpoint is floored at the minimum grid import.
// The boost integrates the CT error every EXPORT_GUARD_UPDATE_INTERVAL_MS until the CT sits at
// the minimum import; the guard releases itself once the boost is back at 0.
const exportGuardTargetW = supportMinGridImportW;
let exportGuard = { active: false, boostW: 0, since: "", lastAdjustTs: 0 };

if (exportGuardEnabled && hasGridPowerReading) {
    exportGuard = {
        active: Boolean(storedExportGuard.active),
        boostW: Math.max(0, Number(storedExportGuard.boostW) || 0),
        since: String(storedExportGuard.since || ""),
        lastAdjustTs: Number(storedExportGuard.lastAdjustTs) || 0
    };
    const exportGuardErrorW = exportGuardTargetW - gridPowerSignedW;

    if (!exportGuard.active && gridPowerSignedW < 0) {
        exportGuard = {
            active: true,
            boostW: clamp(Math.round(exportGuardErrorW), 0, EXPORT_GUARD_MAX_BOOST_W),
            since: now.toISOString(),
            lastAdjustTs: nowTs
        };
    }
    else if (exportGuard.active && nowTs - exportGuard.lastAdjustTs >= EXPORT_GUARD_UPDATE_INTERVAL_MS) {
        const offTarget = exportGuardErrorW > 0 || gridPowerSignedW > exportGuardTargetW + EXPORT_GUARD_RELEASE_DEADBAND_W;

        if (offTarget) {
            const stepW = clamp(exportGuardErrorW * EXPORT_GUARD_GAIN, -EXPORT_GUARD_MAX_STEP_W, EXPORT_GUARD_MAX_STEP_W);
            exportGuard.boostW = clamp(Math.round(exportGuard.boostW + stepW), 0, EXPORT_GUARD_MAX_BOOST_W);
        }

        exportGuard.lastAdjustTs = nowTs;

        if (exportGuard.boostW <= 0) {
            exportGuard = { active: false, boostW: exportGuard.boostW, since: "", lastAdjustTs: 0 };
        }
    }
}

const exportGuardSetpointFloorW = exportGuard.active ? exportGuardTargetW : 0;
const exportGuardChargeCurrent = exportGuard.active
    ? round1(clamp((storedPvChargerPowerW + exportGuard.boostW) / referenceVoltage, 0, C.MAX_CHARGE_CURRENT))
    : 0;

// ==========================
// FINAL OUTPUTS
// ==========================
const finalGridSetpoint = Math.max(cappedGridSetpoint, exportGuardSetpointFloorW);

// A lowered setpoint lowers the charge current by the same ratio.
const currentRatio = baseScheduleSetpoint > 0
    ? clamp(finalGridSetpoint / baseScheduleSetpoint, 0, 1)
    : 0;
const forceChargeAvailableW = Math.max(0, Math.round(finalGridSetpoint - storedAcLoadPowerW));
const forceChargeRatio = effectiveForceChargeGridW > 0
    ? clamp(forceChargeAvailableW / effectiveForceChargeGridW, 0, 1)
    : 0;
const scheduledChargeCurrent = manualDischargeEnabled
    ? 0
    : round1(baseChargeCurrent * (forceChargeAllowed ? forceChargeRatio : currentRatio));
// The export guard may only raise the DVCC limit, never lower a scheduled charge.
const finalChargeCurrent = Math.max(scheduledChargeCurrent, exportGuardChargeCurrent);
const currentChargingPowerW = Math.max(0, Math.round(Math.max(0, batteryVoltage) * finalChargeCurrent));

context.set("boostActive", boostActive);
context.set("activeWindow", windowName);
context.set("voltageLimitActive", voltageLimitActive);
context.set("gridSetpoint", finalGridSetpoint);
context.set("manualDischarge", manualDischarge);
context.set("exportGuard", exportGuard);

// ==========================
// TARIFF VIEW
// ==========================
const usedWh = hourBudget.usedWh || 0;
const acUsedWh = acLoadBudget.usedWh || 0;
const solarUsedWh = solarBudget.usedWh || 0;
const secondsLeftInHour = Math.max(1, 3600 - (now.getMinutes() * 60 + now.getSeconds()));
// The hourly budget is the season setpoint held for the whole hour.
const remainingWh = clamp(baseScheduleSetpoint - usedWh, 0, baseScheduleSetpoint);
const remainingAverageW = Math.round(remainingWh / (secondsLeftInHour / 3600));

// Today's import, energy still allowed today at the season plan, billable peaks.
const liveHourBillableWh = usedWh * getBillingFactor(hour);
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
    winterStart: formatMmdd(C.WINTER_START_MMDD),
    summerStart: formatMmdd(C.SUMMER_START_MMDD),
    nightBillingPct: C.TARIFF_NIGHT_BILLING_PCT,
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
    monthKey,
    monthTrackedDays: Object.keys(monthDayPeaks).length,
    monthTopPeaksWh,
    monthTop3AverageW,
    monthTier,
    monthFitsTier: monthTier <= seasonProfile.tier
};

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
    limitFlags.push(`MD:${C.MANUAL_DISCHARGE_MAX_CURRENT}A`);
}
else if (manualDischarge.active) {
    limitFlags.push(`MD-HOLD>${C.MANUAL_DISCHARGE_MAX_AC_LOAD_W}W`);
}

if (applyDayHighAcLoadReduction) {
    limitFlags.push(`AC-HIGH:-${C.DAY_HIGH_AC_LOAD_REDUCTION_W}W`);
}

if (gridSupportLowSunBlocked) {
    limitFlags.push(`GS-SUN<${gridSupportDisableNoSunBelowW}W`);
}

if (exportGuard.active) {
    limitFlags.push(`EXP:+${Math.round(exportGuard.boostW)}W@${Math.round(gridPowerSignedW)}W`);
}

if (adaptiveGridSupportActive) {
    limitFlags.push(`GS-A:${Math.round(adaptiveGridSupportW)}W`);
}

if (forceChargeAllowed) {
    limitFlags.push(`FC:${effectiveForceChargeGridW}W${forceChargeLimiterEnabled ? "(LIM)" : ""}`);
}
else if (forceChargeEnabled && forceChargeGridW > 0 && forceChargeLimiterEnabled) {
    limitFlags.push(`FC-ARMED:${forceChargeGridW}W`);
}

if (highVoltageGridSupportW > 0 && voltageLimitActive && !gridSupportLowSunBlocked) {
    limitFlags.push(`GS:${highVoltageGridSupportW}W(HV)`);
}

const charging = finalChargeCurrent > 0;
const statusFill = {
    "MANUAL-DISCHARGE": "red",
    "FORCE-CHARGE": charging ? "blue" : "yellow",
    NIGHT: charging ? "blue" : "yellow",
    MORNING: charging ? "green" : "yellow",
    EVENING: charging ? "green" : "yellow"
}[windowName] || "grey";

const estimatedDischargeA = manualDischargeEnabled && batteryVoltage > 0
    ? round1(Math.max(0, Math.round(storedAcLoadPowerW - finalGridSetpoint)) / batteryVoltage)
    : 0;
const stopText = `Stop<=${manualDischargeStopVoltage.toFixed(1)}V`;
const manualText = !manualDischarge.active
    ? ""
    : (manualDischargeEnabled
        ? ` | Grid>=${C.MANUAL_DISCHARGE_MIN_GRID_W}W | Dis ${estimatedDischargeA.toFixed(1)}A/${C.MANUAL_DISCHARGE_MAX_CURRENT}A | AC<=${C.MANUAL_DISCHARGE_MAX_AC_LOAD_W}W | ${stopText}`
        : ` | MD hold AC>${C.MANUAL_DISCHARGE_MAX_AC_LOAD_W}W | Using schedule | ${stopText}`);

node.status({
    fill: statusFill,
    shape: charging || finalGridSetpoint !== 0 ? "dot" : "ring",
    text: [
        windowName,
        `V=${batteryVoltage.toFixed(2)}V`,
        `${finalChargeCurrent}A`,
        `${finalGridSetpoint}W`,
        `Def ${effectiveConsumedAhDeficit.toFixed(1)}Ah`,
        `Grid ${gridRestoreAhNeeded.toFixed(1)}Ah${manualText}`,
        `Grid ${formatTime(new Date(hourBudget.startTs || nowTs))}-${formatTime(now)} ${Math.round(usedWh)}Wh`,
        `AC ${Math.round(acUsedWh)}Wh${hourBudget.fullHourCoverage ? ` | ${remainingAverageW}W left` : ""}`,
        `${seasonProfile.season === "WINTER" ? "WIN" : "SUM"} T${seasonProfile.tier} ${gridCurrentLimitA}A`,
        `Day ${(todayGridWh / 1000).toFixed(1)}kWh left ${(todayRemainingWh / 1000).toFixed(1)}kWh`,
        `Month T${monthTier}`
    ].join(" | ")
        + (storedPvChargerPowerW > 0 ? ` | PV ${Math.round(storedPvChargerPowerW)}W | Sol ${Math.round(solarUsedWh)}Wh` : "")
        + (solarForecast.valid ? ` | SOL ${solarForecast.condition} ${forecastRestoreAh.toFixed(1)}Ah` : "")
        + (limitFlags.length > 0 ? ` | ${limitFlags.join("+")}` : "")
});

// ==========================
// OUTPUT MESSAGES
// ==========================
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

if (tariffHistoryState.monthKey !== monthKey
    && nowTs - (Number(tariffHistoryState.requestedAt) || 0) >= TARIFF_HISTORY_RETRY_MS) {
    tariffHistoryRequestMsg = { topic: TARIFF_HISTORY_TOPIC, payload: buildEnergyHistoryCommand(monthKey) };
    context.set("tariffHistoryState", { monthKey: "", requestedAt: nowTs });
}

let notifyMsg = null;

if (finalGridSetpoint !== previousGridSetpoint) {
    const text = [windowName, `V=${batteryVoltage.toFixed(2)}V`, `Grid setpoint=${finalGridSetpoint}W`]
        .concat(limitFlags.length > 0 ? [`Limit=${limitFlags.join("+")}`] : [])
        .join(" | ");
    notifyMsg = {
        topic: "vrm-notification",
        payload: text,
        notification: { message: text, level: "info", timestamp: now.toISOString() }
    };
}

// The trace only feeds dashboards / debug: throttled for sensor updates, immediate for the rest.
const lastTraceTs = Number(context.get("lastTraceTs")) || 0;
const sendTrace = hourRolledOver
    || !SENSOR_TOPICS.includes(msg.topic)
    || nowTs - lastTraceTs >= TRACE_MIN_INTERVAL_MS
    || nowTs < lastTraceTs;
let traceMsg = null;

if (sendTrace) {
    context.set("lastTraceTs", nowTs);
    const budgetView = (budget, wh) => ({
        hourKey: budget.hourKey,
        usedWh: Math.round(wh),
        fullHourCoverage: budget.fullHourCoverage,
        startTs: budget.startTs || 0
    });
    traceMsg = {
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
                active: exportGuard.active,
                boostW: Math.round(exportGuard.boostW),
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
            finalGridSetpoint,
            baseChargeCurrent: round1(baseChargeCurrent),
            finalChargeCurrent: round1(finalChargeCurrent),
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
            hourBudget: budgetView(hourBudget, usedWh),
            acLoadBudget: budgetView(acLoadBudget, acUsedWh),
            solarBudget: budgetView(solarBudget, solarUsedWh),
            solarGenerationW: Math.round(solarGenerationW),
            hourRolledOver,
            hourlyLogMsg,
            limitFlags: limitFlags.slice()
        }
    };
}

return [
    { topic: "charge-current-limit", payload: finalChargeCurrent },
    { topic: "grid-setpoint", payload: finalGridSetpoint },
    sendGridCurrentLimit ? { topic: "ac-input-current-limit", payload: gridCurrentLimitA } : null,
    notifyMsg,
    hourlyLogMsg,
    traceMsg,
    tariffHistoryRequestMsg
];
