#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { transformTuya, DEVICES } = require('./transform-tuya');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixture-synthetic');
const FAKE_PASSWORD_HASH = '$2a$10$abcdefghijklmnopqrstuud40sZe9YD2AFwv0u1Os6NY0jgVorBEC';
const TOOLS = [
    'reload-victron-secrets.js', 'send-mail.js', 'set-mail-password.js',
    'tuya-cloud-sensors.js', 'tuya-cloud-status.js', 'tuya-devices-setup.js',
    'tuya-local-sensors.js', 'victron-secrets.js', 'sensor-history.js',
    'heatpump-decode.js', 'deploy-version.js',
    'gx/deploy.js', 'gx/live-snapshot.js', 'gx/monitor.js', 'gx/verify.js'
];

function fixtureFiles() {
    const files = new Map();
    const json = (name, value) => files.set(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
    const text = (name, value) => files.set(name, Buffer.from(value));
    const versions = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-versions.json'), 'utf8'));
    const devices = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-tuya.json'), 'utf8'));
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    if (Object.keys(devices).sort().join() !== Object.keys(DEVICES).sort().join()) {
        throw new Error('Fixture mapping must cover exactly the supported Tuya nodes');
    }
    const registry = {}, keys = {};
    for (const [id, device] of Object.entries(devices)) {
        if (!device.deviceId.startsWith('test-only-') || device.deviceKey.length !== 16 ||
            !device.deviceKey.startsWith('test-only-') || !device.deviceName.startsWith('test-only-')) {
            throw new Error('Fixture Tuya identities and keys must be explicit test-only placeholders');
        }
        registry[id] = { deviceId: device.deviceId, deviceIp: device.deviceIp, tuyaVersion: device.tuyaVersion };
        keys[device.deviceId] = { name: device.deviceName, key: device.deviceKey };
        const node = flows.find(n => n.id === id && n.type === 'tuya-smart-device');
        if (!node) throw new Error('Missing fixture Tuya source node: ' + id);
        node.deviceName = device.deviceName;
    }
    for (const node of flows) {
        if (node.type === 'mqtt-broker') {
            Object.assign(node, { broker: 'mosquitto', port: '1883', usetls: false, tls: '' });
            delete node.credentials;
        }
        if (node.type === 'tab' && /d#\d+/.test(node.label || '')) node.label += ' TEST-GX';
    }
    json('nodered/.node-red/flows.json', transformTuya(flows, registry).flows);
    json('nodered/.node-red/flows_cred.json', {});
    json('versions.json', versions);
    const dependencies = Object.fromEntries(Object.entries(versions.palette).filter(([name]) => name !== 'node-red'));
    dependencies['@victronenergy/node-red-contrib-victron'] = '1.6.65';
    dependencies.tuyapi = '7.7.1';
    json('nodered/package.json', {
        name: 'test-gx-synthetic', version: '1.0.0', private: true, dependencies,
        testGx: {
            nodeRed: versions.nodeRed,
            runtimeDependencySources: { tuyapi: ['tools/tuya-local-sensors.js'] },
            paletteDifference: 'GX 1.6.31 / test 1.6.65 (1.6.31 not on npm)'
        }
    });
    text('nodered/.node-red/settings.js', `'use strict';
// TEST GX ONLY - not for any real Node-RED.
// The published admin port MUST be bound to 127.0.0.1: anonymous admin is intentional for scenarios.
// Hash of the fake password "test-only-not-a-secret" with a fixed test-only salt.
module.exports = {
    flowFile: 'flows.json',
    httpAdminRoot: '/',
    credentialSecret: 'test-only-not-a-secret',
    adminAuth: {
        type: 'credentials',
        users: [{ username: 'test-only-admin', password: '${FAKE_PASSWORD_HASH}', permissions: '*' }],
        default: { permissions: '*' }
    },
    contextStorage: { default: { module: 'memory' } },
    functionGlobalContext: {},
    functionExternalModules: true
};
`);
    const config = 'nodered/grid-control-config/';
    for (const name of [
        'controller-constants', 'high-voltage-settings', 'files-dashboard-state', 'payback',
        'tuya-cloud', 'tuya-devices-meta', 'tuya-devices-last', 'tuya-devices-ver',
        'tuya-local-sensors', 'tuya-local-sensors-last'
    ]) json(config + name + '.json', {});
    json(config + 'tuya-nodes.json', registry);
    json(config + 'tuya-devices.json', keys);
    json(config + 'tuya-devices-cloud.json', { at: 0, devices: {} });
    json(config + 'heat-pump-automations.json', { master: false, modes: {} });
    json(config + 'compressor-resource.json', { version: 1, runS: 0 });
    json(config + 'elvenett-statistics.json', {
        schemaVersion: 1, source: 'https://nett.elvenett.no', months: [], expensePeriods: []
    });
    json(config + 'email.json', {
        host: 'smtp.test.invalid', port: 465, user: 'test-only-not-a-secret',
        pass: 'test-only-not-a-secret', from: 'test-only-mail@example.invalid', to: 'test-only-mail@example.invalid'
    });
    text(config + 'mcp-token.txt', 'test-only-not-a-secret\n');
    text(config + 'bms-watchdog-good.txt', '');
    text('nodered/grid-control-logs/.gitkeep', '');
    for (const tool of TOOLS) {
        files.set('nodered/tools/' + tool, fs.readFileSync(path.join(ROOT, 'tools', ...tool.split('/'))));
    }
    return files;
}

function buildFixture(destination = FIXTURE) {
    const files = fixtureFiles();
    for (const [name, content] of files) {
        const file = path.join(destination, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return files;
}

module.exports = { buildFixture, fixtureFiles, FIXTURE, FAKE_PASSWORD_HASH };

if (require.main === module) {
    buildFixture();
    console.log('Generated fixture-synthetic from repository sources only; no backup access.');
}
