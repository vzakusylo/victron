#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { loadEnvironment } = require('./victron-secrets');

const CONFIG_DIR = '/data/home/nodered/grid-control-config';
const NODE_RED_DIR = '/data/home/nodered/.node-red';
const SERVICE = '/service/node-red-venus';
const CONFIG_FILES = ['tuya-cloud.json', 'tuya-devices.json', 'tuya-local-sensors.json',
    'email.json', 'mcp-token.txt', 'tuya-nodes.json'];
const NODE_RED_FILES = ['flows_cred.json', '.config.runtime.json', '.config.users.json', 'settings-user.js'];

function validateSecrets(options = {}) {
    const configDir = options.configDir || CONFIG_DIR;
    const nodeRedDir = options.nodeRedDir || NODE_RED_DIR;
    const files = CONFIG_FILES.map(name => path.join(configDir, name))
        .concat(NODE_RED_FILES.map(name => path.join(nodeRedDir, name)),
            options.vendorSettings || '/usr/lib/node_modules/node-red/venus-settings.js');
    const json = {};
    for (const file of files) {
        const name = path.basename(file);
        try {
            const content = fs.readFileSync(file, 'utf8');
            if (name.endsWith('.json')) {
                json[name] = JSON.parse(content);
                if (!json[name] || typeof json[name] !== 'object') throw new Error();
            } else if (name.endsWith('.js')) {
                new vm.Script(content, { filename: name });
            }
        } catch {
            throw new Error('Cannot validate private file ' + name + '; check content and permissions. No reload performed.');
        }
    }
    for (const field of ['accessId', 'accessSecret', 'endpoint']) {
        if (!json['tuya-cloud.json'][field]) throw new Error('Missing Tuya cloud field ' + field + '. No reload performed.');
    }
    for (const field of ['host', 'user', 'pass', 'to']) {
        if (!json['email.json'][field]) throw new Error('Missing mail field ' + field + '. No reload performed.');
    }
    const environment = {};
    const loaded = loadEnvironment({ configDir, flowsFile: path.join(nodeRedDir, 'flows.json'), environment });
    if (!loaded) throw new Error('Flow has no file-secret references. Perform the documented migration first.');
    return { files: files.length, nodes: Object.keys(environment).length / 4 };
}

async function run(command, args) {
    try {
        return (await execFile(command, args, { timeout: 10000, maxBuffer: 4096 })).stdout;
    } catch {
        throw new Error('Supervisor command failed: ' + command + '. Check the GX service directly.');
    }
}

async function readHealth(token) {
    const response = await fetch('http://127.0.0.1:1880/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'get_heat_pump', arguments: {} } }),
        signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    if (!response.ok || !body.result || body.result.isError) throw new Error('MCP health unavailable.');
    const data = JSON.parse(body.result.content[0].text);
    if (!Array.isArray(data.devices)) throw new Error('No device health data.');
    const devices = data.devices.filter(device => ['hp', 'valve', 'bypass', 'meter'].includes(device.role))
        .map(device => ({ role: device.role, state: device.state, stale: device.stale }));
    if (new Set(devices.map(device => device.role)).size !== 4) throw new Error('Incomplete Tuya health data.');
    return devices;
}

async function reloadSecrets(options = {}) {
    const summary = validateSecrets(options);
    const execute = options.run || run;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const health = options.readHealth || readHealth;
    const service = options.service || SERVICE;
    const token = fs.readFileSync(path.join(options.configDir || CONFIG_DIR, 'mcp-token.txt'), 'utf8').trim();
    const state = await execute('svstat', [service]);
    if (!/: up\b/.test(state)) throw new Error('Node-RED is not running. Reload does not enable a stopped service.');
    let before = [];
    if (token) {
        try { before = await health(token); }
        catch { throw new Error('Cannot read baseline device health. No reload performed.'); }
    }
    let stopAttempted = false;
    let started = false;
    try {
        stopAttempted = true;
        await execute('svc', ['-d', service]);
        let stopped = false;
        for (let i = 0; i < 20; i++) {
            if (/: down\b/.test(await execute('svstat', [service]))) { stopped = true; break; }
            await sleep(1000);
        }
        if (!stopped) throw new Error('Node-RED did not stop within 20 seconds.');
        await execute('svc', ['-u', service]);
        started = true;
    } finally {
        // If stop/wait failed, still ask the previously running service to start.
        if (stopAttempted && !started) await execute('svc', ['-u', service]);
    }
    const expected = before.filter(device => device.state === 'CONNECTED' && !device.stale);
    for (let i = 0; i < 24; i++) {
        try {
            if (token) {
                const after = await health(token);
                if (expected.every(device => after.some(current =>
                    current.role === device.role && current.state === 'CONNECTED' && !current.stale))) {
                    return { ...summary, devices: after, mcpDisabled: false };
                }
            } else {
                const response = await fetch('http://127.0.0.1:1880/', { signal: AbortSignal.timeout(5000) });
                if (response.ok || response.status === 401) return { ...summary, mcpDisabled: true };
            }
        } catch { /* Bounded startup retries; final failure is reported below. */ }
        await sleep(5000);
    }
    throw new Error('Reload requested, but service/device health did not recover. Node-RED was left running; inspect it directly.');
}

module.exports = { validateSecrets, reloadSecrets };

if (require.main === module) {
    (async () => {
        const command = process.argv[2];
        if (!['check', 'reload'].includes(command)) throw new Error('Usage: node tools/reload-victron-secrets.js check|reload');
        if (command === 'reload' && (!process.getuid || process.getuid() !== 0)) {
            throw new Error('Reload must run as root on the GX. Check mode does not restart services.');
        }
        const result = command === 'check' ? validateSecrets() : await reloadSecrets();
        console.log('Validated private files: ' + result.files + '; file-backed Tuya nodes: ' + result.nodes);
        if (command === 'reload') {
            console.log('Node-RED restarted; it reloads private files locally, not from GitHub.');
            if (result.mcpDisabled) console.log('MCP is disabled; verify device connections manually.');
            else console.log(JSON.stringify(result.devices));
        }
    })().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
