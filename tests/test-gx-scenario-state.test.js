'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    preserveSettings, SETTINGS_FILES, fileBridgeSource, ScenarioCleanupError, assertFunctionHashes
} = require('../tools/test-gx/scenario-state');
const { runScenario } = require('../tools/test-gx/run-scenarios');

test('function hashes reject byte changes, missing nodes, hooks and extra functions', () => {
    const original = [
        { id: 'existing', type: 'function', func: 'return msg;\n', initialize: '', wires: [[]] },
        { id: 'temperature', type: 'function', func: 'return null;', wires: [[]] }
    ];
    assert.deepEqual(assertFunctionHashes(structuredClone(original), original), { production: 2, adapters: 0 });
    for (const changed of [
        [{ ...original[0], func: 'return msg;\r\n' }, original[1]],
        [original[0]],
        [{ ...original[0], initialize: 'context.set("test", 1);' }, original[1]],
        [...original, { id: 'unremoved-helper', type: 'function', func: 'return msg;' }]
    ]) assert.throws(() => assertFunctionHashes(changed, original), /function hash mismatch/);
});

test('settings snapshots restore file bytes and context before deleting and checking the temporary flow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-state-test-'));
    const settings = { master: false, modes: {} };
    const files = Object.fromEntries(SETTINGS_FILES.map(file => [file, { exists: false }]));
    const calls = [];
    let active = false;
    const request = async (method, route, body) => {
        calls.push({ method, route, body });
        if (method === 'GET' && route === '/flows') return active
            ? [{ type: 'tab', label: 'Temporary Test GX scenario state backup', id: 'temporary' }] : [];
        if (route === '/flow') { active = true; return { id: 'temporary' }; }
        if (method === 'GET' && route === '/flow/temporary') {
            return { nodes: [{ id: 'restore', name: 'Restore scenario heat pump settings' }] };
        }
        if (route.startsWith('/test-gx-state-')) return files;
        if (route.startsWith('/context/')) return { format: 'Object', msg: JSON.stringify(settings) };
        if (method === 'DELETE') active = false;
    };
    try {
        const saved = await preserveSettings(request, async () => {}, { backupDirectory: root });
        assert.deepEqual(JSON.parse(fs.readFileSync(saved.backupPath, 'utf8')), { files, settings });
        await saved.restore();
        const restoreFile = calls.findIndex(call => call.body?.action === 'restore');
        const deleted = calls.findIndex(call => call.method === 'DELETE');
        assert.ok(restoreFile > 0 && deleted > restoreFile);
        const injected = calls.filter(call => call.route === '/inject/restore');
        assert.equal(injected[0].body.__user_inject_props__[0].vt, 'json');
        assert.equal(injected[1].body.__user_inject_props__[0].vt, 'str');
        assert.deepEqual(JSON.parse(injected[1].body.__user_inject_props__[0].v), settings);
        assert.equal(calls.at(-1).route, '/flows');
        await assert.rejects(saved.restore(), /already been restored/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a remaining temporary flow fails before settings can be injected', async () => {
    await assert.rejects(preserveSettings(async () => [
        { id: 'leftover', type: 'tab', label: 'Temporary Test GX scenario settings' }
    ], async () => {}), /remain deployed: leftover/);
});

test('a failed file restoration does not skip the other saved file', () => {
    const restored = [];
    const files = Object.fromEntries(SETTINGS_FILES.map(file =>
        [file, { exists: true, content: Buffer.from('original').toString('base64'), mode: 0o600 }]));
    const bridge = new Function('msg', 'fs', 'Buffer', 'node', fileBridgeSource());
    const result = bridge({ payload: { action: 'restore', files } }, {
        writeFileSync(file, content) {
            restored.push(file);
            assert.equal(content.toString(), 'original');
            if (file === SETTINGS_FILES[0]) throw Error('write denied');
        },
        chmodSync() {}
    }, Buffer, { error() {} });
    assert.deepEqual(restored, SETTINGS_FILES);
    assert.equal(result.statusCode, 500);
    assert.match(result.payload.error, /write denied/);
});

test('an inject failure still restores files and removes the helper flow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-state-failure-'));
    const files = Object.fromEntries(SETTINGS_FILES.map(file => [file, { exists: false }]));
    const calls = [];
    let active = false;
    const request = async (method, route, body) => {
        calls.push({ method, route, body });
        if (route === '/flows') return active
            ? [{ type: 'tab', label: 'Temporary Test GX scenario state backup', id: 'temporary' }] : [];
        if (route === '/flow') { active = true; return { id: 'temporary' }; }
        if (method === 'GET' && route === '/flow/temporary') {
            return { nodes: [{ id: 'restore', name: 'Restore scenario heat pump settings' }] };
        }
        if (route.startsWith('/test-gx-state-')) return files;
        if (route.startsWith('/context/')) return { format: 'Object', msg: '{"master":false}' };
        if (route.startsWith('/inject/')) throw Error('inject unavailable');
        if (method === 'DELETE') active = false;
    };
    try {
        const saved = await preserveSettings(request, async () => {}, { backupDirectory: root });
        await assert.rejects(saved.restore(), error => error instanceof ScenarioCleanupError &&
            /inject unavailable/.test(error.message));
        assert.ok(calls.some(call => call.body?.action === 'restore'));
        assert.equal(active, false);
        assert.equal(calls.at(-1).route, '/flows');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a scenario without settings waits for the restarted Admin API before its final hash check', async () => {
    let ready = false;
    let readyChecks = 0;
    await runScenario({
        name: 'startup readiness', faketime: '@2026-11-16 12:00:00',
        steps: [{ when: '0s', settle: '0s', expect: { writes: [] } }]
    }, {
        setFaketime: async () => { ready = false; },
        api: { getState: async () => ({}), post: async () => {}, getWrites: async () => [] },
        admin: {
            ready: async () => { ready = true; readyChecks++; },
            verifyDeployed: async () => assert.equal(ready, true)
        }
    });
    assert.equal(readyChecks, 2);
});

test('scenario failure still restores settings and cleanup failure cannot be an expected failure', async () => {
    let restored = 0;
    let active = false;
    let hashChecks = 0;
    const scenario = {
        name: 'cleanup on failure', faketime: '@2026-11-16 12:00:00',
        settings: { master: false, modes: {} },
        steps: [{ when: '0s', settle: '0s', expect: { writes: [{ device: 'pump' }] } }]
    };
    const options = {
        waitReady: false, setFaketime: async () => {},
        api: { post: async () => {}, getWrites: async () => [] },
        admin: {
            verifyDeployed: async () => {
                hashChecks++;
                assert.equal(active, false, 'hash/leak check ran before helper removal');
            },
            loadSettings: async () => {},
            preserveSettings: async () => {
                active = true;
                return { restore: async () => { restored++; active = false; } };
            }
        }
    };
    await assert.rejects(runScenario(scenario, options), /expected 1 writes/);
    assert.equal(restored, 1);
    assert.equal(hashChecks, 2);
    options.admin.preserveSettings = async () => ({ restore: async () => { throw Error('restore failed'); } });
    await assert.rejects(runScenario(scenario, options), error =>
        error instanceof AggregateError && /expected 1 writes.*restore failed/.test(error.message));
});
