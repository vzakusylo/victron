//! Node 34: DP definitions and device decoding.
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
    '125': ['ach_stemp', 'Pump set (fixed, DP 125)', '°C'],
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

// Nameplate PW030-DKZLRS-A (Power World EVI DC inverter, 230 V 1-phase, R32): current
// 1.28–9.67 A, input power 0.31–2.13 kW (heating). 2.13 kW / 9.67 A = 220 W per amp at full
// load (0.31 kW / 1.28 A = 242 W/A at minimum) — so the input power ≈ current × 220 W/A.
// The DC bus voltage (DP 114, ~376 V) is NOT the supply voltage: current × DC bus gave up to
// 3 kW at 8 A, above the nameplate maximum (d#133).
const COMPRESSOR_MAX_HZ = 90;     // highest frequency seen (Smart; recorder 8–9 Nov 2026)
const COMPRESSOR_MAX_A = 9.67;    // nameplate max current of the unit
const UNIT_MAX_W = 2130;          // nameplate max input power (heating)
const W_PER_A = 220;              // nameplate 2130 W / 9.67 A
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
