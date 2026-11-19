'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function exercise({ backup, inheritedBackup, inheritedFixture, badFixture, badGenerator,
    failUp, online, customOverride, thenBackup } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-source-'));
    try {
        fs.copyFileSync(path.join(ROOT, 'tools', 'test-gx', 'up.ps1'), path.join(root, 'up.ps1'));
        fs.mkdirSync(path.join(root, '.venus-docker'));
        fs.mkdirSync(path.join(root, 'fixture'));
        fs.mkdirSync(path.join(root, 'fixture-synthetic'));
        fs.mkdirSync(path.join(root, 'backup'));
        fs.writeFileSync(path.join(root, 'test_key'), '');
        fs.writeFileSync(path.join(root, 'build-fixture.js'), 'process.exit(process.env.BAD_GENERATOR ? 1 : 0);\n');
        fs.writeFileSync(path.join(root, 'fixture', 'check.js'), 'process.exit(process.env.BAD_FIXTURE ? 1 : 0);\n');
        fs.writeFileSync(path.join(root, 'fixture-synthetic', 'versions.json'),
            JSON.stringify({ nodeRed: '3.1.15', palette: { 'node-red-dashboard': '3.6.6' } }));
        fs.writeFileSync(path.join(root, 'backup', 'versions.json'),
            JSON.stringify({ nodeRed: '3.0.0', palette: { 'node-red-dashboard': '3.5.0' } }));
        const spy = path.join(root, 'docker.jsonl');
        const env = {
            ...process.env,
            TEST_GX_TEST_SCRIPT: path.join(root, 'up.ps1'),
            TEST_GX_TEST_BACKUP: path.join(root, 'backup'),
            TEST_GX_TEST_SPY: spy,
            BAD_FIXTURE: badFixture ? '1' : '',
            BAD_GENERATOR: badGenerator ? '1' : '',
            FAIL_UP: failUp ? '1' : ''
        };
        for (const key of ['TEST_GX_BACKUP', 'TEST_GX_TAG', 'TEST_GX_PALETTE', 'TEST_GX_NODERED_VERSION',
            'TEST_GX_NETWORK_INTERNAL', 'TEST_GX_FIXTURE_ONLINE', 'TEST_GX_COMPOSE_OVERRIDE',
            'TEST_GX_FIXTURE_AUTO_OVERRIDE']) delete env[key];
        if (inheritedBackup) env.TEST_GX_BACKUP = path.join(root, 'backup');
        if (inheritedFixture) env.TEST_GX_BACKUP = path.join(root, 'fixture-synthetic');
        if (online) env.TEST_GX_FIXTURE_ONLINE = '1';
        if (customOverride) env.TEST_GX_COMPOSE_OVERRIDE = path.join(root, 'custom.yml');
        const command = `
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$cmdargs)
    if ($cmdargs[0] -eq 'image') { $global:LASTEXITCODE = 0; 'existing-image'; return }
    @{ args = $cmdargs; backup = $env:TEST_GX_BACKUP; tag = $env:TEST_GX_TAG; internal = $env:TEST_GX_NETWORK_INTERNAL;
       version = $env:TEST_GX_NODERED_VERSION; palette = $env:TEST_GX_PALETTE; override = $env:TEST_GX_COMPOSE_OVERRIDE } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $env:TEST_GX_TEST_SPY
    $global:LASTEXITCODE = if ($env:FAIL_UP -and $cmdargs -contains 'up') { 1 } else { 0 }
}
function npm { $global:LASTEXITCODE = 0; 'available' }
${backup ? '& $env:TEST_GX_TEST_SCRIPT -Sim emu -Backup $env:TEST_GX_TEST_BACKUP' : '& $env:TEST_GX_TEST_SCRIPT -Sim emu'}
${thenBackup ? '& $env:TEST_GX_TEST_SCRIPT -Sim emu -Backup $env:TEST_GX_TEST_BACKUP' : ''}
`;
        const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            { env, encoding: 'utf8' });
        if (result.error) throw result.error;
        const calls = fs.existsSync(spy)
            ? fs.readFileSync(spy, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
            : [];
        return { result, calls, backupPath: path.join(root, 'backup'),
            fixtureOverride: path.join(root, 'docker-compose.fixture.yml'), customOverride: path.join(root, 'custom.yml') };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('up.ps1 selects the fixture when TEST_GX_BACKUP is unset', () => {
    const { result, calls, fixtureOverride } = exercise();
    assert.equal(result.status, 0, result.stderr);
    const up = calls.find(call => call.args.includes('up'));
    assert.ok(up);
    assert.ok(!up.backup);
    assert.equal(up.tag, 'fixture-synthetic');
    assert.equal(up.version, '3.1.15');
    assert.ok(!up.palette);
    assert.equal(up.override, fixtureOverride);
    assert.ok(up.args.includes(fixtureOverride));
    assert.ok(calls.find(call => call.args.includes('down')).args.includes(fixtureOverride));
});

test('a fixture path inherited as TEST_GX_BACKUP stays isolated', () => {
    const { result, calls, fixtureOverride } = exercise({ inheritedFixture: true });
    assert.equal(result.status, 0, result.stderr);
    const up = calls.find(call => call.args.includes('up'));
    assert.ok(!up.backup);
    assert.equal(up.override, fixtureOverride);
});

test('up.ps1 honors explicit and inherited backup sources', () => {
    for (const options of [{ backup: true }, { inheritedBackup: true }]) {
        const { result, calls, backupPath } = exercise(options);
        assert.equal(result.status, 0, result.stderr);
        const up = calls.find(call => call.args.includes('up'));
        assert.equal(up.backup, backupPath);
        assert.equal(up.tag, 'backup');
        assert.equal(up.version, '3.0.0');
        assert.ok(!up.override);
    }
});

test('fixture cannot be started online', () => {
    const { result, calls } = exercise({ online: true });
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 0);
    assert.match(result.stderr, /fixture cannot run online/i);
});

test('switching from fixture to backup removes the automatic fixture override', () => {
    const { result, calls } = exercise({ thenBackup: true });
    assert.equal(result.status, 0, result.stderr);
    const ups = calls.filter(call => call.args.includes('up'));
    assert.equal(ups.length, 2);
    assert.ok(ups[0].override);
    assert.ok(!ups[1].override);
});

test('an explicit backup override is honored, while conflicting fixture overrides fail before cleanup', () => {
    const backup = exercise({ backup: true, customOverride: true });
    assert.equal(backup.result.status, 0, backup.result.stderr);
    const up = backup.calls.find(call => call.args.includes('up'));
    assert.equal(up.override, backup.customOverride);
    assert.ok(up.args.includes(backup.customOverride));
    const fixture = exercise({ customOverride: true });
    assert.notEqual(fixture.result.status, 0);
    assert.equal(fixture.calls.length, 0);
    assert.match(fixture.result.stderr, /Unset TEST_GX_COMPOSE_OVERRIDE/);
});

test('up.ps1 refuses a stale fixture before deleting the volume and reports a failed build', () => {
    const stale = exercise({ badFixture: true });
    assert.notEqual(stale.result.status, 0);
    assert.equal(stale.calls.length, 0);
    const generator = exercise({ badGenerator: true });
    assert.notEqual(generator.result.status, 0);
    assert.equal(generator.calls.length, 0);
    const failed = exercise({ failUp: true });
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /Could not build or start Test GX/);
});
