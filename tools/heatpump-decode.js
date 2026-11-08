#!/usr/bin/env node
// Decode heat pump "hp1" hourly files (written by `36 Record heat pump data.js`)
// into plain CSV: one full row per 30 s sample, with a real timestamp.
//
// Usage:
//   node tools/heatpump-decode.js 00.csv.gz [01.csv.gz ...] > day.csv
//   node tools/heatpump-decode.js --names 00.csv.gz      # column names instead of DP ids
//
// Works with .csv and .csv.gz. On the GX: copy the files to the PC, or run it there with
// `node` (Venus OS Large ships Node.js).
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const NAMES = {
    '1': 'power', '2': 'mode', '5': 'work_mode', '15': 'fault',
    '101': 'return_c', '102': 'supply_c', '103': 'outdoor_c', '104': 'discharge_c', '105': 'suction_c',
    '106': 'outdoor_coil_c', '107': 'cooling_coil_c', '108': 'dhw_tank_c', '109': 'main_eev_p',
    '111': 'evi_eev_p', '112': 'compressor_a', '113': 'heatsink_c', '114': 'dc_bus_v', '115': 'compressor_hz',
    '116': 'fan1_rpm', '117': 'fan2_rpm', '121': 'heat_hyst_c', '122': 'dhw_hyst_c', '123': 'dhw_set_c',
    '124': 'cool_set_c', '125': 'heat_set_c', '126': 'water_comp_c', '132': 'curve_p22', '133': 'curve_p23_c',
    '134': 'curve_p24', '135': 'freq_mode', '136': 'eheat_start_c', '137': 'tank_eheat_delay_min',
    '138': 'water_pump_mode', '139': 'defrost_enter_c', '140': 'defrost_exit_c', '141': 'defrost_diff_c',
    '142': 'freq_min_hz', '143': 'freq_max_hz', '144': 'dhw_freq_comp_hz', 'v1': 'valve_dhw', 'b1': 'bypass_on'
};

const args = process.argv.slice(2);
const useNames = args.includes('--names');
const files = args.filter((a) => a !== '--names');
if (!files.length) {
    console.error('usage: node tools/heatpump-decode.js [--names] HH.csv[.gz] ...');
    process.exit(2);
}

let printedHeader = null;
for (const file of files) {
    let text = fs.readFileSync(file);
    if (file.endsWith('.gz')) text = zlib.gunzipSync(text);
    text = text.toString('utf8');

    let cols = null;
    let date = null;
    let hour = null;
    let last = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith('#hp1 ')) {
            const m = line.match(/^#hp1 (\d{4}-\d{2}-\d{2}) (\d{2}) cols=(.*)$/);
            if (!m) throw new Error(file + ': bad header: ' + line);
            [, date, hour] = m;
            cols = m[3].split(',');
            last = new Array(cols.length).fill('');
            const header = ['time'].concat(cols.slice(1).map((c) => (useNames && NAMES[c] ? NAMES[c] : c))).join(',');
            if (header !== printedHeader) {
                process.stdout.write(header + '\n');
                printedHeader = header;
            }
            continue;
        }
        if (!cols) throw new Error(file + ': data before header');
        const cells = line.split(',');
        for (let i = 1; i < cols.length; i++) {
            if (cells[i] !== undefined && cells[i] !== '') last[i] = cells[i];
        }
        const t = Number(cells[0]);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        process.stdout.write([`${date} ${hour}:${mm}:${ss}`].concat(last.slice(1)).join(',') + '\n');
    }
}
