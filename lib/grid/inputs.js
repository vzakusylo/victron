//! Message admission, configuration and stored input state for controller 01.
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
const CADENCE_TOPIC = "grid-control-tick";
const SENSOR_KEYS = new Map([
    [BATTERY_TOPIC, "batteryVoltage"],
    [BATTERY_CONSUMED_AH_TOPIC, "batteryConsumedAh"],
    [GRID_TOPIC, "gridPowerW"],
    [AC_LOAD_TOPIC, "acLoadPowerW"],
    [DC_POWER_TOPIC, "dcPowerW"],
    [PV_CHARGER_TOPIC, "pvChargerPowerW"]
]);
const VICTRON_INPUT_TOPICS = new Map([
    ["SmartShunt IP65 300A - Battery voltage (V)", BATTERY_TOPIC],
    ["Battery SmartShunt consumed Ah", BATTERY_CONSUMED_AH_TOPIC],
    ["GRID CT import power", GRID_TOPIC],
    ["AC Loads power", AC_LOAD_TOPIC],
    ["DC System Power", DC_POWER_TOPIC],
    ["PV Charger Power", PV_CHARGER_TOPIC]
]);

// Admit a decision tick and capture its inputs.
const sensorTopic = VICTRON_INPUT_TOPICS.get(msg.topic) ?? msg.topic;
const sensorKey = SENSOR_KEYS.get(sensorTopic);
if (sensorKey) {
    const raw = msg.payload;
    if ((typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) || !Number.isFinite(Number(raw))) return null;
    msg.topic = sensorTopic;
    const value = Number(raw);
    context.set(sensorKey, msg.topic === BATTERY_CONSUMED_AH_TOPIC ? Math.abs(value)
        : msg.topic === AC_LOAD_TOPIC || msg.topic === PV_CHARGER_TOPIC ? Math.max(0, value) : value);
    const arrivals = context.get("gridInputArrivals") || {};
    arrivals[sensorKey] = nowTs;
    context.set("gridInputArrivals", arrivals);
    const lastGrid = context.get("gridLastDecisionPowerW");
    if (msg.topic !== GRID_TOPIC || !Number.isFinite(lastGrid) || Math.abs(value - lastGrid) <= 1000) return null;
} else if (msg.topic !== CADENCE_TOPIC && msg.topic !== MANUAL_DISCHARGE_TOPIC &&
        msg.topic !== MANUAL_DISCHARGE_STOP_VOLTAGE_TOPIC) {
    return null;
}
const C = getConstants(flow.get("controllerConstantsOverrides"));
const highVoltageSettings = sanitizeHighVoltageSettings(flow.get("highVoltageSettings")) || DEFAULT_HIGH_VOLTAGE_SETTINGS;

const previousWindow = context.get("activeWindow") || "none";
const batteryVoltage = Number(context.get("batteryVoltage"));
const rawStoredConsumedAh = context.get("batteryConsumedAh");
const consumedAhDeficit = Number.isFinite(Number(rawStoredConsumedAh)) ? Math.max(0, Number(rawStoredConsumedAh)) : Number.NaN;
// Signed CT reading (negative = export); the clamped value feeds import-Wh tracking and floors.
const storedGrid = readStoredNumber(context.get("gridPowerW"));
const hasGridPowerReading = storedGrid.has;
const storedGridPowerW = Math.max(0, storedGrid.value);
const gridPowerW = storedGridPowerW;
const gridPowerSignedW = storedGrid.value;
const storedAcLoadPowerW = Math.max(0, readStoredNumber(context.get("acLoadPowerW")).value);
const storedDc = readStoredNumber(context.get("dcPowerW"));
const storedDcPowerW = storedDc.value;
const hasDcPowerReading = storedDc.has;
const storedPvChargerPowerW = Math.max(0, readStoredNumber(context.get("pvChargerPowerW")).value);
// Solar generation is the PV charger power only; DC bus power stays informational.
const solarGenerationW = storedPvChargerPowerW;
const accountingPower = context.get("gridAccountingPower") || (context.get("hourBudget")
    ? { gridW: storedGridPowerW, acW: storedAcLoadPowerW, solarW: solarGenerationW }
    : { gridW: 0, acW: 0, solarW: 0 });
context.set("gridAccountingPower", { gridW: storedGridPowerW, acW: storedAcLoadPowerW, solarW: solarGenerationW });
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

if (msg.topic === MANUAL_DISCHARGE_TOPIC) {
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
