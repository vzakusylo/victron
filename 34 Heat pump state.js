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
//   | 'acc' | 'plate' (cloud sensors, from 44)
// - data msg  : msg.payload = { data: { dps: { ... } }, deviceId, deviceName }
// - status msg: msg.payload = { state: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' }
// Output (3):
// - output 1 -> msg.payload = page model for the "Heat pump page" ui_template
// - output 2 -> chart points for "Heat pump temperatures" (max once per minute)
// - output 3 -> chart points for "Heat pump power" (max once per minute)
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
// 6. Cloud sensors (d#132): roles `acc` (Accumulator tank temp) and `plate` (Exchange plate),
//    battery Wi-Fi sensors read from the Tuya cloud by "Heat pump cloud sensors" (44), dps
//    { temp, hum, bat }. summary.accTemp / plateTemp (fresh ≤ 10 min) and two more series on
//    the 24 h temperature chart.
// ==========================

const ROLES = ['hp', 'valve', 'bypass', 'meter', 'acc', 'plate'];

const ROLE_LABELS = {
    hp: 'Heat pump',
    valve: 'Boiler valve relay (ON = DHW)',
    bypass: 'Heating exchange bypass (ON = bypass)',
    meter: 'Power meter SA1',
    acc: 'Accumulator tank temp (cloud)',
    plate: 'Exchange plate temp (cloud)'
};
// cloud sensors (44) arrive every 2 min and report only every few minutes
const CLOUD_ROLES = ['acc', 'plate'];
const CLOUD_STALE_MS = 10 * 60 * 1000;

// Heat pump DP map (code, label, unit)
const HP_DPS = {
    '1': ['switch', 'Power', ''],
    '2': ['mode', 'Mode', ''],
    '5': ['work_mode', 'Work mode', ''],
    '15': ['fault', 'Faults', ''],
    '101': ['intemp', 'Water in (return)', '°C'],
    '102': ['outtemp', 'Water out (supply)', '°C'],
    '103': ['whjtemp', 'Outdoor', '°C'],
    '104': ['cmptemp', 'Discharge', '°C'],
    '105': ['hqtemp', 'Suction', '°C'],
    '106': ['ptemp', 'Outdoor coil', '°C'],
    '107': ['cptemp', 'Cooling coil', '°C'],
    '108': ['wttemp', 'DHW tank', '°C'],
    '109': ['step_run', 'Main EEV', 'P'],
    '111': ['stepb_run', 'EVI EEV', 'P'],
    '112': ['cmp_cur', 'Compressor current', 'A'],
    '113': ['sink_temp', 'Heatsink', '°C'],
    '114': ['dc_bus_voltage', 'DC bus', 'V'],
    '115': ['cmp_act_frep', 'Compressor', 'Hz'],
    '116': ['dc_fan_speed', 'Fan 1', 'rpm'],
    '117': ['dc_fan2_speed', 'Fan 2', 'rpm'],
    '121': ['aircond_temp_diff', 'Heating hysteresis', '°C'],
    '122': ['wth_temp_diff', 'DHW hysteresis', '°C'],
    '123': ['wth_stemp', 'DHW setpoint', '°C'],
    '124': ['acc_stemp', 'Cooling setpoint', '°C'],
    '125': ['ach_stemp', 'Heating setpoint', '°C'],
    '126': ['water_temp_compenst', 'Water temp compensation', '°C'],
    '132': ['heat_target_temp_auto_adj', 'Curve P22 enabled', ''],
    '133': ['heat_compst_temp_point_hj', 'Curve P23 ambient point', '°C'],
    '134': ['target_temp_compst_xs', 'Curve P24 coefficient', ''],
    '135': ['hwh_freq_run_mode', 'Freq mode after setpoint', ''],
    '136': ['eheat_start_hj_temp', 'E-heater start ambient', '°C'],
    '137': ['wt_eheat_enter_tm', 'Tank e-heater delay', 'min'],
    '138': ['hw_waterp_mode', 'Water pump mode', ''],
    '139': ['defr_enter_temp', 'Defrost enter', '°C'],
    '140': ['defr_exit_temp', 'Defrost exit', '°C'],
    '141': ['defr_hj_coil_temp_diff1', 'Defrost ambient-coil diff', '°C'],
    '142': ['hw_run_freq_min', 'Freq min', 'Hz'],
    '143': ['hw_run_freq_max', 'Freq max', 'Hz'],
    '144': ['wth_compenst_freq', 'DHW freq compensation', 'Hz']
};

