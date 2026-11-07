// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `34 Heat pump state.js` and the embedded `func` for "Heat pump state"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - READ-ONLY collector for the Tuya heat pump and its two helper relays
//   (stage 1 of moving the heat pump control from the Tuya cloud to the GX).
// - Merges partial DP updates from the local Tuya connection into one state
//   object, decodes the known heat pump DPs and feeds the "Heat Pump" page.
// - Never sends anything to the devices. The only command used on the Tuya
//   nodes is the periodic GET from the poll inject (read).
// Input:
// - msg.topic = 'hp' | 'valve' | 'bypass' (set by the change node in front)
// - data msg  : msg.payload = { data: { dps: { ... } }, deviceId, deviceName }
// - status msg: msg.payload = { state: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' }
// Output (2):
// - output 1 -> msg.payload = page model for the "Heat pump page" ui_template
// - output 2 -> chart points for "Heat pump temperatures" (max once per minute)
// State:
// - flow.heatPump = { hp: {...}, valve: {...}, bypass: {...} }
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
// ==========================

const ROLES = ['hp', 'valve', 'bypass'];

const ROLE_LABELS = {
    hp: 'Heat pump',
    valve: 'Boiler valve relay (ON = DHW)',
    bypass: 'Heating exchange bypass (ON = bypass)'
};

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
            stale: !dev.lastData || now - dev.lastData > STALE_MS,
            switchOn: role === 'hp' ? (typeof d['1'] === 'boolean' ? d['1'] : null) : switchValue(dev)
        };
    });

    return {
        updated: new Date(now).toISOString(),
        readOnly: true,
        devices,
        summary: {
            supply: num(d['102']),
            ret: num(d['101']),
            tank: num(d['108']),
            outdoor: num(d['103']),
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
const lastChart = context.get('lastChart') || 0;
if (role === 'hp' && dev.lastData === now && now - lastChart >= CHART_INTERVAL_MS) {
    context.set('lastChart', now);
    const s = model.summary;
    chartMsgs = [
        ['Supply', s.supply], ['Return', s.ret], ['Tank', s.tank], ['Outdoor', s.outdoor]
    ].filter(([, v]) => v !== null).map(([topic, v]) => ({ topic, payload: v }));
}

return [{ payload: model }, chartMsgs];
