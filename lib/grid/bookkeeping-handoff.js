//! Tick and legacy context handoff from controller 01 to the bookkeeping node.
function gridBookkeepingSeed() {
    // Retry until bookkeeping acknowledges the handoff.
    if (flow.get("gridBookkeepingSeeded") !== true) {
        return Object.fromEntries(["hourBudget", "acLoadBudget", "solarBudget", "hourPeak", "tariffDay", "tariffMonth", "tariffHistoryState", "lastTraceTs"]
            .map(key => [key, context.get(key)]).filter(([, value]) => value !== undefined));
    }
}

// Call after the decision stage and legacy seed are bound in node 01's scope.
function gridBookkeepingTick() {
    return { topic: msg.topic, tick: {
        nowTs, C, waiting, decision, legacy, sendGridCurrentLimit, highVoltageSettings,
        previousWindow, previousGridSetpoint, batteryVoltage, consumedAhDeficit, manualDischargeStopVoltage,
        storedGridPowerW, gridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedDcPowerW,
        hasDcPowerReading, storedPvChargerPowerW, solarGenerationW, accountingPower
    } };
}
