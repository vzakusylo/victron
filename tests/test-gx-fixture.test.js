'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildFixture, fixtureFiles, FIXTURE: COMMITTED_FIXTURE, FAKE_PASSWORD_HASH, TOOLS, FIXTURE_TOOLS } = require('../tools/test-gx/build-fixture');
const { verify } = require('../tools/test-gx/fixture/check');
const { assertFunctionHashes } = require('../tools/test-gx/scenario-state');
const { loadNode } = require('./harness');

require('../tools/test-gx/fixture/compose-config.test');
require('../tools/test-gx/fixture/source-selection.test');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-fixture-'));

test.before(() => buildFixture(FIXTURE));
test.after(() => fs.rmSync(FIXTURE, { recursive: true, force: true }));

function readTree(root, directory = '') {
    const files = new Map();
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            for (const [file, content] of readTree(root, name)) files.set(file, content);
        } else files.set(name, fs.readFileSync(path.join(root, name)));
    }
    return files;
}

function candidates(text, filename) {
    const found = new Set();
    for (const pattern of [
        /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        /\b(?:[a-f0-9]{2}[:-]){5}[a-f0-9]{2}\b/gi,
        /\b[a-f0-9]{12}\b/gi,
        /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi,
        /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@\s\/"'`]+@)?([a-z0-9][a-z0-9.-]*)/gi,
        /["'`]((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?=["'`:\/?#])/gi,
        /\b[a-f0-9]{24,}\b/gi,
        /['"]([a-z0-9+/_-]{32,}={0,2})['"]/gi,
        /\b(?:createSecretKey|createCipheriv|createDecipheriv|update)\(\s*(['"])([a-z0-9+/_-]{16,})\1/gi,
        /\b(?:[a-z0-9_]*(?:key|token|password|secret)|pass)\b\s*[:=]\s*(['"])([^'"\r\n]+)\1/gi
    ]) {
        for (const match of text.matchAll(pattern)) {
            found.add(match[2] || match[1] || match[0]);
        }
        if (/(?:token|key|password).*\.txt$/i.test(filename) && text.trim()) found.add(text.trim());
    }
    if (filename.endsWith('.json')) {
        const walk = (value, key = '') => {
            if (typeof value === 'string') {
                if (/(?:key|token|password|secret)|^pass$/i.test(key) && value) found.add(value);
                if (key === 'id' && /^[a-f0-9]{16}$/i.test(value)) found.add(value);
                if (/^(?:host(?:name)?|server|broker)$/i.test(key) &&
                    /^[a-z0-9][a-z0-9.-]*$/i.test(value)) found.add(value);
                // Embedded function/template source has its own string literals.
                if (value.includes('\n')) for (const candidate of candidates(value, '.js')) found.add(candidate);
            } else if (value && typeof value === 'object') {
                for (const [name, child] of Object.entries(value)) walk(child, name);
            }
        };
        walk(JSON.parse(text));
    }
    return found;
}

function fake(value) {
    return value.startsWith('test-only-') || value === FAKE_PASSWORD_HASH ||
        value === 'smtp.test.invalid';
}

function provenance(value, cache) {
    if (fake(value)) return [];
    if (!cache.has(value)) {
        const result = spawnSync('git', [
            'grep', '-l', '-F', '-e', value, 'HEAD', '--',
            'flows.json', 'tools/test-gx/transform-tuya.js', ...TOOLS.map(name => 'tools/' + name),
            ...Object.values(FIXTURE_TOOLS).map(name => 'tools/test-gx/fixture/' + name)
        ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
        if (result.error) throw result.error;
        if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'git grep failed');
        cache.set(value, result.status === 0 ? result.stdout.trim().split(/\r?\n/).map(file =>
            file.replace(/^HEAD:/, '')) : null);
    }
    return cache.get(value);
}

test('fixture regenerates committed defaults and builds byte-identical derived sources', () => {
    const first = readTree(FIXTURE);
    buildFixture(FIXTURE);
    assert.deepEqual(readTree(FIXTURE), first);
    const nonDerived = files => new Map([...files].filter(([name]) =>
        name !== 'nodered/.node-red/flows.json' && !name.startsWith('nodered/tools/')));
    assert.deepEqual(nonDerived(readTree(COMMITTED_FIXTURE)), nonDerived(first));
    for (const [name, content] of first) {
        if (name.startsWith('nodered/tools/')) {
            const tool = name.slice('nodered/tools/'.length);
            const stub = FIXTURE_TOOLS[tool];
            const expected = stub
                ? Buffer.from(fs.readFileSync(path.join(ROOT, 'tools/test-gx/fixture', stub), 'utf8').replace(/\r\n/g, '\n'))
                : fs.readFileSync(path.join(ROOT, 'tools', tool));
            assert.deepEqual(content, expected, name);
        }
    }
});

test('fixture keeps every original function body, initializer and finalizer byte-identical', () => {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const generated = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'nodered', '.node-red', 'flows.json'), 'utf8'));
    for (const node of source.filter(n => n.type === 'function')) {
        const copy = generated.find(n => n.id === node.id);
        assert.ok(copy, 'Missing function ' + node.id);
        for (const field of ['func', 'initialize', 'finalize']) {
            assert.deepEqual(Buffer.from(copy[field] || ''), Buffer.from(node[field] || ''), node.id + '.' + field);
        }
    }
    assert.equal(generated.filter(n => n.type === 'tuya-smart-device').length, 0);
    assert.ok(generated.find(n => n.id === 'hp-tuya-pump-01').func.includes('test-only-pump'));
    assert.ok(generated.filter(n => n.type === 'mqtt-broker').every(n => n.broker === 'mosquitto' && !n.usetls));
});

test('fixture proxy functions satisfy the scenario runner integrity check', () => {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const generated = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'nodered', '.node-red', 'flows.json'), 'utf8'));
    const summary = assertFunctionHashes(generated, source);
    assert.equal(summary.adapters, 4);
});

test('fixture matches only the approved node transformations', () => {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const generated = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'nodered', '.node-red', 'flows.json'), 'utf8'));
    const summary = verify(source, generated);
    assert.equal(summary.proxies, 4);
    assert.equal(summary.added, 12 + 7); // Tuya transport nodes, six accelerated tick gates and the grid pause gate.
    const gateId = 'hpa-tick-01-tick-gate';
    const gate = generated.find(node => node.id === gateId);
    assert.throws(() => verify([...source, gate], generated), /Production flows must not contain/);
    assert.throws(() => verify(source, generated.filter(node => node.id !== gateId)), /one tick gate per gated inject/);

    const mutations = [
        nodes => { nodes.find(n => n.id === source.find(s => s.type === 'function').id).func += '\n'; },
        nodes => { nodes.find(n => n.id === gateId).func += '\n'; },
        nodes => { nodes.find(n => n.id === 'hpa-tick-01').repeat = '10'; },
        nodes => { nodes.find(n => n.id === 'hp-tuya-pump-01').wires[0].push('unexpected'); },
        nodes => { nodes.find(n => n.type === 'mqtt-broker').tls = 'unexpected'; },
        nodes => { nodes.find(n => n.type === 'tab').label += ' unexpected'; },
        nodes => { nodes.push({ id: 'unexpected', type: 'function', func: '' }); }
    ];
    for (const mutate of mutations) {
        const altered = structuredClone(generated);
        mutate(altered);
        assert.throws(() => verify(source, altered), /approved flow transform/);
    }
});

