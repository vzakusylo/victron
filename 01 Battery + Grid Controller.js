// ==========================
// BATTERY + GRID CONTROLLER
// ==========================
// Source of the function node "Battery + Grid Controller" in flows.json
// (sync: `node tools/flows.js sync`, every flows.json change bumps the tab label d#<n>).
//
// Outputs 1-3: DVCC, ESS and VE.Bus. Outputs 4-7 stay silent because the deploy planner
// cannot remove existing wires. Output 8 hands a tick snapshot to Grid bookkeeping.
//
// Inputs (msg.topic):
//   battery-voltage, battery-consumed-ah, grid-power (signed, negative = export), ac-load-power,
//   dc-power (informational), pv-charger-power, manual-discharge, manual-discharge-stop-voltage,
//   tariff-history (reply from the history reader); any other topic only recalculates.
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

// #include lib/grid/constants.js
// #include lib/grid/helpers.js
// #include lib/grid/control.js

const now = new Date();
const nowTs = now.getTime();
const C = getConstants(flow.get("controllerConstantsOverrides"));
const highVoltageSettings = sanitizeHighVoltageSettings(flow.get("highVoltageSettings")) || DEFAULT_HIGH_VOLTAGE_SETTINGS;

const previousWindow = context.get("activeWindow") || "none";
let batteryVoltage = Number(context.get("batteryVoltage"));
const rawStoredConsumedAh = context.get("batteryConsumedAh");
let consumedAhDeficit = Number.isFinite(Number(rawStoredConsumedAh)) ? Math.max(0, Number(rawStoredConsumedAh)) : Number.NaN;
// Signed CT reading (negative = export); the clamped value feeds import-Wh tracking and floors.
const storedGrid = readStoredNumber(context.get("gridPowerW"));
let hasGridPowerReading = storedGrid.has;
const storedGridPowerW = Math.max(0, storedGrid.value);
let gridPowerW = storedGridPowerW;
let gridPowerSignedW = storedGrid.value;
const storedAcLoadPowerW = Math.max(0, readStoredNumber(context.get("acLoadPowerW")).value);
const storedDc = readStoredNumber(context.get("dcPowerW"));
const storedDcPowerW = storedDc.value;
const hasDcPowerReading = storedDc.has;
const storedPvChargerPowerW = Math.max(0, readStoredNumber(context.get("pvChargerPowerW")).value);
// Solar generation is the PV charger power only; DC bus power stays informational.
const solarGenerationW = storedPvChargerPowerW;
const rawStoredManualDischargeStopVoltage = context.get("manualDischargeStopVoltage");
let manualDischargeStopVoltage = Number.isFinite(Number(rawStoredManualDischargeStopVoltage))
    ? Number(rawStoredManualDischargeStopVoltage)
    : C.MANUAL_DISCHARGE_STOP_VOLTAGE;
let manualDischarge = context.get("manualDischarge") || { active: false, startedAt: "", source: "" };
const voltageLimitActive = context.get("voltageLimitActive") || false;
const forceChargeLimiterActive = context.get("forceChargeLimiterActive") || false;
const previousGridSetpoint = Number(context.get("gridSetpoint"));
const storedExportGuard = context.get("exportGuard") || {};

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

// Retry until bookkeeping acknowledges the handoff.
let legacy;
if (flow.get("gridBookkeepingSeeded") !== true) {
    legacy = Object.fromEntries(["hourBudget", "acLoadBudget", "solarBudget", "hourPeak", "tariffDay", "tariffMonth", "tariffHistoryState", "lastTraceTs"]
        .map(key => [key, context.get(key)]).filter(([, value]) => value !== undefined));
}

return [
    decision ? { topic: "charge-current-limit", payload: decision.finalChargeCurrent } : null,
    decision ? { topic: "grid-setpoint", payload: decision.finalGridSetpoint } : null,
    sendGridCurrentLimit ? { topic: "ac-input-current-limit", payload: decision.gridCurrentLimitA } : null,
    null, null, null, null,
    { topic: msg.topic, payload: msg.payload, tick: {
        nowTs, C, waiting, decision, legacy, sendGridCurrentLimit, highVoltageSettings,
        previousWindow, previousGridSetpoint, batteryVoltage, consumedAhDeficit, manualDischargeStopVoltage,
        storedGridPowerW, gridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedDcPowerW,
        hasDcPowerReading, storedPvChargerPowerW, solarGenerationW
    } }
];
