'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const cwd = path.join(ROOT, 'tools', 'test-gx');

function config({ fixture = false, backup } = {}) {
    const env = { ...process.env };
    for (const key of ['TEST_GX_BACKUP', 'TEST_GX_TAG', 'TEST_GX_PALETTE', 'TEST_GX_NODERED_VERSION',
        'TEST_GX_SIM', 'COMPOSE_FILE', 'COMPOSE_PROFILES']) delete env[key];
    if (backup) env.TEST_GX_BACKUP = backup;
    const args = ['compose', '-p', 'test-gx-config-test', '-f', 'docker-compose.yml'];
    if (fixture) args.push('-f', 'docker-compose.fixture.yml');
    args.push('config', '--format', 'json');
    const result = spawnSync('docker', args, { cwd, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
}

test('bare Compose requires a backup before starting any services', { skip: !composeAvailable }, () => {
    const result = config();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SET_TEST_GX_BACKUP_OR_USE_FIXTURE_OVERRIDE/);
});

test('backup Compose keeps the original services and localhost ports', { skip: !composeAvailable }, () => {
    const backup = path.join(cwd, 'example-backup');
    const result = config({ backup });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed.services).sort(), ['mosquitto', 'nodered', 'venus']);
    assert.notEqual(parsed.networks.default.internal, true);
    const ports = ['nodered', 'venus'].flatMap(name => parsed.services[name].ports);
    assert.deepEqual(ports.map(port => Number(port.published)).sort((a, b) => a - b),
        [1881, 2222, 3000, 8080, 8081]);
    assert.ok(ports.every(port => port.host_ip === '127.0.0.1'));
    assert.equal(parsed.services.nodered.image, 'test-gx-nodered:local');
    assert.equal(parsed.services.nodered.build.additional_contexts.backup, backup);
});

test('fixture override isolates the stack and exposes only the five gateway ports', { skip: !composeAvailable }, () => {
    const result = config({ fixture: true });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const gateway = parsed.services['fixture-gateway'];
    assert.equal(parsed.networks.default.internal, true);
    assert.equal(parsed.services.nodered.build.additional_contexts.backup, path.join(cwd, 'fixture-synthetic'));
    for (const name of ['nodered', 'venus', 'mosquitto']) {
        assert.deepEqual(Object.keys(parsed.services[name].networks), ['default']);
    }
    assert.ok(!parsed.services.nodered.ports);
    assert.ok(!parsed.services.venus.ports);
    assert.deepEqual(Object.keys(gateway.networks).sort(), ['default', 'fixture-ingress']);
    assert.deepEqual(gateway.ports.map(port => Number(port.published)).sort((a, b) => a - b),
        [1881, 2222, 3000, 8080, 8081]);
    assert.ok(gateway.ports.every(port => port.host_ip === '127.0.0.1'));
    assert.match(gateway.image, /^alpine\/socat:1\.8\.0\.3@sha256:/);
});

test('the isolation override retains an explicitly selected backup source', { skip: !composeAvailable }, () => {
    const backup = path.join(cwd, 'example-backup');
    const result = config({ fixture: true, backup });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.services.nodered.build.additional_contexts.backup, backup);
    assert.equal(parsed.networks.default.internal, true);
});
