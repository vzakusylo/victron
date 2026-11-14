'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareFlows } = require('../tools/victron-secrets');
const { validateSecrets, reloadSecrets } = require('../tools/reload-victron-secrets');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victron-reload-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (name, value) => fs.writeFileSync(path.join(dir, name),
        typeof value === 'string' ? value : JSON.stringify(value));
    write('tuya-cloud.json', { accessId: 'synthetic', accessSecret: 'synthetic', endpoint: 'https://example.invalid' });
    write('email.json', { host: 'example.invalid', user: 'synthetic', pass: 'synthetic', to: 'test@example.invalid' });
    write('tuya-devices.json', { synthetic: { key: '0123456789abcdef' } });
    write('tuya-local-sensors.json', {});
    write('tuya-nodes.json', { 'hp-01': { deviceId: 'synthetic', deviceIp: '', tuyaVersion: '3.5' } });
    write('mcp-token.txt', 'synthetic-token');
    for (const name of ['flows_cred.json', '.config.runtime.json', '.config.users.json']) write(name, {});
    write('settings-user.js', 'module.exports = {};');
    write('venus-settings.js', 'module.exports = {};');
    write('flows.json', prepareFlows([{ id: 'hp-01', type: 'tuya-smart-device', deviceName: 'pump', deviceIp: '' }]));
    return { dir, write, options: { configDir: dir, nodeRedDir: dir, vendorSettings: path.join(dir, 'venus-settings.js') } };
}

test('checks all eleven files and validates mappings without revealing values', t => {
    const f = fixture(t);
    assert.deepEqual(validateSecrets(f.options), { files: 11, nodes: 1 });
    f.write('email.json', '{"pass":"synthetic-sensitive-value",');
    assert.throws(() => validateSecrets(f.options), error =>
        /email.json/.test(error.message) && !error.message.includes('synthetic-sensitive-value'));
});

test('invalid private files prevent all supervisor commands', async t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.dir, 'tuya-cloud.json'));
    let calls = 0;
    await assert.rejects(reloadSecrets({ ...f.options, run: async () => { calls++; } }), /Cannot validate/);
    assert.equal(calls, 0);
});

test('reload restarts an already running service and verifies previously healthy devices', async t => {
    const f = fixture(t);
    const commands = [];
    const health = [{ role: 'hp', state: 'CONNECTED', stale: false }];
    const result = await reloadSecrets({ ...f.options,
        run: async (command, args) => {
            commands.push([command, ...args]);
            return commands.length === 3 ? '/service/test: down 1 seconds' : '/service/test: up (pid 123) 1 seconds';
        },
        readHealth: async () => health,
        sleep: async () => {}
    });
    assert.deepEqual(commands.filter(row => row[0] === 'svc').map(row => row[1]), ['-d', '-u']);
    assert.deepEqual(result.devices, health);
});

test('a stopped service is not enabled, and a failed stop still requests startup', async t => {
    const f = fixture(t);
    await assert.rejects(reloadSecrets({ ...f.options, run: async () => '/service/test: down 1 seconds' }), /not running/);
    const commands = [];
    await assert.rejects(reloadSecrets({ ...f.options,
        run: async (command, args) => {
            commands.push([command, ...args]);
            if (command === 'svc' && args[0] === '-d') throw new Error('synthetic stop failure');
            return '/service/test: up (pid 123) 1 seconds';
        },
        readHealth: async () => [], sleep: async () => {}
    }), /synthetic stop failure/);
    assert.deepEqual(commands.filter(row => row[0] === 'svc').map(row => row[1]), ['-d', '-u']);
});

test('a missing baseline health response prevents service interruption', async t => {
    const f = fixture(t);
    const commands = [];
    await assert.rejects(reloadSecrets({ ...f.options,
        run: async (command, args) => {
            commands.push([command, ...args]);
            return '/service/test: up (pid 123) 1 seconds';
        },
        readHealth: async () => { throw new Error('synthetic health failure'); }
    }), /No reload performed/);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'svstat');
});

test('an intentionally disabled MCP uses HTTP readiness without enabling MCP', async t => {
    const f = fixture(t);
    f.write('mcp-token.txt', '');
    t.mock.method(global, 'fetch', async () => ({ ok: true }));
    let calls = 0;
    const result = await reloadSecrets({ ...f.options,
        run: async () => {
            calls++;
            return calls === 3 ? '/service/test: down 1 seconds' : '/service/test: up (pid 123) 1 seconds';
        },
        readHealth: async () => { throw new Error('MCP must not be called'); },
        sleep: async () => {}
    });
    assert.equal(result.mcpDisabled, true);
    assert.equal(fs.readFileSync(path.join(f.dir, 'mcp-token.txt'), 'utf8'), '');
});
