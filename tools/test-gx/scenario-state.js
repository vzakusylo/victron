'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { transformTuya, DEVICES } = require('./transform-tuya');
const { gateTickInjects } = require('./tick-gate');

const SETTINGS_FILES = [
    '/data/home/nodered/grid-control-config/heat-pump-automations.json',
    '/data/home/nodered/grid-control-config/high-voltage-settings.json'
];
const TEMP_LABEL = 'Temporary Test GX scenario';

class ScenarioCleanupError extends AggregateError {}

function functionHash(node) {
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(ordered(node))).digest('hex');
}

function assertFunctionHashes(actual, source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'flows.json'), 'utf8'))) {
    const registry = {};
    for (const node of source.filter(node => node.type === 'tuya-smart-device')) {
        const adapter = actual.find(item => item.id === node.id);
        const identity = adapter?.func?.match(/deviceId: ("(?:\\.|[^"\\])*"), deviceName:/);
        if (!Object.hasOwn(DEVICES, node.id) || !identity) throw new Error(`Missing Test GX Tuya adapter: ${node.id}`);
        registry[node.id] = { deviceId: JSON.parse(identity[1]) };
    }
    const prepared = source.map(node => node.type === 'mqtt-broker'
        ? { ...node, broker: 'mosquitto', port: '1883', usetls: false, tls: '' } : node);
    const expected = gateTickInjects(transformTuya(prepared, registry).flows).filter(node => node.type === 'function');
    const differences = expected.filter(node => {
        const deployed = actual.find(item => item.id === node.id);
        return !deployed || functionHash(deployed) !== functionHash(node);
    }).map(node => node.id);
    const ids = new Set(expected.map(node => node.id));
    differences.push(...actual.filter(node => node.type === 'function' && !ids.has(node.id)).map(node => node.id));
    if (differences.length) throw new Error(`Deployed function hash mismatch: ${differences.join(', ')}`);
    return { production: source.filter(node => node.type === 'function').length, adapters: Object.keys(registry).length };
}

function fileBridgeSource() {
    return `const paths = ${JSON.stringify(SETTINGS_FILES)};
try {
    if (msg.payload.action === 'restore') {
        const errors = [];
        for (const p of paths) {
            try {
                const saved = msg.payload.files[p];
                if (!saved) throw Error('Missing file snapshot: ' + p);
                if (saved.exists) {
                    fs.writeFileSync(p, Buffer.from(saved.content, 'base64'));
                    fs.chmodSync(p, saved.mode);
                } else if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (error) { errors.push(p + ': ' + error.message); }
        }
        if (errors.length) throw Error(errors.join('; '));
    } else if (msg.payload.action !== 'snapshot') throw Error('Unknown snapshot action');
    msg.payload = Object.fromEntries(paths.map(p => [p, fs.existsSync(p)
        ? { exists: true, content: fs.readFileSync(p).toString('base64'), mode: fs.statSync(p).mode & 511 }
        : { exists: false }]));
} catch (error) {
    node.error(error.message, msg);
    msg.statusCode = 500;
    msg.payload = { error: error.message };
}
return msg;`;
}

async function assertNoTemporaryFlows(request) {
    const response = await request('GET', '/flows');
    const nodes = Array.isArray(response) ? response : response.flows;
    if (!Array.isArray(nodes)) throw new Error('Node-RED did not return its deployed flows');
    const remaining = nodes.filter(node => node.type === 'tab' && node.label?.startsWith(TEMP_LABEL) ||
        node.name?.startsWith(TEMP_LABEL) || typeof node.id === 'string' &&
        (node.id.startsWith('tgx-state-') || node.id.startsWith('tgx-controller-')));
    if (remaining.length) throw new Error(`Temporary Test GX flows remain deployed: ${remaining.map(node => node.id).join(', ')}`);
}

function decodeContext(response, name) {
    if (response?.format === 'undefined' && response.msg === '(undefined)') return undefined;
    if (!response || response.format !== 'Object' || typeof response.msg !== 'string') {
        throw new Error(`Cannot snapshot ${name}: expected an object from the Node-RED context API`);
    }
    return JSON.parse(response.msg);
}