const FAULT_LABELS = ['Er03', 'Er04', 'Er05', 'Er06', 'Er09', 'Er10', 'Er12', 'Er14', 'Er15', 'Er16',
    'Er18', 'Er20', 'Er21', 'Er23', 'Er26', 'Er27', 'Er29', 'Er32', 'Er33', 'Er34', 'Er42', 'Er62',
    'Er63', 'Er64', 'Er66', 'Er67', 'Er68', 'Er69', 'Er70'];

const MODE_LABELS = { smart: 'Smart', strong: 'Powerful', mute: 'Silent' };
const WORK_MODE_LABELS = { wth: 'DHW', heat: 'Heating', cool: 'Cooling', wth_heat: 'DHW + heating', wth_cool: 'DHW + cooling' };

const CHART_INTERVAL_MS = 60 * 1000;
const COMPRESSOR_MAX_HZ = 91;     // rated max compressor frequency
const COMPRESSOR_MAX_A = 8;       // rated max compressor current
const FALLBACK_VOLTAGE_V = 230;   // used only while DP 114 (DC bus) has not been received
const STALE_MS = 5 * 60 * 1000;

function emptyDevice() {
    return { state: 'UNKNOWN', dps: {}, lastData: 0, lastState: 0 };
}

function decodeFaults(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return [];
    const out = [];
    for (let i = 0; i < FAULT_LABELS.length; i++) {
        if (n & (1 << i)) out.push(FAULT_LABELS[i]);
    }
    return out;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function switchValue(dev) {
    // Smart plugs / relays: DP 1 is the main switch on nearly every Tuya plug
    const v = dev.dps['1'];
    return typeof v === 'boolean' ? v : null;
}

// Power meter (SA1). Two common Tuya layouts:
// - plug / breaker: 18 cur_current (mA), 19 cur_power (W × 10), 20 cur_voltage (V × 10)
// - energy meter : 6 phase_a raw base64 = voltage (2 B, 0.1 V) + current (3 B, mA) + power (3 B, W),
//                  1 total forward energy (0.01 kWh)
function meterReading(dev) {
    if (!dev || !dev.lastData) return null;
    const d = dev.dps;
    const r = (v, k) => (v === null ? null : Math.round(v * k) / k);
    if (num(d['19']) !== null) {
        const w = num(d['19']) / 10;
        return {
            powerW: r(w, 10),
            currentA: num(d['18']) === null ? null : r(num(d['18']) / 1000, 1000),
            voltageV: num(d['20']) === null ? null : r(num(d['20']) / 10, 10),
            energyKwh: null,
            source: 'DP 19'
        };
    }
    if (typeof d['6'] === 'string' && d['6']) {
        let buf;
        try { buf = Buffer.from(d['6'], 'base64'); } catch (e) { buf = null; }
        if (buf && buf.length >= 8) {
            return {
                powerW: buf.readUIntBE(5, 3),
                currentA: r(buf.readUIntBE(2, 3) / 1000, 1000),
                voltageV: r(buf.readUInt16BE(0) / 10, 10),
                energyKwh: num(d['1']) === null ? null : r(num(d['1']) / 100, 100),
                source: 'DP 6'
            };
        }
    }
    return { powerW: null, currentA: null, voltageV: null, energyKwh: null, source: 'unknown DPs' };
}

// Built-in weather curve of the controller (P22 on)
const CURVE_BASE_C = 20;
const CURVE_MIN_C = 20;
const CURVE_MAX_C = 60;
const CURVE_OUT_MIN = -25;
const CURVE_OUT_MAX = 25;

function curveTarget(p23, p24, outdoor) {
    const t = CURVE_BASE_C + (p24 / 10) * (p23 - outdoor);
    return Math.max(CURVE_MIN_C, Math.min(CURVE_MAX_C, Math.round(t * 10) / 10));
}

function buildCurveChart(d) {
    const p23 = num(d['133']);
    const p24 = num(d['134']);
    if (p23 === null || p24 === null) return null;
    const enabled = d['132'] === undefined ? null : String(d['132']) === '1' || d['132'] === true;
    const outdoor = num(d['103']);
    const supply = num(d['102']);
    const reported = num(d['125']);

    const pts = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t++) pts.push({ out: t, set: curveTarget(p23, p24, t) });

    // SVG frame: viewBox 0 0 600 240, plot area x 44…590, y 12…204
    const W = 600, H = 240, L = 44, R = 10, T = 12, B = 36;
    const values = pts.map((p) => p.set).concat([supply, reported].filter((v) => v !== null));
    const yMin = Math.floor(Math.min(CURVE_MIN_C, ...values) / 5) * 5;
    const yMax = Math.ceil((Math.max(...values) + 1) / 5) * 5;   // at least 1 °C headroom
    const x = (t) => +(L + (t - CURVE_OUT_MIN) / (CURVE_OUT_MAX - CURVE_OUT_MIN) * (W - L - R)).toFixed(1);
    const y = (v) => +(T + (yMax - v) / (yMax - yMin) * (H - T - B)).toFixed(1);
    const inRange = (t) => t !== null && t >= CURVE_OUT_MIN && t <= CURVE_OUT_MAX;

    const xTicks = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t += 5) xTicks.push({ label: t, x: x(t) });
    const yTicks = [];
    for (let v = yMin; v <= yMax; v += 5) yTicks.push({ label: v, y: y(v) });

    const target = outdoor === null ? null : curveTarget(p23, p24, outdoor);
    return {
        enabled,
        p23,
        p24,
        formula: `${CURVE_BASE_C} + ${p24 / 10} × (${p23} − outdoor)`,
        table: [-20, -15, -10, -5, 0, 5, 10, 15].map((t) => ({ out: t, set: curveTarget(p23, p24, t) })),
        outdoor,
        target,
        reported,
        supply,
        svg: {
            viewBox: `0 0 ${W} ${H}`,
            line: pts.map((p) => `${x(p.out)},${y(p.set)}`).join(' '),
            xTicks,
            yTicks,
            left: L,
            right: W - R,
            top: T,
            bottom: H - B,
            yMin,
            yMax,
            outMin: CURVE_OUT_MIN,
            outMax: CURVE_OUT_MAX,
            now: inRange(outdoor) ? {
                x: x(outdoor),
                yTarget: y(target),
                ySupply: supply === null ? null : y(supply),
                yReported: reported === null ? null : y(reported)
            } : null
        }
    };
}

