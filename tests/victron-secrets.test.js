'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareFlows, prepareNodeSettings, loadEnvironment } = require('../tools/victron-secrets');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victron-secrets-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const original = [{ id: 'hp-01', type: 'tuya-smart-device', deviceName: 'pump',
        storeAsCreds: true, deviceIp: '192.168.1.53', tuyaVersion: '3.5',
        credentials: { secretConfig: 'synthetic-original-private-value' } }];
    const flows = prepareFlows(original);
    const write = (file, content) => fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
    write('flows.json', flows);
    write('tuya-devices.json', { synthetic: { key: '0123456789abcdef' } });
    write('tuya-nodes.json', { 'hp-01': { deviceId: 'synthetic', deviceIp: '192.168.1.53', tuyaVersion: '3.5' } });
    return { original, flows, write, options: { configDir: dir, flowsFile: path.join(dir, 'flows.json'), environment: {} } };
}

test('prepared flows contain placeholders, while file values are loaded only into the runtime environment', (t) => {
    const f = fixture(t);
    assert.equal(f.original[0].storeAsCreds, true);
    assert.equal(f.flows[0].storeAsCreds, false);
    assert.equal(f.flows[0].deviceKey, '${VICTRON_HP_01_DEVICEKEY}');
    assert.ok(!JSON.stringify(f.flows).includes('0123456789abcdef'));
    assert.ok(!JSON.stringify(f.flows).includes('synthetic-original-private-value'));
    assert.equal(loadEnvironment(f.options), true);
    assert.deepEqual(f.options.environment, {
        VICTRON_HP_01_DEVICEID: 'synthetic', VICTRON_HP_01_DEVICEKEY: '0123456789abcdef',
        VICTRON_HP_01_DEVICEIP: '192.168.1.53', VICTRON_HP_01_TUYAVERSION: '3.5'
    });
});

test('existing credential-based flows need no new files', (t) => {
    const f = fixture(t);
    f.write('flows.json', f.original);
    fs.unlinkSync(path.join(f.options.configDir, 'tuya-devices.json'));
    assert.equal(loadEnvironment(f.options), false);
    assert.deepEqual(f.options.environment, {});
});

test('empty IP remains literal so runtime UDP discovery does not receive an unresolved reference', (t) => {
    const f = fixture(t);
    f.original[0].deviceIp = '';
    const prepared = prepareFlows(f.original);
    assert.equal(prepared[0].deviceIp, '');
    f.write('flows.json', prepared);
    f.write('tuya-nodes.json', { 'hp-01': { deviceId: 'synthetic', deviceIp: '', tuyaVersion: '3.5' } });
    assert.equal(loadEnvironment(f.options), true);
    assert.equal(f.options.environment.VICTRON_HP_01_DEVICEIP, '');
});

test('missing keys, invalid connection settings and partial migrations fail without changing environment', (t) => {
    const f = fixture(t);
    f.write('tuya-devices.json', {});
    assert.throws(() => loadEnvironment(f.options), /private Tuya key/);
    assert.deepEqual(f.options.environment, {});
    f.write('tuya-devices.json', { synthetic: { key: '0123456789abcdef' } });
    f.write('tuya-nodes.json', { 'hp-01': { deviceId: 'synthetic', deviceIp: '999.1.1.1', tuyaVersion: '3.5' } });
    assert.throws(() => loadEnvironment(f.options), /connection settings/);
    f.flows[0].storeAsCreds = true;
    f.write('flows.json', f.flows);
    assert.throws(() => loadEnvironment(f.options), /Incomplete/);
    assert.deepEqual(f.options.environment, {});
});

test('malformed private JSON does not leak content through its error', (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.options.configDir, 'tuya-devices.json'), '{"password":"synthetic-sensitive-value",');
    assert.throws(() => loadEnvironment(f.options), (error) =>
        !error.message.includes('synthetic-sensitive-value') && /Cannot read valid/.test(error.message));
});

test('ambiguous nodes and colliding environment names are rejected', () => {
    const node = { id: 'hp-01', type: 'tuya-smart-device', deviceName: 'pump' };
    assert.throws(() => prepareFlows([node, { ...node, id: 'second' }]), /unique/);
    assert.throws(() => prepareFlows([node, { ...node, id: 'hp_01', deviceName: 'other' }]), /collision/);
});

test('private mapping preserves deployed IP/version and rejects ambiguous cloud names', () => {
    const flows = [{ id: 'hp-01', type: 'tuya-smart-device', deviceName: 'pump',
        deviceIp: '192.168.1.53', tuyaVersion: '3.5' }];
    const devices = { synthetic: { name: 'pump', key: '0123456789abcdef' } };
    assert.deepEqual(prepareNodeSettings(flows, devices), {
        'hp-01': { deviceId: 'synthetic', deviceIp: '192.168.1.53', tuyaVersion: '3.5' }
    });

    assert.throws(() => prepareNodeSettings(flows, {}), /Unique/);
    assert.throws(() => prepareNodeSettings(flows, { ...devices, second: devices.synthetic }), /Unique/);
});

test('verified Smart Life aliases map the valve and meter dashboard labels', () => {
    const flows = [
        { id: 'hp-tuya-valve-01', type: 'tuya-smart-device', deviceName: 'Boiler valve relay', tuyaVersion: '3.5' },
        { id: 'hp-tuya-meter-01', type: 'tuya-smart-device', deviceName: 'SA1 power meter (heat pump)', tuyaVersion: '3.5' }
    ];
    const mapping = prepareNodeSettings(flows, {
        valve: { name: 'Boiler' }, meter: { name: 'SA1-Wi-Fi Smart Power Transformer' }
    });
    assert.equal(mapping['hp-tuya-valve-01'].deviceId, 'valve');
    assert.equal(mapping['hp-tuya-meter-01'].deviceId, 'meter');
});
