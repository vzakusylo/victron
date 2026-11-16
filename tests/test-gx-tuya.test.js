const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { loadNode } = require('./harness.js');
const { transformTuya, DEVICES } = require('../tools/test-gx/transform-tuya.js');
const { validateTransformation, transformLiveSnapshot } = require('../tools/test-gx/tuya-compare.js');
const { snapshot } = require('../tools/gx/live-snapshot.js');
const { diffSnapshots } = require('../tools/gx/compare.js');

const original = [
    { id: 'broker', type: 'mqtt-broker', broker: 'mosquitto', port: '1883', usetls: false },
    ...Object.entries(DEVICES).map(([id, device]) => ({
        id, type: 'tuya-smart-device', z: 'tab', name: device,
        deviceId: 'fake-' + device, deviceKey: 'not-for-proxy', deviceIp: '192.168.1.94',
        wires: [[device + '-topic'], [device + '-topic']], eventMode: 'event-both',
    })),
    { id: 'untouched', type: 'function', func: 'return msg;', wires: [[]] },
];
const transformed = () => transformTuya(original);

test('Tuya transformation preserves IDs and two output wires, strips native device config and is deterministic', () => {
    const a = transformed();
    assert.deepEqual(a, transformed());
    assert.equal(a.transformed.length, 16);
    assert.equal(a.flows.filter(n => n.type === 'tuya-smart-device').length, 0);
    for (const [id, device] of Object.entries(DEVICES)) {
        const proxy = a.flows.find(n => n.id === id);
        assert.equal(proxy.type, 'function');
        assert.equal(proxy.outputs, 3);
        assert.deepEqual(proxy.wires.slice(0, 2), original.find(n => n.id === id).wires);
        assert.deepEqual(proxy.wires[2], [id + '-mqtt-out']);
        assert.ok(!('deviceKey' in proxy) && !('deviceIp' in proxy));
        assert.ok(!proxy.func.includes('192.168.1.94') && !proxy.func.includes('not-for-proxy'));
        for (const kind of ['data', 'state']) {
            const input = a.flows.find(n => n.id === id + '-mqtt-' + kind);
            assert.equal(input.topic, 'tuya/' + device + '/' + kind);
            assert.deepEqual(input.wires, [[id]]);
        }
    }
    assert.deepEqual(a.flows.find(n => n.id === 'untouched'), original.at(-1));
    assert.deepEqual(original[1].wires, [['pump-topic'], ['pump-topic']]);
    assert.throws(() => transformTuya([...original, { id: 'new-tuya', type: 'tuya-smart-device' }]), /Unmodelled/);
    assert.throws(() => transformTuya([...original, { id: 'hp-tuya-pump-01-mqtt-out', type: 'function' }]), /collision/);
    assert.throws(() => transformTuya(original.map(n => n.type === 'mqtt-broker' ? { ...n, broker: '192.168.1.94' } : n)), /mosquitto/);
    assert.throws(() => transformTuya(original.map(n => n.id === 'hp-tuya-pump-01' ? { ...n, deviceId: '${UNRESOLVED}' } : n)), /Unresolved/);
});

test('generated proxy sends GET/SET to output 3 and actual palette data/status envelopes to outputs 1/2', () => {
    const proxy = transformed().flows.find(n => n.id === 'hp-tuya-pump-01');
    const node = loadNode('proxy', proxy.func);
    for (const payload of [{ operation: 'GET', schema: true }, { operation: 'SET', dps: 133, set: 37 },
        { operation: 'SET', multiple: true, data: { 132: '1', 134: 4 } }]) {
        const out = node.run({ payload }).result;
        assert.equal(out[0], null);
        assert.equal(out[1], null);
        assert.equal(out[2].topic, 'tuya/pump/command');
        assert.deepEqual(JSON.parse(out[2].payload), payload);
    }
    const payload = { dps: { 108: 46 }, t: 123 };
    for (const data of [payload, JSON.stringify(payload), Buffer.from(JSON.stringify(payload))]) {
        assert.deepEqual(node.run({ topic: 'tuya/pump/data', payload: data }).result, [
            { payload: { data: payload, deviceId: 'fake-pump', deviceName: 'pump' } }, null, null,
        ]);
    }
    for (const state of ['CONNECTED', 'DISCONNECTED', 'ERROR']) {
        assert.deepEqual(node.run({ topic: 'tuya/pump/state', payload: { state } }).result,
            [null, { payload: { state } }, null]);
    }
    const bad = node.run({ topic: 'tuya/pump/data', payload: { dps: null } });
    assert.equal(bad.result, null);
    assert.ok(bad.warnings.length);
});

test('comparison normalizes only deterministic manifest IDs and still detects altered wires/code or unrelated nodes', () => {
    const a = transformed();
    validateTransformation(original, a.flows, {}, a.transformed);
    assert.throws(() => validateTransformation(original, a.flows, {}, [...a.transformed, { id: 'untouched' }]), /manifest/);
    const expected = snapshot(a.flows, null, { raw: true });
    const normalize = f => transformLiveSnapshot(snapshot(f, null, { raw: true }), {}, a.transformed);
    assert.deepEqual(diffSnapshots(normalize(original), expected).config, []);
    assert.deepEqual(diffSnapshots(normalize(original), expected).code, []);
    const altered = structuredClone(original);
    altered[1].wires[0] = ['wrong'];
    assert.ok(diffSnapshots(normalize(altered), expected).config.some(n => n.id === altered[1].id));
    altered.at(-1).func = 'return null;';
    assert.ok(diffSnapshots(normalize(altered), expected).code.some(n => n.id === 'untouched'));
    altered[0].clientid = 'unexpected-client';
    assert.ok(diffSnapshots(normalize(altered), expected).config.some(n => n.id === 'broker'));
    const changedImage = structuredClone(a.flows);
    changedImage.find(n => n.id === 'hp-tuya-pump-01').func = 'return msg;';
    assert.throws(() => validateTransformation(original, changedImage, {}, a.transformed), /differs/);
    assert.ok(diffSnapshots(transformLiveSnapshot(snapshot(changedImage, null, { raw: true }), {}, a.transformed), expected).code.length);
});

