// ==========================
// BATTERY + GRID CONTROLLER
// ==========================
// Source of the function node "Battery + Grid Controller" in flows.json
// (sync: `node tools/flows.js sync`, every flows.json change bumps the tab label d#<n>).
//
// Outputs 1-3: DVCC, ESS and VE.Bus (existing Victron writers and rate gates).
// Output 4: GX alarm; 5-7: legacy, silent; 8: bookkeeping; 9: Automation log and alert digest.
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
const CADENCE_TOPIC = "grid-control-tick";
const TARIFF_HISTORY_TOPIC = "tariff-history";
const SENSOR_KEYS = new Map([
    [BATTERY_TOPIC, "batteryVoltage"],
    [BATTERY_CONSUMED_AH_TOPIC, "batteryConsumedAh"],
    [GRID_TOPIC, "gridPowerW"],
    [AC_LOAD_TOPIC, "acLoadPowerW"],
    [DC_POWER_TOPIC, "dcPowerW"],
    [PV_CHARGER_TOPIC, "pvChargerPowerW"]
]);

// #include lib/grid/constants.js
// #include lib/grid/helpers.js
// #include lib/grid/control.js
// #include lib/grid/feedback.js

const feedbackChannels = [
    { name: 'DVCC', topic: 'charge-current-limit', path: '/Settings/SystemSetup/MaxChargeCurrent', gap: 10100, tolerance: 0.01 },
    { name: 'ESS', topic: 'grid-setpoint', path: '/Settings/CGwacs/AcPowerSetPoint', gap: 10100, tolerance: 0 },
    { name: 'VE.Bus', topic: 'ac-input-current-limit', path: '/Ac/In/1/CurrentLimit', gap: 0, tolerance: 0.01 }
];

async function readGridOutput(channel) {
    const address = env.get('DBUS_SYSTEM_BUS_ADDRESS');
    const bus = address?.startsWith('tcp:')
        ? dbus.createClient({ busAddress: address, authMethods: ['ANONYMOUS'] }) : dbus.systemBus();
    const connection = bus.connection;
    let timer;
    const disconnected = new Promise((_, reject) => {
        connection.on('error', reject);
        connection.on('end', () => reject(new Error('D-Bus disconnected')));
        timer = setTimeout(() => reject(new Error('D-Bus read-back timed out')), 3000);
    });
    const read = (destination, path) => new Promise((resolve, reject) => {
        bus.invoke({ destination, path, interface: 'com.victronenergy.BusItem', member: 'GetValue' },
            (error, value) => error ? reject(new Error(String(error))) : resolve(value?.[1]?.[0]));
    });
    try {
        const value = await Promise.race([disconnected, (async () => {
            if (channel.name !== 'VE.Bus') return read('com.victronenergy.settings', channel.path);
            // Match the exact instance configured on the existing VE.Bus writer.
            const names = await new Promise((resolve, reject) => bus.listNames((error, result) =>
                error ? reject(new Error(String(error))) : resolve(result)));
            const matches = await Promise.allSettled(names.filter(name => name.startsWith('com.victronenergy.vebus.'))
                .map(async name => await read(name, '/DeviceInstance') === 276 ? name : undefined));
            const destinations = matches.filter(m => m.status === 'fulfilled' && m.value);
            if (destinations.length !== 1) throw new Error('VE.Bus instance 276 unavailable or ambiguous');
            return read(destinations[0].value, channel.path);
        })()]);
        if (!Number.isFinite(value)) throw new Error('D-Bus returned no numeric value');
        return { value };
    } finally {
        clearTimeout(timer);
        connection.stream.end();
    }
}

