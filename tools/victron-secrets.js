#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = '/data/home/nodered/grid-control-config';
const FIELDS = ['deviceId', 'deviceKey', 'deviceIp', 'tuyaVersion'];

function variable(nodeId, field) {
    return 'VICTRON_' + nodeId.replace(/[^a-z0-9]/gi, '_').toUpperCase() + '_' + field.toUpperCase();
}

function prepareFlows(flows) {
    const prepared = JSON.parse(JSON.stringify(flows));
    const names = new Set();
    const variables = new Set();
    for (const node of prepared.filter((n) => n.type === 'tuya-smart-device')) {
        if (!node.deviceName || names.has(node.deviceName)) throw new Error('Tuya device names must be present and unique.');
        names.add(node.deviceName);
        for (const field of FIELDS) {
            const name = variable(node.id, field);
            if (variables.has(name)) throw new Error('Tuya environment variable name collision.');
            variables.add(name);
            node[field] = '${' + name + '}';
        }
        node.storeAsCreds = false;
        delete node.credentials;
    }
    if (!names.size) throw new Error('No Tuya nodes found.');
    return prepared;
}

function readJson(file, label) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('Cannot read valid ' + label + '; check the private file and permissions.'); }
}

function prepareNodeSettings(flows, devices) {
    const settings = {};
    for (const node of flows.filter((n) => n.type === 'tuya-smart-device')) {
        const matches = Object.entries(devices).filter(([, device]) => device.name === node.deviceName);
        if (matches.length !== 1) throw new Error('Unique private device-name mapping required for node ' + node.id + '.');
        settings[node.id] = { deviceId: matches[0][0], deviceIp: node.deviceIp || '',
            tuyaVersion: node.tuyaVersion };
    }
    if (!Object.keys(settings).length) throw new Error('No Tuya nodes found.');
    return settings;
}

// Call from Node-RED settings.js before exporting settings, after restoring files.
// Only enabled with an explicitly prepared flow file; existing credential-based
// flows are left unchanged.
function loadEnvironment(options = {}) {
    const flows = readJson(options.flowsFile || '/data/home/nodered/.node-red/flows.json', 'flows');
    const nodes = flows.filter((n) => n.type === 'tuya-smart-device' &&
        n.deviceKey === '${' + variable(n.id, 'deviceKey') + '}');
    if (!nodes.length) return false;
    const dir = options.configDir || CONFIG_DIR;
    const devices = readJson(path.join(dir, 'tuya-devices.json'), 'Tuya device configuration');
    const versions = readJson(path.join(dir, 'tuya-nodes.json'), 'Tuya node configuration');
    const values = {};
    for (const node of nodes) {
        if (node.storeAsCreds || FIELDS.some((field) => node[field] !== '${' + variable(node.id, field) + '}')) {
            throw new Error('Incomplete file-secret configuration for node ' + node.id + '.');
        }
        const setting = versions[node.id];
        if (!setting || typeof setting.deviceId !== 'string' || !setting.deviceId) {
            throw new Error('Missing private Tuya mapping for node ' + node.id + '.');
        }
        const device = devices[setting.deviceId];
        if (!device || typeof device.key !== 'string' || device.key.length !== 16) {
            throw new Error('Missing or invalid private Tuya key for node ' + node.id + '.');
        }
        if (typeof setting.deviceIp !== 'string' ||
            (setting.deviceIp && !/^(\d{1,3}\.){3}\d{1,3}$/.test(setting.deviceIp)) ||
            (setting.deviceIp && setting.deviceIp.split('.').some((part) => Number(part) > 255)) ||
            !['3.3', '3.4', '3.5'].includes(setting.tuyaVersion)) {
            throw new Error('Invalid private Tuya connection settings for node ' + node.id + '.');
        }
        const config = { deviceId: setting.deviceId, deviceKey: device.key,
            deviceIp: setting.deviceIp, tuyaVersion: setting.tuyaVersion };
        for (const field of FIELDS) values[variable(node.id, field)] = config[field];
    }
    // Validate the complete set before changing the process environment.
    Object.assign(options.environment || process.env, values);
    return true;
}

module.exports = { prepareFlows, prepareNodeSettings, loadEnvironment };

if (require.main === module) {
    try {
        const [command, input, argument, destination] = process.argv.slice(2);
        const output = command === 'prepare-nodes' ? destination : argument;
        if (!['prepare-flows', 'prepare-nodes'].includes(command) || !input || !output) {
            throw new Error('Usage: prepare-flows INPUT OUTPUT | prepare-nodes FLOWS DEVICES OUTPUT');
        }
        if (path.resolve(input) === path.resolve(output)) throw new Error('Use a separate output file; do not overwrite the deployed flows.');
        const prepared = command === 'prepare-flows' ? prepareFlows(readJson(input, 'source flows')) :
            prepareNodeSettings(readJson(input, 'source flows'), readJson(argument, 'private Tuya devices'));
        fs.writeFileSync(output, JSON.stringify(prepared, null, 2), { mode: 0o600, flag: 'wx' });
        console.log('Prepared file-secret flows; no secret values included.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