test('compare-image --live without --map warns rather than throwing for the production localhost broker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-live-no-map-'));
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: '3.1.15' }));
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const a = transformed();
        fs.mkdirSync(path.join(root, 'nodered', '.node-red'), { recursive: true });
        fs.writeFileSync(path.join(root, 'nodered', '.node-red', 'flows.json'), JSON.stringify(a.flows));
        fs.writeFileSync(path.join(root, 'tuya-source-flows.json'), JSON.stringify(original));
        fs.writeFileSync(path.join(root, 'sanitize-report.json'), JSON.stringify({ transformed: a.transformed }));
        fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify({ nodeRed: '3.1.15', palette: {} }));
        const live = structuredClone(original);
        live[0].broker = '127.0.0.1';
        const encode = f => zlib.gzipSync(JSON.stringify(snapshot(f, null, { raw: true }))).toString('base64');
        const liveFile = path.join(root, 'live.b64');
        fs.writeFileSync(liveFile, encode(live));
        const preload = path.join(root, 'mock-transport.js');
        fs.writeFileSync(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
    const value = load.call(this, name, ...args);
    if (name !== 'child_process') return value;
    return { ...value, spawnSync(command, args) {
        if (command === 'ssh') return { status: 0, stdout: args[1].includes('node -') ? ${JSON.stringify(encode(a.flows))} : args[1].includes('npm ls') ? '{"dependencies":{}}' : '' };
        if (command === 'docker') return { status: 0, stdout: '' };
        throw new Error('Unexpected transport command: ' + command);
    }};
};`);
        const result = await new Promise(resolve => require('node:child_process').execFile(process.execPath,
            ['--require', preload, path.join(__dirname, '..', 'tools', 'test-gx', 'compare-image.js'),
                '--backup', root, '--live', liveFile, '--api', 'http://127.0.0.1:' + server.address().port],
            (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
        assert.equal(result.code, 1, result.stderr); // Raw, unmapped differences are still fatal; the comparison itself completed.
        assert.match(result.stdout, /WARN\s+Tuya proxy\s+no --map: skipping live Tuya transformation/);
        assert.match(result.stdout, /DIFF\s+flow: image vs live GX/);
        assert.match(result.stdout, /STATUS:/);
        assert.doesNotMatch(result.stderr, /compare-image failed|Tuya proxy requires/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Tuya model validates atomic SETs, answers GETs, routes heat, and supports stale/offline/invalid without invalid JSON', () => {
    const script = `
import sys, json, base64
sys.path.insert(0, sys.argv[1])
from tuya_devices import TuyaDevices
published, writes = [], []
model = TuyaDevices(lambda t,p: published.append((t,p)), writes.append)
model.command('pump', {'operation':'GET', 'schema':True})
assert writes[-1]['operation'] == 'GET'
assert published[-1][0] == 'tuya/pump/data' and published[-1][1]['dps']['108'] == 46
model.command('pump', {'operation':'SET', 'dps':133, 'set':37})
assert model.devices['pump']['dps']['133'] == 37 and writes[-1]['applied']
before = model.devices['pump']['dps'].copy()
try: model.command('pump', {'operation':'SET','multiple':True,'data':{'133':30,'134':999}})
except ValueError: pass
else: raise AssertionError('invalid batch accepted')
assert model.devices['pump']['dps'] == before
model.command('pump', {'operation':'SET','multiple':True,'data':{'133':38,'134':4}})
assert [w['dps'] for w in writes[-2:]] == ['133','134']
model.tick(1)
raw = base64.b64decode(model.devices['meter']['dps']['6'])
assert len(raw) == 8 and int.from_bytes(raw[5:8], 'big') == model.power_w > 0
model.set('pump', '108', 25)
model.command('valve', {'operation':'SET','set':True})
model.tick(1)
assert model.devices['pump']['dps']['108'] > 25
model.command('bypass', {'operation':'SET','set':True})
tank = model.devices['pump']['dps']['108']
model.tick(1)
assert model.devices['pump']['dps']['108'] == tank
model.stale('pump')
published.clear()
model.command('pump', {'operation':'GET'})
model.tick(1)
assert not any(t.startswith('tuya/pump/') for t,p in published)
model.fail('pump','ok')
model.fail('pump','offline')
assert published[-1] == ('tuya/pump/state', {'state':'DISCONNECTED'})
model.command('pump', {'operation':'SET','dps':1,'set':False})
assert not writes[-1]['applied'] and model.devices['pump']['dps']['1'] is True
model.fail('pump','invalid')
assert published[-1][1]['dps']['108'] == -127 and published[-1][1]['dps']['112'] is None
json.dumps(published, allow_nan=False)
for value in [float('nan'), True, 999]:
    try: model.set('pump','108',value)
    except ValueError: pass
    else: raise AssertionError('invalid sensor value accepted')
model.fail('pump','ok')
model.error('pump')
assert published[-1] == ('tuya/pump/state', {'state':'ERROR'})
model.announce('pump')
assert published[-2] == ('tuya/pump/state', {'state':'CONNECTED'})
model.command('pump', {'operation':'SET','dps':1,'set':False})
model.tick(1)
assert model.power_w == 0 and model.devices['pump']['dps']['115'] == 0
`;
    execFileSync(process.platform === 'win32' ? 'py' : 'python3',
        ['-B', '-c', script, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator')], { stdio: 'pipe' });
});