const now = new Date();
const nowTs = now.getTime();
const sensorKey = SENSOR_KEYS.get(msg.topic);
if (sensorKey) {
    const raw = msg.payload;
    if ((typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) || !Number.isFinite(Number(raw))) return null;
    const value = Number(raw);
    context.set(sensorKey, msg.topic === BATTERY_CONSUMED_AH_TOPIC ? Math.abs(value)
        : msg.topic === AC_LOAD_TOPIC || msg.topic === PV_CHARGER_TOPIC ? Math.max(0, value) : value);
    const arrivals = context.get("gridInputArrivals") || {};
    arrivals[sensorKey] = nowTs;
    context.set("gridInputArrivals", arrivals);
    const lastGrid = context.get("gridLastDecisionPowerW");
    if (msg.topic !== GRID_TOPIC || !Number.isFinite(lastGrid) || Math.abs(value - lastGrid) <= 1000) return null;
} else if (msg.topic === TARIFF_HISTORY_TOPIC) {
    if (typeof msg.payload === "string") context.set("gridPendingTariffHistory", msg.payload);
    return null;
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

// Retry until bookkeeping acknowledges the handoff.
let legacy;
if (flow.get("gridBookkeepingSeeded") !== true) {
    legacy = Object.fromEntries(["hourBudget", "acLoadBudget", "solarBudget", "hourPeak", "tariffDay", "tariffMonth", "tariffHistoryState", "lastTraceTs"]
        .map(key => [key, context.get(key)]).filter(([, value]) => value !== undefined));
}

const history = context.get("gridPendingTariffHistory");
if (history !== undefined) context.set("gridPendingTariffHistory", undefined);

// Use the same monotonic clock as Node-RED's dropping rate gates, not wall time.
const feedbackNow = Number(gridClock.hrtime.bigint() / 1000000n);
const storedFeedback = context.get('gridWriteFeedback') || [];
const desired = [decision?.finalChargeCurrent, decision?.finalGridSetpoint, decision?.gridCurrentLimitA];
const commands = [];
const faults = [];
const feedback = feedbackChannels.map((channel, i) => {
    const previous = storedFeedback[i];
    const result = advanceGridFeedback(previous, {
        now: feedbackNow, value: desired[i], reading: previous?.reading,
        gap: channel.gap, tolerance: channel.tolerance, refresh: i < 2 || previous?.hour !== hourKey
    });
    const state = result.state;
    delete state.reading;
    commands[i] = result.write === undefined ? null : { topic: channel.topic, payload: result.write };
    if (commands[i]) state.hour = hourKey;
    if (state.fault) faults.push(`${channel.name}: ${state.fault}`);
    if (result.read) {
        const finish = reading => {
            const current = context.get('gridWriteFeedback')?.[i];
            if (current?.phase === 'reading' && current.sent === state.sent) current.reading = reading;
        };
        readGridOutput(channel).then(finish, error => finish({ error: error.message || String(error) }));
    }
    return state;
});
context.set('gridWriteFeedback', feedback);
const alarmText = faults.length ? `grid not following setpoint: ${faults.join('; ')}` : '';
context.set('gridFeedbackAlarm', { text: alarmText });
if (alarmText) node.status({ fill: 'red', shape: 'dot', text: alarmText });
const notice = gridFeedbackNotice(context.get('gridFeedbackNotice'), faults, nowTs);
context.set('gridFeedbackNotice', notice.state);
const alarm = notice.text ? { notification: { title: 'Grid control', type: 'alarm', message: notice.text }, payload: notice.text } : null;
const event = notice.text ? { t: nowTs, kind: 'fail', rule: 'grid_feedback', live: true, text: notice.text } : null;
const day = getHourKey(now).slice(0, 10);
return [
    ...commands,
    alarm, null, null, null,
    { topic: history === undefined ? msg.topic : TARIFF_HISTORY_TOPIC,
      payload: history === undefined ? msg.payload : history, tick: {
        nowTs, C, waiting, decision, legacy, sendGridCurrentLimit, highVoltageSettings,
        previousWindow, previousGridSetpoint, batteryVoltage, consumedAhDeficit, manualDischargeStopVoltage,
        storedGridPowerW, gridPowerW, gridPowerSignedW, storedAcLoadPowerW, storedDcPowerW,
        hasDcPowerReading, storedPvChargerPowerW, solarGenerationW, accountingPower
    } },
    event ? { topic: 'log', filename: `/data/home/nodered/grid-control-logs/automations/${day}.jsonl`,
        payload: JSON.stringify(event) + '\n', event } : null
];
