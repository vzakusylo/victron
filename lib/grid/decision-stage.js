//! Hour tracking, decision inputs and controller state for node 01.
// The VE.Bus limit is reasserted at each real hour boundary, independent of accounting.
const lastHourKey = context.get("gridControlHourKey") ?? context.get("hourBudget")?.hourKey;
const hourKey = getHourKey(now);
const hourRolledOver = Boolean(lastHourKey) && lastHourKey !== hourKey;
context.set("gridControlHourKey", hourKey);

const waiting = !Number.isFinite(batteryVoltage) ? "WAITING FOR BATTERY VOLTAGE"
    : !Number.isFinite(consumedAhDeficit) && !manualDischarge.active ? "WAITING FOR BMS CONSUMED AH" : "";
let decision = null;
let sendGridCurrentLimit = false;
if (!waiting) {
    decision = decideGrid({
        now, C, highVoltageSettings, batteryVoltage, consumedAhDeficit, hasGridPowerReading,
        storedGridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedPvChargerPowerW,
        solarGenerationW, manualDischargeStopVoltage, previousGridSetpoint, storedExportGuard,
        solarForecastToday: flow.get("solarForecastToday"), solarForecastAdjusted: flow.get("solarForecastAdjusted")
    }, { manualDischarge, voltageLimitActive, forceChargeLimiterActive });
    sendGridCurrentLimit = Number(context.get("gridCurrentLimitA")) !== decision.gridCurrentLimitA || hourRolledOver;
    context.set("gridCurrentLimitA", decision.gridCurrentLimitA);
    if (hasGridPowerReading) context.set("gridLastDecisionPowerW", gridPowerSignedW);
    context.set("forceChargeLimiterActive", decision.forceChargeLimiterActive);
    context.set("boostActive", decision.boostActive);
    context.set("activeWindow", decision.windowName);
    context.set("voltageLimitActive", decision.voltageLimitActive);
    context.set("gridSetpoint", decision.finalGridSetpoint);
    context.set("manualDischarge", decision.manualDischarge);
    context.set("exportGuard", decision.exportGuard);
    node.status({ fill: "green", shape: "dot", text:
        `${decision.windowName} ${decision.finalGridSetpoint} W · ${decision.finalChargeCurrent} A DVCC · ${decision.gridCurrentLimitA} A AC` });
} else {
    node.status({ fill: "grey", shape: "ring", text: waiting });
}
