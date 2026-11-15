'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { snapshot } = require('../tools/gx/live-snapshot.js');
const { diffSnapshots } = require('../tools/gx/compare.js');
const { applyMap, parseMap } = require('../tools/test-gx/live-map.js');

const DEVICE = 'bf1234567890abcdef12ab';
const IP = '192.168.1.50';
const MAIL = 'owner@gmail.com';
const FLOW = [
    { id: 't1', type: 'tab', label: 'grid' },
    { id: 'f1', type: 'function', z: 't1', name: 'tuya', x: 1, y: 2, wires: [[]],
        func: "const dev = '" + DEVICE + "'; const ip = '" + IP + "'; return { payload: dev + ip };" },
    { id: 'c1', type: 'tuya-config', z: 't1', devices: { [DEVICE]: { ip: IP, notify: MAIL } }, wires: [] },
];

function build(flow = FLOW) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-map-'));
    const nr = path.join(root, 'raw', 'data', 'home', 'nodered');
    fs.mkdirSync(path.join(nr, '.node-red'), { recursive: true });
    fs.mkdirSync(path.join(nr, 'grid-control-config'), { recursive: true });
    fs.writeFileSync(path.join(nr, '.node-red', 'flows.json'), JSON.stringify(flow));
    fs.writeFileSync(path.join(nr, '.node-red', 'package.json'), '{"dependencies":{}}');
    fs.writeFileSync(path.join(nr, '.node-red', 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(nr, '.node-red', '.config.nodes.json'), '{"node-red":{"name":"node-red","version":"4.0.0"}}');
    fs.writeFileSync(path.join(nr, 'grid-control-config', 'tuya-devices.json'),
        JSON.stringify({ devices: { [DEVICE]: { ip: IP, key: 'supersecretkey1', notify: MAIL } } }));
    const tarball = path.join(root, 'backup.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', path.join(root, 'raw'), 'data']);
    const out = path.join(root, 'sanitized', 'fake-backup');
    fs.mkdirSync(path.dirname(out));
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'test-gx', 'sanitize-backup.js'), tarball, out, '--no-logs'], { encoding: 'utf8' });
    return { root, out, backup: tarball, run, mapFile: out + '.map.json' };
}