test('fixture settings are explicitly test-only and dependency imports are available', () => {
    const files = fixtureFiles();
    const settings = require(path.join(FIXTURE, 'nodered', '.node-red', 'settings.js'));
    assert.match(files.get('nodered/.node-red/settings.js').toString(), /TEST GX ONLY/);
    assert.equal(settings.httpAdminRoot, '/');
    assert.deepEqual(settings.contextStorage, { default: { module: 'memory' } });
    assert.deepEqual(settings.functionGlobalContext, {});
    assert.equal(settings.functionExternalModules, true);
    assert.equal(settings.adminAuth.default.permissions, '*');
    assert.ok(fake(settings.credentialSecret));
    const manifest = JSON.parse(files.get('nodered/package.json'));
    assert.equal(manifest.dependencies.tuyapi, '7.7.1');
    assert.deepEqual(manifest.testGx.runtimeDependencySources.tuyapi, ['tools/tuya-local-sensors.js']);
    assert.ok(files.has('nodered/tools/sensor-history.js'));
    assert.ok(files.has('nodered/tools/heatpump-decode.js'));
    assert.deepEqual([...files.keys()].filter(name => name.startsWith('nodered/grid-control-logs/')),
        ['nodered/grid-control-logs/.gitkeep']);
});

test('sensitive-string scanner detects hosts, node IDs and credentials, including embedded source', () => {
    const sample = JSON.stringify({
        id: 'a1b2c3d4e5f6a7b8',
        func: 'const password = "unapproved-production-password";\nconst host = "203.0.113.99";\n' +
            'const url = "https://forecast.example.invalid/data";\nconst domain = "heating.example.invalid";\n' +
            'const websocket = "wss://socket.example.invalid/live";\n' +
            'const withUserInfo = "https://test:fake@secure.example.invalid/data";',
        deviceKey: 'not-an-approved-key',
        token: 'unapproved-token',
        mac: 'aa:bb:cc:dd:ee:ff',
        compactMac: 'aabbccddeeff',
        email: 'private@unapproved.invalid'
    });
    const found = candidates(sample, 'flows.json');
    for (const value of ['203.0.113.99', 'aa:bb:cc:dd:ee:ff', 'aabbccddeeff',
        'private@unapproved.invalid', 'unapproved-production-password', 'not-an-approved-key', 'unapproved-token',
        'forecast.example.invalid', 'heating.example.invalid', 'socket.example.invalid', 'secure.example.invalid',
        'a1b2c3d4e5f6a7b8']) {
        assert.ok(found.has(value), 'Scanner missed a required category');
    }
    const newSecret = 'never-' + require('node:crypto').randomBytes(16).toString('hex');
    assert.equal(provenance(newSecret, new Map()), null);
    assert.equal(provenance('unapproved-production-password', new Map()), null);
    assert.ok(fake('test-only-not-a-secret'));
});

