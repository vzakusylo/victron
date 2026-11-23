#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { DEVICES, transformTuya } = require('../transform-tuya');
const devices = require('../fixture-tuya.json');
const { gateTickInjects, GATED_INJECTS, GATE_SUFFIX } = require('../tick-gate');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(__dirname, '..', 'fixture-synthetic', 'nodered', '.node-red', 'flows.json');

function verify(repo, actual) {
    if (!Array.isArray(repo) || !Array.isArray(actual)) throw new Error('Flows must be arrays');
    if (new Set(repo.map(node => node.id)).size !== repo.length ||
        new Set(actual.map(node => node.id)).size !== actual.length) {
        throw new Error('Duplicate flow node ID');
    }

    const source = structuredClone(repo);
    const ids = Object.keys(DEVICES).sort();
    const tuya = source.filter(node => node.type === 'tuya-smart-device');
    if (!isDeepStrictEqual(tuya.map(node => node.id).sort(), ids) ||
        !isDeepStrictEqual(Object.keys(devices).sort(), ids)) {
        throw new Error('Fixture mapping must cover exactly the supported Tuya nodes');
    }
    const registry = {};
    for (const node of tuya) {
        const device = devices[node.id];
        registry[node.id] = {
            deviceId: device.deviceId, deviceIp: device.deviceIp, tuyaVersion: device.tuyaVersion
        };
    }
    const brokers = source.filter(node => node.type === 'mqtt-broker');
    if (brokers.length !== 1 || brokers[0].usetls !== false || brokers[0].credentials !== undefined) {
        throw new Error('Expected exactly one credential-free, non-TLS MQTT broker');
    }
    Object.assign(brokers[0], { broker: 'mosquitto', port: '1883' });
    for (const node of source) {
        if (node.type === 'tab' && /d#\d+/.test(node.label || '')) node.label += ' TEST-GX';
    }
    if (repo.some(node => node.id.endsWith(GATE_SUFFIX))) throw new Error('Production flows must not contain a test tick gate');
    const expected = gateTickInjects(transformTuya(source, registry).flows);
    const gates = actual.filter(node => node.id.endsWith(GATE_SUFFIX));
    if (gates.length !== GATED_INJECTS.length) throw new Error('Fixture must contain exactly one tick gate per gated inject');
    if (!isDeepStrictEqual(actual, expected)) {
        const index = expected.findIndex((node, i) => !isDeepStrictEqual(actual[i], node));
        throw new Error('Fixture differs from the approved flow transform' +
            (index < 0 ? ' (node count)' : ' at node index ' + index));
    }
    return {
        functions: repo.filter(node => node.type === 'function').length,
        proxies: tuya.length,
        added: expected.length - repo.length
    };
}

async function main(args) {
    let imageFile;
    let admin;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--image-file' && args[i + 1]) imageFile = args[++i];
        else if (args[i] === '--admin' && args[i + 1]) admin = args[++i];
        else throw new Error('Usage: node check.js [--image-file <flows.json>] [--admin <url>]');
    }
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const summary = verify(repo, JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
    if (imageFile) {
        verify(repo, JSON.parse(fs.readFileSync(imageFile, 'utf8')));
        console.log('Image flow matches the approved fixture transform.');
    }
    if (admin) {
        const response = await fetch(new URL('/flows', admin), { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Node-RED /flows returned HTTP ' + response.status);
        const flows = await response.json();
        verify(repo, Array.isArray(flows) ? flows : flows.flows);
        console.log('Running Node-RED flow matches the approved fixture transform.');
    }
    console.log(`${summary.functions} repository functions unchanged; ` +
        `${summary.proxies} Tuya proxies; ${summary.added} added fixture nodes.`);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verify };
