// #libs [{"var":"fs","module":"fs"}]
// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `34 Heat pump state.js` and the embedded `func` for "Heat pump state"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Collector for the Tuya heat pump, its two helper relays and the SA1 power meter
//   (stage 1 of moving the heat pump control from the Tuya cloud to the GX).
// - Merges partial DP updates from the local Tuya connection into one state
//   object, decodes the known heat pump DPs and feeds the "Heat Pump" page.
// - Sends nothing itself. Commands from the page (curve shift, bypass) go through
//   "Heat pump command" (37); this node only reads.
// Input:
// - msg.topic = 'hp' | 'valve' | 'bypass' | 'meter' (set by the change node in front)
//   | 'acc' | 'plate' (battery sensors: local from 46, cloud fallback from 44)
// - data msg  : msg.payload = { data: { dps: { ... } }, deviceId, deviceName }
// - status msg: msg.payload = { state: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' }
// Output (3):
// - output 1 -> msg.payload = page model for the "Heat pump page" ui_template
// - output 2, 3 -> not used since d#134 (the 24 h ui_charts were removed; the history page has
//   the same data by day)
// State:
// - flow.heatPump = { hp: {...}, valve: {...}, bypass: {...}, meter: {..., reading} }
//   meter.reading = decoded { powerW, voltageV, currentA, energyKwh, source } — the
//   recorder (36) stores powerW as column `pw`.
// Change notes:
// 1. Initial version (d#112): read-only page, DP map from the Tuya cloud model
//    of product 5oc9wmac3bbidekc (controller PW58280, Powerworld/Michl).
// 2. Compressor load (d#114): summary.compressorPowerW ≈ compressor current (DP 112)
//    × DC bus voltage (DP 114, fallback 230 V). The power is an ESTIMATE (no power DP
//    in the model; power factor and drive losses are ignored) — trends only.
// 3. Compressor load from frequency AND current (d#116): rated maxima of this
//    compressor are 91 Hz and 8 A. freqPct = Hz / 91, currentPct = A / 8,
//    compressorLoadPct = the higher of the two (the limit the compressor is closest to),
//    each clamped to 0–100. DP 143 (Freq max setting) is no longer used for the load.
// 4. Heating curve (d#118): model.curveChart = built-in weather curve (P22 on):
//    heating set point = 20 + (P24 / 10) × (P23 − outdoor), clamped 20–60 °C
//    (P23 = DP 133 ambient point, P24 = DP 134 coefficient; formula from the PW58280
//    manual notes in docs/heat-pump.md — compare `target` with the reported DP 125).
//    Includes ready-to-draw SVG coordinates for the page (outdoor −25…+25 °C) and
//    the current point (outdoor, curve target, supply).
// 5. Power meter + controls (d#121): role `meter` = "SA1 Wi-Fi Smart Power Transformer"
//    (measures the whole heat pump). Decoded by meterReading(): Tuya plug DPs 18/19/20
//    (mA, W×10, V×10) or energy-meter DP 6 `phase_a` (base64: V×10 2 B, mA 3 B, W 3 B).
//    summary.power* + output 3 (24 h power chart: meter W and compressor estimate W).
//    model.curveChart.scale lets the page draw a preview line for the "warmer / colder"
//    slider; model.controls tells the page which commands are possible.
// 7. Nameplate (d#133, PW030-DKZLRS-A): power ≈ DP 112 current × 220 W/A (was × DC bus
//    voltage, ~1.7× too high); load = that power / 2130 W (nameplate max input); max frequency
//    90 Hz. summary.resource = compressor resource counters from "Compressor resource" (45).
// 6. Cloud sensors (d#132): roles `acc` (Accumulator tank temp) and `plate` (Exchange plate),
//    battery Wi-Fi sensors read from the Tuya cloud by "Heat pump cloud sensors" (44), dps
//    { temp, hum, bat }. summary.accTemp / plateTemp (fresh ≤ 10 min) and two more series on
//    the 24 h temperature chart.
// 9. Battery sensors local (d#134): readings from 46 (local, msg.payload.source 'local', data.t =
//    reading time) or 44 (cloud fallback). Fresh for 24 h; device chip shows the source.
// 8. Boiler curve (d#134): model.dhwChart = tank target by outdoor temperature (curve of the
//    DHW controller, read from flow.dhwView written by 40), start line target − hyst, tank now,
//    controller state. The page shows heating on the left and the boiler on the right.
// 11. d#142: boiler curve on the pump's own curve. dhwChart: wanted supply line (tank target +
//    supplyAdd, capped in the cold), boiler P23 now, the controller's P23 / goal / curve supply /
//    protection; during a cycle the heating chart shows the stored heating curve and the P23 slider
//    is locked (controls.curve false).
// 10. DHW controller panel (d#138): dhwChart also carries cfg (curve + settings, for the editor on
//    the page), master (local control ON / OFF) and lag.
// 12. d#161: boiler curve as a straight line between two points (owner: 1 °C -> 50, -15 °C -> 40;
//    only the two ends are set, the rest is read-only like the heating curve): chart lines without
//    the 0.5 °C rounding, dhwChart.table at -20…15 °C, dhwChart.formula, svg yMin / yMax / outMin /
//    outMax for the edit preview on the page.
// d#233: curveChart.outdoor is the defrost-held 10-min sensor average from 40 (withdraws d#195). Raw DP 103
//    and the fixed pump set (DP 125) remain visible; no current curve point without a fresh average. Show the
//    stored owner curve, current pump coefficients if different, and the two-coefficient Apply status.
// 14. d#210: battery sensor temperature expires independently of other readings (TGX7-LOCAL-AGE).
// ==========================