function buildModel(st, now) {
    const hp = st.hp;
    const d = hp.dps;
    const items = [];
    Object.keys(HP_DPS).forEach((dp) => {
        if (d[dp] === undefined) return;
        const [code, label, unit] = HP_DPS[dp];
        let value = d[dp];
        if (code === 'fault') value = decodeFaults(value).join(', ') || 'none';
        else if (code === 'mode') value = MODE_LABELS[value] || value;
        else if (code === 'work_mode') value = WORK_MODE_LABELS[value] || value;
        else if (typeof value === 'boolean') value = value ? 'ON' : 'OFF';
        items.push({ dp, code, label, unit, value });
    });
    const unknown = Object.keys(d).filter((dp) => !HP_DPS[dp]).map((dp) => ({ dp, value: d[dp] }));

    const fan = num(d['116']);
    const freq = num(d['115']);
    const defrostSign = fan === 0 && freq !== null && freq > 30;

    // Compressor load: frequency and current vs rated maxima, and an estimated electrical power
    const current = num(d['112']);
    const dcBus = num(d['114']);
    const pct = (value, max) => (value === null ? null : Math.max(0, Math.min(100, Math.round(value / max * 100))));
    const freqPct = pct(freq, COMPRESSOR_MAX_HZ);
    const currentPct = pct(current, COMPRESSOR_MAX_A);
    const loadPct = freqPct === null && currentPct === null ? null : Math.max(freqPct || 0, currentPct || 0);
    const voltage = dcBus !== null && dcBus > 0 ? dcBus : FALLBACK_VOLTAGE_V;
    const powerW = current === null ? null : Math.round(Math.max(0, current) * voltage);

    const devices = ROLES.map((role) => {
        const dev = st[role];
        const age = dev.lastData ? Math.round((now - dev.lastData) / 1000) : null;
        return {
            role,
            label: ROLE_LABELS[role],
            state: dev.state,
            ageSeconds: age,
            stale: !dev.lastData || now - dev.lastData > (CLOUD_ROLES.includes(role) ? CLOUD_STALE_MS : STALE_MS),
            switchOn: role === 'hp' ? (typeof d['1'] === 'boolean' ? d['1'] : null) : (role === 'meter' || CLOUD_ROLES.includes(role) ? null : switchValue(dev))
        };
    });

    const meterFresh = st.meter.lastData && now - st.meter.lastData <= STALE_MS;
    const meter = meterFresh ? st.meter.reading : null;
    const connected = (role) => st[role].state === 'CONNECTED' && st[role].lastData && now - st[role].lastData <= STALE_MS;
    const cloudTemp = (role) => {
        const c = st[role];
        return c && c.state === 'CONNECTED' && c.lastData && now - c.lastData <= CLOUD_STALE_MS ? num(c.dps.temp) : null;
    };

    return {
        updated: new Date(now).toISOString(),
        readOnly: false,
        controls: {
            curve: connected('hp') && num(d['133']) !== null,
            curveMin: 20,
            curveMax: 40,
            bypass: connected('bypass') && switchValue(st.bypass) !== null
        },
        devices,
        summary: {
            supply: num(d['102']),
            ret: num(d['101']),
            tank: num(d['108']),
            outdoor: num(d['103']),
            accTemp: cloudTemp('acc'),
            plateTemp: cloudTemp('plate'),
            compressorHz: freq,
            fanRpm: fan,
            compressorA: current,
            compressorLoadPct: loadPct,
            compressorFreqPct: freqPct,
            compressorCurrentPct: currentPct,
            compressorMaxHz: COMPRESSOR_MAX_HZ,
            compressorMaxA: COMPRESSOR_MAX_A,
            compressorPowerW: powerW,
            compressorPowerBasis: dcBus !== null && dcBus > 0 ? 'DC bus' : '230 V',
            powerW: meter ? meter.powerW : null,
            powerV: meter ? meter.voltageV : null,
            powerA: meter ? meter.currentA : null,
            powerEnergyKwh: meter ? meter.energyKwh : null,
            powerSource: st.meter.reading ? st.meter.reading.source : null,
            meterDps: Object.keys(st.meter.dps).map((dp) => ({ dp, value: st.meter.dps[dp] })),
            heatingSetpoint: num(d['125']),
            dhwSetpoint: num(d['123']),
            mode: MODE_LABELS[d['2']] || d['2'] || null,
            workMode: WORK_MODE_LABELS[d['5']] || d['5'] || null,
            curve: d['132'] === undefined ? null : { enabled: String(d['132']) === '1', p23: num(d['133']), p24: num(d['134']) },
            faults: decodeFaults(d['15']),
            valveToDhw: switchValue(st.valve),
            bypassOn: switchValue(st.bypass),
            defrostSign
        },
        curveChart: buildCurveChart(d),
        items,
        unknown
    };
}