test('sanitizer writes the map beside the tree, never inside it, and the report has counts only', () => {
    const { root, out, run, mapFile } = build();
    try {
        assert.strictEqual(run.status, 0, run.stderr + run.stdout);
        assert.ok(fs.existsSync(mapFile));
        const found = [];
        (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : found.push(p); } })(out);
        assert.ok(!found.some((p) => /\.map\.json$/.test(p)), 'map file inside the tree that goes to Docker');
        const report = fs.readFileSync(path.join(out, 'sanitize-report.json'), 'utf8');
        for (const v of [DEVICE, IP, MAIL]) assert.ok(!report.includes(v) && !run.stdout.includes(v));
        const pairs = parseMap(fs.readFileSync(mapFile, 'utf8'));
        assert.deepStrictEqual(pairs.map((p) => p.kind).sort(), ['email', 'id', 'ip', 'secret']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live snapshot of the original flow: 0 DIFF with the map, DIFF without it', () => {
    const { root, out, run, mapFile } = build();
    try {
        assert.strictEqual(run.status, 0, run.stderr);
        const image = snapshot(JSON.parse(fs.readFileSync(path.join(out, 'nodered', '.node-red', 'flows.json'), 'utf8')), 'r1');
        const live = snapshot(FLOW, 'r1', { raw: true });
        const total = (d) => Object.values(d).reduce((n, list) => n + list.length, 0);
        assert.ok(total(diffSnapshots(live, image)) > 0, 'without the map the rewritten nodes must differ');
        const mapped = applyMap(live, parseMap(fs.readFileSync(mapFile, 'utf8')));
        assert.deepStrictEqual(diffSnapshots(mapped.snapshot, image), { onlyLive: [], onlyRepo: [], code: [], trailing: [], config: [] });
        assert.deepStrictEqual(mapped.unmapped, {});
        assert.strictEqual(mapped.restMissing, 0);
        assert.ok(mapped.replaced.id >= 2 && mapped.replaced.ip >= 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a device added on the GX after the backup is reported as not in map', () => {
    const { root, run, mapFile } = build();
    try {
        assert.strictEqual(run.status, 0, run.stderr);
        const flow = FLOW.concat([{ id: 'f2', type: 'function', z: 't1', func: "const other = 'bf9999999999abcdef34cd'; const ip = '192.168.1.77';" }]);
        const mapped = applyMap(snapshot(flow, 'r1', { raw: true }), parseMap(fs.readFileSync(mapFile, 'utf8')));
        assert.deepStrictEqual(mapped.unmapped, { id: 1, ip: 1 });
        const image = snapshot([{ id: 'f9', type: 'function', func: "// LAN example 192.168.1.77" }], 'r1');
        const again = applyMap(snapshot(flow, 'r1', { raw: true }), parseMap(fs.readFileSync(mapFile, 'utf8')), image);
        assert.deepStrictEqual(again.unmapped, { id: 1 }, 'a value the image already has unchanged is not new');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Qingping MAC aliases and MQTT test endpoint map consistently without hiding other broker changes', () => {
    const flow = FLOW.concat([
        { id: 'air', type: 'function', func: "const AIR = { mac: 'AABBCCDDEEFF' }; // AA:BB:CC:DD:EE:FF" },
        { id: 'mqtt', type: 'mqtt-broker', broker: '192.168.1.94', port: '8883', usetls: true, tls: 'real-tls', clientid: 'test-client' },
    ]);
    const { root, out, run, mapFile } = build(flow);
    try {
        assert.strictEqual(run.status, 0, run.stderr);
        const imageFlow = JSON.parse(fs.readFileSync(path.join(out, 'nodered', '.node-red', 'flows.json'), 'utf8'));
        const broker = imageFlow.find((n) => n.id === 'mqtt');
        assert.deepStrictEqual([broker.broker, broker.port, broker.usetls, broker.tls], ['mosquitto', '1883', false, '']);
        const pairs = parseMap(fs.readFileSync(mapFile, 'utf8'));
        const macs = pairs.filter((p) => p.kind === 'mac');
        assert.strictEqual(macs.length, 2);
        assert.strictEqual(macs[0].to.replace(/:/g, '').toUpperCase(), macs[1].to.replace(/:/g, '').toUpperCase());
        assert.match(macs[0].to.replace(/:/g, ''), /^0200/i);
        const baseline = snapshot(imageFlow, 'r1', { raw: true });
        const mapped = applyMap(snapshot(flow, 'r1', { raw: true }), pairs, baseline);
        assert.deepStrictEqual(diffSnapshots(mapped.snapshot, baseline), { onlyLive: [], onlyRepo: [], code: [], trailing: [], config: [] });
        assert.deepStrictEqual(mapped.unmapped, {}, 'the deliberately redirected broker is not a new unmapped device');
        const changed = flow.map((n) => n.id === 'mqtt' ? { ...n, clientid: 'changed-client' } : n);
        assert.strictEqual(diffSnapshots(applyMap(snapshot(changed, 'r1', { raw: true }), pairs, baseline).snapshot, baseline).config.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a snapshot without --raw is flagged: its config hashes cannot be mapped', () => {
    const mapped = applyMap(snapshot(FLOW, 'r1'), [{ from: DEVICE, to: 'afake', kind: 'id' }]);
    assert.strictEqual(mapped.restMissing, FLOW.length);
});

test('a file that is not a map is rejected', () => {
    assert.throws(() => parseMap('{"pairs":[]}'), /not a test-gx-map-v1 file/);
});

test('sanitizer refuses a foreign map before deleting the existing output tree', () => {
    const { root, out, backup, mapFile } = build();
    try {
        assert.ok(fs.existsSync(path.join(out, 'nodered', '.node-red', 'flows.json')));
        const flows = fs.readFileSync(path.join(out, 'nodered', '.node-red', 'flows.json'), 'utf8');
        fs.writeFileSync(mapFile, '{"format":"someone-elses-file"}');
        const refused = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'test-gx', 'sanitize-backup.js'), backup, out, '--no-logs'], { encoding: 'utf8' });
        assert.strictEqual(refused.status, 64);
        assert.match(refused.stderr, /refusing to overwrite/);
        assert.strictEqual(fs.readFileSync(path.join(out, 'nodered', '.node-red', 'flows.json'), 'utf8'), flows);
        assert.strictEqual(fs.readFileSync(mapFile, 'utf8'), '{"format":"someone-elses-file"}');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