test('fixture fake SMTP failure is reported by the unchanged alert function without throwing', () => {
    const files = fixtureFiles();
    const mail = JSON.parse(files.get('nodered/grid-control-config/email.json'));
    assert.equal(mail.host, 'smtp.test.invalid');
    const flows = JSON.parse(files.get('nodered/.node-red/flows.json'));
    const alerts = loadNode('fixture alerts', flows.find(n => n.name === 'Heat pump alerts').func);
    const result = alerts.run({
        topic: 'result',
        payload: JSON.stringify({ ok: false, error: 'getaddrinfo ENOTFOUND ' + mail.host })
    });
    assert.ok(result.warnings.some(warning => warning.includes('mail not sent')));
});

test('fixture startup payback defaults satisfy the unchanged statistics parser', () => {
    const files = fixtureFiles();
    const flows = JSON.parse(files.get('nodered/.node-red/flows.json'));
    const payback = loadNode('fixture payback', flows.find(n => n.name === 'Payback model').func);
    const result = payback.run({
        topic: 'read',
        payload: '@@CFG\n' + files.get('nodered/grid-control-config/payback.json') +
            '@@ELV\n' + files.get('nodered/grid-control-config/elvenett-statistics.json') + '@@END\n'
    });
    assert.deepEqual(result.warnings, []);
    assert.ok(result.result[0]);
});

test('fixture network identities, node IDs and credentials are fake or present in non-fixture HEAD', t => {
    const cache = new Map(), hits = new Set();
    let inspected = 0;
    for (const [file, content] of readTree(FIXTURE)) {
        for (const value of candidates(content.toString('utf8'), file)) {
            inspected++;
            const sources = provenance(value, cache);
            assert.notEqual(sources, null, 'Unapproved sensitive string in ' + file);
            if (sources.length) {
                const preferred = file.startsWith('nodered/tools/') ? file.slice('nodered/'.length) : 'flows.json';
                hits.add(sources.includes(preferred) ? preferred : sources[0]);
            }
        }
    }
    assert.ok(inspected > 0);
    for (const file of [...hits].sort()) t.diagnostic('already in repo: ' + file);
    t.diagnostic('Sensitive-string occurrences checked: ' + inspected);
});