// ---------------------------------------------------------------------------
const now = Date.now();
const role = msg.topic;
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
} else if (p.data && typeof p.data === 'object') {
    const dps = p.data.dps || {};
    Object.keys(dps).forEach((k) => { dev.dps[k] = dps[k]; });
    dev.lastData = now;
    dev.state = 'CONNECTED';
    if (role === 'meter') dev.reading = meterReading(dev);
} else {
    return null;
}

flow.set('heatPump', st);
const model = buildModel(st, now);
flow.set('heatPumpModel', model);

const statusText = model.summary.supply !== null
    ? `out ${model.summary.supply}° tank ${model.summary.tank}° ${model.summary.compressorHz} Hz`
    : `${role}: ${dev.state}`;
node.status({ fill: model.devices.every((x) => x.state === 'CONNECTED') ? 'green' : 'yellow', shape: 'dot', text: statusText });

let chartMsgs = null;
let powerMsgs = null;
const lastChart = context.get('lastChart') || 0;
if (role === 'hp' && dev.lastData === now && now - lastChart >= CHART_INTERVAL_MS) {
    context.set('lastChart', now);
    const s = model.summary;
    chartMsgs = [
        ['Supply', s.supply], ['Return', s.ret], ['Tank', s.tank], ['Outdoor', s.outdoor],
        ['Accumulator', s.accTemp], ['Exchange plate', s.plateTemp]
    ].filter(([, v]) => v !== null).map(([topic, v]) => ({ topic, payload: v }));
    powerMsgs = [
        ['Heat pump W (meter)', s.powerW], ['Compressor ≈W', s.compressorPowerW]
    ].filter(([, v]) => v !== null).map(([topic, v]) => ({ topic, payload: v }));
}

return [{ payload: model }, chartMsgs, powerMsgs];
