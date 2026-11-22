'use strict';

const http = require('node:http');
const SYSTEM = 'com.victronenergy.system';
const SETTINGS = 'com.victronenergy.settings';
const SERIAL = 'com.victronenergy.battery.ttyTEST';
const VEBUS = 'com.victronenergy.vebus.emulator';
const INSTANCE = '/Settings/SystemSetup/BmsInstance';
const BASE = 'http://venus:8081';

function request(path, data) {
    return new Promise((resolve, reject) => {
        const body = data === undefined ? undefined : JSON.stringify(data);
        const req = http.request(BASE + path, body === undefined ? {} : {
            method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
        }, response => {
            let result = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { result += chunk; });
            response.on('error', reject);
            response.on('end', () => {
                if (response.statusCode !== 200) return reject(new Error(`BMS fixture ${path}: HTTP ${response.statusCode}`));
                try { resolve(JSON.parse(result)); } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error(`BMS fixture ${path}: timeout`)));
        req.end(body);
    });
}

async function main([bus, service, path, operation, argument, ...extra]) {
    if (bus !== '-y' || extra.length) throw new Error('Unsupported BMS fixture CLI arguments');
    const bms = (await request('/state')).bms;
    if (service === undefined) {
        console.log([SYSTEM, SETTINGS, VEBUS, ...(bms.present ? [SERIAL] : [])].join('\n'));
        return;
    }
    if (service === SETTINGS && path === INSTANCE && operation === 'SetValue' && /^%-?\d+$/.test(argument)) {
        await request('/bms-repair', { instance: Number(argument.slice(1)) });
        return;
    }
    if (operation !== 'GetValue' || argument !== undefined) throw new Error('Unsupported BMS fixture operation');
    const values = {
        [SYSTEM]: { '/ActiveBmsService': bms.active ? SERIAL : '[]' },
        [SETTINGS]: { [INSTANCE]: bms.instance },
        [SERIAL]: bms.present ? { '/Connected': Number(bms.connected) } : {},
        [VEBUS]: { '/State': bms.passthru ? 8 : 3, '/Alarms/BmsConnectionLost': Number(bms.passthru), '/Alarms/LowBattery': 0 }
    };
    if (!Object.hasOwn(values[service] || {}, path)) throw new Error('Unsupported BMS fixture service or path');
    console.log(`value = ${values[service][path]}`);
}

main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
