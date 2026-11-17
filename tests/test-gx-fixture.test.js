'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildFixture, fixtureFiles, FIXTURE, FAKE_PASSWORD_HASH } = require('../tools/test-gx/build-fixture');
const { loadNode } = require('./harness');

const ROOT = path.resolve(__dirname, '..');

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
            'grep', '-l', '-F', '-e', value, 'HEAD', '--', '.',
            ':!tools/test-gx/fixture-synthetic'
        ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
        if (result.error) throw result.error;
        if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'git grep failed');
        cache.set(value, result.status === 0 ? result.stdout.trim().split(/\r?\n/).map(file =>
            file.replace(/^HEAD:/, '')) : null);
    }
    return cache.get(value);
}

test('synthetic fixture regeneration is byte-identical with no missing or stale files', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-fixture-'));
    try {
        buildFixture(temp);
        const first = readTree(temp);
        buildFixture(temp);
        assert.deepEqual(readTree(temp), first);
        assert.deepEqual(readTree(FIXTURE), first);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('fixture keeps every original function body, initializer and finalizer byte-identical', () => {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const generated = JSON.parse(fixtureFiles().get('nodered/.node-red/flows.json'));
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

test('sensitive-string scanner detects network identities and credential literals, including embedded source', () => {
    const sample = JSON.stringify({
        func: 'const password = "unapproved-production-password";\nconst host = "203.0.113.99";',
        deviceKey: 'not-an-approved-key',
        token: 'unapproved-token',
        mac: 'aa:bb:cc:dd:ee:ff',
        compactMac: 'aabbccddeeff',
        email: 'private@unapproved.invalid'
    });
    const found = candidates(sample, 'flows.json');
    for (const value of ['203.0.113.99', 'aa:bb:cc:dd:ee:ff', 'aabbccddeeff',
        'private@unapproved.invalid', 'unapproved-production-password', 'not-an-approved-key', 'unapproved-token']) {
        assert.ok(found.has(value), 'Scanner missed a required category');
    }
    const newSecret = 'never-' + require('node:crypto').randomBytes(16).toString('hex');
    assert.equal(provenance(newSecret, new Map()), null);
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

test('every fixture IP/MAC/email/token/key/password is fake or git-grep-present in non-fixture HEAD', t => {
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
