// Grid bookkeeping. Receives the input-time snapshot from 01, after control outputs
// have been queued. Never feeds control state back into the decision loop.
// Outputs: notification, hourly energy (CSV + daily summary), trace, history request.
// #include lib/grid/constants.js
// #include lib/grid/helpers.js

const TARIFF_HISTORY_TOPIC = "tariff-history";
const TARIFF_HISTORY_RETRY_MS = 60000;
const SENSOR_TOPICS = ["battery-voltage", "battery-consumed-ah", "grid-power", "ac-load-power", "dc-power", "pv-charger-power"];
const TRACE_MIN_INTERVAL_MS = 5000;
const ENERGY_LOG_DIR = "/data/home/nodered/grid-control-logs";

if (!msg.tick) { node.error("Grid bookkeeping requires a controller tick", msg); return null; }
const { nowTs, C, waiting, decision, legacy, sendGridCurrentLimit, highVoltageSettings,
    previousWindow, previousGridSetpoint, batteryVoltage, consumedAhDeficit, manualDischargeStopVoltage,
    storedGridPowerW, gridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedDcPowerW,
    hasDcPowerReading, storedPvChargerPowerW, solarGenerationW } = msg.tick;
const now = new Date(nowTs);
const hour = now.getHours();
for (const [key, value] of Object.entries(legacy || {})) {
    if (context.get(key) === undefined) context.set(key, value);
}
const acknowledgeSeed = () => {
    if (legacy && flow.get("gridBookkeepingSeeded") !== true) flow.set("gridBookkeepingSeeded", true);
};
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
    const closedBillableWh = prevHourGridWh * getBillingFactor(closedHourOfDay, C);
    const closedHourDate = new Date(
        Number(prevHourKey.substring(0, 4)),
        Number(prevHourKey.substring(5, 7)) - 1,
        Number(prevHourKey.substring(8, 10)),
        closedHourOfDay
    );
    const closedProfile = buildSeasonProfile(getTariffSeason(closedHourDate, C).winter, C);

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
    const history = parseEnergyHistory(msg.payload, monthKey, C);
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

if (hourPeak.hourKey !== hourBudget.hourKey) {
    hourPeak = { hourKey: hourBudget.hourKey, peakW: 0 };
}

hourPeak.peakW = Math.round(Math.max(Number(hourPeak.peakW) || 0, storedGridPowerW, gridPowerW));
context.set("hourPeak", hourPeak);
context.set("hourBudget", hourBudget);
context.set("acLoadBudget", acLoadBudget);
context.set("solarBudget", solarBudget);

if (waiting) {
    node.status({ fill: "grey", shape: "ring", text: waiting });
    acknowledgeSeed();
    return null;
}
const {
    finalChargeCurrent, finalGridSetpoint, gridCurrentLimitA, boostActive, windowName,
    voltageLimitActive, manualDischarge, exportGuard, forceChargeLimiterActive,
    baseScheduleSetpoint, summerProfile, winterProfile, seasonProfile, tariffSeason, solarForecast,
    limitFlags, effectiveConsumedAhDeficit, gridRestoreAhNeeded, manualDischargeEnabled,
    gridSupportMode, gridSupportDisableNoSun, gridSupportDisableNoSunBelowW, gridSupportLowSunBlocked,
    adaptiveGridSupportActive, adaptiveGridSupportW, plannedGridSupportW, liveSolarAssistW,
    remainingForecastWh, remainingForecastAh, supportWindowRemainingHours, batteryRemainingAh,
    usableStoredSupportAh, predictedSupportAh, supportMinGridImportW, exportGuardEnabled,
    exportGuardTargetW, exportGuardSetpointFloorW, exportGuardChargeCurrent, forecastRestoreAh,
    remainingNightHours, remainingMorningHours, remainingMorningCapacityAh, requestedGridSetpoint,
    voltageLimitedSetpoint, baseChargeCurrent, currentChargingPowerW, forceChargeEnabled,
    forceChargeGridW, effectiveForceChargeGridW
} = decision;

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
const liveHourBillableWh = usedWh * getBillingFactor(hour, C);
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

acknowledgeSeed();
return [notifyMsg, hourlyLogMsg, traceMsg, tariffHistoryRequestMsg];