// NR9: device decoding and dashboard model helpers are included at build time.
const ROLES = ['hp', 'valve', 'bypass', 'meter', 'acc', 'plate'];

const ROLE_LABELS = {
    hp: 'Heat pump',
    valve: 'Boiler valve relay (ON = DHW)',
    bypass: 'Heating exchange bypass (ON = bypass)',
    meter: 'Power meter SA1',
    acc: 'Accumulator tank temp',
    plate: 'Exchange plate temp'
};
// battery sensors (d#134: read locally by 46 when they wake, cloud only as a fallback by 44) report
// only on a change of 0.3 °C or on their periodic report (Exchange plate every 40 min; the
// accumulator sensor was silent for 8 h at a steady 25.5 °C), so they count as fresh for 24 h.
// msg.payload.data.t = time of the reading; an older reading than the one shown is ignored.
const CLOUD_ROLES = ['acc', 'plate'];
const CLOUD_STALE_MS = 24 * 3600 * 1000;

// #include lib/heat-pump/state-devices.js

// #include lib/heat-pump/heat-curve.js

// #include lib/heat-pump/state-heating-curve.js

// #include lib/heat-pump/state-model.js

// #include lib/heat-pump/state-dhw-view.js

// #include lib/heat-pump/write-attribution.js
// #include lib/heat-pump/curve-change-log.js

// ---------------------------------------------------------------------------
const now = Date.now();
const statusOnly = typeof msg.topic === 'string' && msg.topic.endsWith('-status');
const role = statusOnly ? msg.topic.slice(0, -7) : msg.topic;
if (!ROLES.includes(role)) {
    node.warn('Heat pump state: unknown msg.topic ' + role);
    return null;
}

const st = flow.get('heatPump') || {};
ROLES.forEach((r) => { if (!st[r]) st[r] = emptyDevice(); });
const dev = st[role];
const p = msg.payload || {};

if (typeof p.state === 'string' && !p.data) {
    dev.state = p.state;
    dev.lastState = now;
} else if (!statusOnly && p.data && typeof p.data === 'object') {
    const dps = p.data.dps || {};
    // reading time only for the battery sensors (46 / 44, ms). The Tuya nodes also send data.t,
    // in SECONDS: using it made hp / valve / bypass look stale (d#135 bug, fixed in d#138).
    const at = CLOUD_ROLES.includes(role) && Number.isFinite(p.data.t) && p.data.t > 1e12 && p.data.t <= now ? p.data.t : now;
    if (CLOUD_ROLES.includes(role) && dev.lastData && at < dev.lastData && dev.state === 'CONNECTED') return null;
    if (role === 'hp') hpAttribution.observe(dps, dev.dps, at, hpCurveLog.append);
    const observed = dev.dpObservedAt || (dev.dpObservedAt = {});
    Object.keys(dps).forEach((k) => {
        dev.dps[k] = dps[k];
        observed[k] = at;
    });
    dev.lastData = at;
    dev.state = 'CONNECTED';
    if (CLOUD_ROLES.includes(role)) {
        const source = p.source || 'cloud';
        // A partial wake cannot make a reading from the previous source current.
        if (dev.source !== source || Object.hasOwn(dps, 'temp')) {
            dev.lastTempAt = dps.temp != null && num(dps.temp) !== null ? at : 0;
        }
        dev.source = source;
    }
    if (role === 'meter') dev.reading = meterReading(dev);
} else {
    return null;
}

flow.set('heatPump', st);
// Control reads the raw state above immediately; only the derived model waits.
const pending = context.get('modelPending');
context.set('modelPending', role);
if (pending) return null;
setTimeout(() => {
    const lastRole = context.get('modelPending');
    context.set('modelPending', false);
    const latest = flow.get('heatPump');
    const model = buildModel(latest, Date.now());
    flow.set('heatPumpModel', model);
    const statusText = model.summary.supply !== null
        ? `out ${model.summary.supply}° tank ${model.summary.tank}° ${model.summary.compressorHz} Hz`
        : `${lastRole}: ${latest[lastRole].state}`;
    node.status({ fill: model.devices.every((x) => x.state === 'CONNECTED') ? 'green' : 'yellow', shape: 'dot', text: statusText });
    node.send([{ payload: model }, null, null]);
}, 5000);
return null;
