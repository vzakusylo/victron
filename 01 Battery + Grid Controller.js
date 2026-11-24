// ==========================
// BATTERY + GRID CONTROLLER
// ==========================
// Source of the function node "Battery + Grid Controller" in flows.json
// (sync: `node tools/flows.js sync`, every flows.json change bumps the tab label d#<n>).
//
// Outputs 1-3: DVCC, ESS and VE.Bus (existing Victron writers and rate gates).
// Output 4: GX alarm; 5-7: legacy, silent; 8: bookkeeping; 9: Automation log and alert digest.
// Output 10: read-only dashboard status.
//
// Inputs (msg.topic):
//   battery-voltage, battery-consumed-ah, grid-power (signed, negative = export), ac-load-power,
//   dc-power (informational), pv-charger-power, manual-discharge, manual-discharge-stop-voltage,
//   grid-control-tick (scheduled decisions); other topics are ignored.
//   d#231: translate the adopted GX input names (and the unnamed voltage node's default topic) to these topics.
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
// - Settings are read live from flow context: `highVoltageSettings` (Protection page) and
//   `controllerConstantsOverrides` (Constants page, every key of CONSTANT_SPECS).

// #include lib/grid/constants.js
// #include lib/grid/helpers.js
// #include lib/grid/control.js
// #include lib/grid/feedback.js
// #include lib/grid/dashboard.js

// #include lib/grid/readback.js
// #include lib/grid/output-stage.js
// #include lib/grid/bookkeeping-handoff.js

const now = new Date();
const nowTs = now.getTime();
// The input stage may return early; otherwise it binds C, the stored readings, and manual-discharge state.
// #include lib/grid/inputs.js

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

const legacy = gridBookkeepingSeed();
const { commands, alarm, logMessage, dashboard } = gridOutputStage(decision, hourKey, waiting, now, nowTs);
return [
    ...commands,
    alarm, null, null, null,
    { topic: msg.topic, tick: {
        nowTs, C, waiting, decision, legacy, sendGridCurrentLimit, highVoltageSettings,
        previousWindow, previousGridSetpoint, batteryVoltage, consumedAhDeficit, manualDischargeStopVoltage,
        storedGridPowerW, gridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedDcPowerW,
        hasDcPowerReading, storedPvChargerPowerW, solarGenerationW, accountingPower
    } },
    logMessage,
    dashboard
];