async function preserveSettings(request, wait, options = {}) {
    await assertNoTemporaryFlows(request);
    const token = randomBytes(8).toString('hex');
    const route = `/test-gx-state-${token}`;
    const prefix = `tgx-state-${token}`;
    const created = await request('POST', '/flow', {
        label: `${TEMP_LABEL} state backup`,
        nodes: [
            { id: `${prefix}-in`, type: 'http in', url: route, method: 'post', x: 120, y: 80, wires: [[`${prefix}-files`]] },
            { id: `${prefix}-files`, type: 'function', name: 'Snapshot scenario settings files',
                libs: [{ var: 'fs', module: 'fs' }], outputs: 1, func: fileBridgeSource(), x: 340, y: 80, wires: [[`${prefix}-out`]] },
            { id: `${prefix}-out`, type: 'http response', x: 560, y: 80, wires: [] },
            { id: `${prefix}-inject`, type: 'inject', name: 'Restore scenario heat pump settings',
                props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
                payload: '{}', payloadType: 'json', topic: 'load',
                repeat: '', crontab: '', once: false, onceDelay: 0.1, x: 120, y: 160, wires: [['hpa-fn-01']] }
        ]
    });
    if (!created || typeof created.id !== 'string') throw new Error('Node-RED did not return the settings backup flow id');
    let restored = false;
    try {
        await wait(6000);
        const deployed = await request('GET', `/flow/${created.id}`);
        const inject = deployed.nodes?.find(node => node.name === 'Restore scenario heat pump settings');
        if (!inject) throw new Error('Node-RED did not deploy the settings restore inject');
        const files = await request('POST', route, { action: 'snapshot' });
        const settings = decodeContext(await request('GET', '/context/node/hpa-fn-01/settings'), 'heat-pump settings');
        const directory = options.backupDirectory || path.join(os.tmpdir(), 'test-gx-scenario-backups');
        fs.mkdirSync(directory, { recursive: true });
        const backupPath = path.join(directory, `${token}.json`);
        fs.writeFileSync(backupPath, JSON.stringify({ files, settings }, null, 2), { flag: 'wx' });
        const injectSettings = (topic, payload) => request('POST', `/inject/${inject.id}`, {
            __user_inject_props__: [
                { p: 'payload', v: JSON.stringify(payload), vt: topic === 'load' ? 'str' : 'json' },
                { p: 'topic', v: topic, vt: 'str' }
            ]
        });
        return {
            backupPath,
            async restore() {
                if (restored) throw new Error('Scenario settings have already been restored');
                const errors = [];
                const attempt = async action => {
                    try { await action(); } catch (error) { errors.push(error); }
                };
                try {
                    if (settings !== undefined) {
                        await attempt(async () => {
                            await injectSettings('ui', { action: 'master', on: false });
                            await wait(200);
                        });
                        await attempt(async () => {
                            await injectSettings('load', settings);
                            await wait(1000);
                        });
                    }
                    await attempt(async () => assert.deepEqual(await request('POST', route, { action: 'restore', files }),
                        files, 'Settings files differ after restoration'));
                    if (settings !== undefined) {
                        await attempt(async () => assert.deepEqual(
                            decodeContext(await request('GET', '/context/node/hpa-fn-01/settings'), 'restored heat-pump settings'),
                            settings, 'Heat-pump settings context differs after restoration'));
                    }
                } finally {
                    try { await request('DELETE', `/flow/${created.id}`); } catch (error) { errors.push(error); }
                    try { await assertNoTemporaryFlows(request); } catch (error) { errors.push(error); }
                }
                restored = !errors.length;
                if (errors.length) throw new ScenarioCleanupError(errors,
                    `Scenario settings cleanup failed (backup ${backupPath}): ${errors.map(error => error.message).join('; ')}`);
            }
        };
    } catch (error) {
        const errors = [error];
        try { await request('DELETE', `/flow/${created.id}`); } catch (cleanupError) { errors.push(cleanupError); }
        try { await assertNoTemporaryFlows(request); } catch (cleanupError) { errors.push(cleanupError); }
        const ErrorType = errors.length > 1 ? ScenarioCleanupError : AggregateError;
        throw new ErrorType(errors, `Could not preserve scenario settings: ${errors.map(item => item.message).join('; ')}`);
    }
}

module.exports = {
    SETTINGS_FILES, ScenarioCleanupError, assertFunctionHashes, assertNoTemporaryFlows,
    decodeContext, fileBridgeSource, functionHash, preserveSettings
};
