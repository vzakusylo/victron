#!/usr/bin/env node
'use strict';

const http = require('http');

const API = process.env.TEST_GX_EMULATOR_URL || 'http://venus:8081/tuya/boiler';
const started = Date.now();
const out = (record) => process.stdout.write(JSON.stringify(Object.assign({ t: Date.now() }, record)) + '\n');

function getBoiler() {
    return new Promise((resolve, reject) => {
        const request = http.get(API, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) return reject(new Error('GET ' + API + ' -> ' + response.statusCode));
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(5000, () => request.destroy(new Error('boiler emulator request timed out')));
        request.on('error', reject);
    });
}

(async () => {
    try {
        const boiler = await getBoiler();
        if (boiler.state !== 'CONNECTED') {
            out({ kind: 'error', id: 'boiler', ip: '', error: boiler.error || boiler.state || 'no data' });
        } else if (!boiler.dps || typeof boiler.dps !== 'object' || Array.isArray(boiler.dps)) {
            out({ kind: 'error', id: 'boiler', ip: '', error: 'invalid boiler DPS' });
        } else {
            out({ kind: 'reading', id: 'boiler', ip: '', version: 'emulator', dps: boiler.dps });
        }
    } catch (error) {
        out({ kind: 'error', id: 'boiler', ip: '', error: error.message });
    }
    out({ kind: 'done', ms: Date.now() - started, polled: 1 });
})().catch((error) => {
    out({ kind: 'error', id: 'boiler', ip: '', error: error.message });
    out({ kind: 'done', ms: Date.now() - started, polled: 1 });
    process.exitCode = 0;
});
