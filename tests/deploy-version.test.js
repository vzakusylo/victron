'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampDeployment } = require('../tools/deploy-version');

const UI = 'a'.repeat(40);
const AUTO = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);

function fixture() {
    return [
        { id: 'flow', type: 'tab', label: 'd#180 Grid Control', info: 'Existing notes' },
        { id: 'base', type: 'ui_base', site: { name: 'Node-RED Dashboard', lockMenu: 'false' }, theme: { name: 'light' } },
        { id: 'page', type: 'ui_tab', name: 'Heat Pump', order: 1 },
        { id: 'other-page', type: 'ui_tab', name: 'Automations', order: 2, hidden: true },
        { id: 'controller', type: 'function', func: 'return msg;', wires: [['device']] },
        { id: 'device', type: 'tuya-smart-device', deviceKey: '${PRIVATE_KEY}', credentials: { encrypted: 'synthetic' } }
    ];
}

function record(flows) {
    const info = flows[0].info;
    return JSON.parse(info.slice(info.indexOf('-->') + 3, info.lastIndexOf('<!--')));
}

test('same-source deployment labels the editor and visible dashboard pages without changing logic or credentials', () => {
    const input = fixture();
    const original = structuredClone(input);
    const output = stampDeployment(input, { dashboard: UI, automations: UI });
    assert.deepEqual(input, original);
    assert.equal(output[0].label, 'd#180 Grid Control [git aaaaaaaaaaaa]');
    assert.equal(output[1].site.name, 'Node-RED Dashboard [git aaaaaaaaaaaa]');
    assert.equal(output[2].name, 'Heat Pump [git aaaaaaaaaaaa]');
    assert.equal(output[3].name, 'Automations [git aaaaaaaaaaaa]');
    assert.deepEqual(record(output), { dashboard: UI, automations: UI });
    assert.ok(output[0].info.startsWith('Existing notes\n\n'));
    assert.deepEqual(output.slice(4), original.slice(4));
    assert.deepEqual(output[1].theme, original[1].theme);
    assert.equal(output[1].site.lockMenu, 'false');
});

test('partial deployments retain the other component source and explicitly mark unrecorded live code', () => {
    const live = fixture();
    const first = stampDeployment(live, { automations: AUTO }, live);
    assert.deepEqual(record(first), { dashboard: null, automations: AUTO });
    assert.equal(first[2].name, 'Heat Pump [UI unrecorded; Auto bbbbbbbbbbbb]');
    const second = stampDeployment(first, { dashboard: UI }, first);
    assert.deepEqual(record(second), { dashboard: UI, automations: AUTO });
    assert.equal(second[0].label, 'd#180 Grid Control [UI aaaaaaaaaaaa; Auto bbbbbbbbbbbb]');
    assert.equal(second[2].name, 'Heat Pump [UI aaaaaaaaaaaa; Auto bbbbbbbbbbbb]');
});

test('replacing the live version tab with a bumped repo tab preserves the other SHA from the original live snapshot', () => {
    const live = { rev: 'same-live-revision', flows: stampDeployment(fixture(), { dashboard: UI, automations: AUTO }) };
    const original = structuredClone(live);
    for (const scope of ['dashboard', 'automations']) {
        const patched = structuredClone(live);
        patched.flows[0] = { ...fixture()[0], label: 'd#181 Grid Control', info: 'Repository notes' };
        const output = stampDeployment(patched, { [scope]: NEXT }, live);
        const expected = { dashboard: UI, automations: AUTO, [scope]: NEXT };
        assert.deepEqual(record(output.flows), expected);
        assert.ok(output.flows[0].label.startsWith('d#181 Grid Control'));
        assert.ok(output.flows[0].info.startsWith('Repository notes\n\n'));
        assert.equal(output.rev, live.rev);
        assert.equal(patched.flows[0].info, 'Repository notes');
        assert.deepEqual(live, original);
    }
});

test('partial deployments fail without a live snapshot and reject wrong or corrupted live provenance', () => {
    const input = { rev: 'live-revision', flows: fixture() };
    assert.throws(() => stampDeployment(input, { dashboard: UI }), /original live flow snapshot/);
    const wrongId = structuredClone(input);
    wrongId.flows[0].id = 'other-system-tab';
    const corrupted = structuredClone(input);
    corrupted.flows[0].info = '<!-- victron-deployment-source -->bad JSON<!-- /victron-deployment-source -->';
    for (const live of [
        { ...input, rev: 'different-live-revision' },
        wrongId,
        corrupted
    ]) assert.throws(() => stampDeployment(input, { dashboard: UI }, live), /revision|tab ID|metadata/);
    assert.equal(input.flows[0].info, 'Existing notes');
});

test('repeated stamping is idempotent and updating a component replaces rather than stacks its old label', () => {
    const first = stampDeployment(fixture(), { dashboard: UI, automations: AUTO });
    assert.deepEqual(stampDeployment(first, { dashboard: UI, automations: AUTO }), first);
    const next = stampDeployment(first, { automations: NEXT }, first);
    assert.equal(next[0].label, 'd#180 Grid Control [UI aaaaaaaaaaaa; Auto cccccccccccc]');
    assert.equal(next[2].name, 'Heat Pump [UI aaaaaaaaaaaa; Auto cccccccccccc]');
    assert.deepEqual(record(next), { dashboard: UI, automations: NEXT });
    assert.equal(next[0].info.split('<!-- victron-deployment-source -->').length, 2);
});

test('v2 payload revision and unrelated envelope properties survive preparation for a guarded POST', () => {
    const input = { rev: 'observed-live-revision', flows: fixture(), deployment: 'nodes' };
    const output = stampDeployment(input, { dashboard: UI }, input);
    assert.equal(output.rev, input.rev);
    assert.equal(output.deployment, 'nodes');
    assert.deepEqual(record(output.flows), { dashboard: UI, automations: null });
    assert.equal(input.flows[0].label, 'd#180 Grid Control');
});

test('invalid sources and damaged existing metadata fail rather than fabricate deployment provenance', () => {
    for (const commits of [{}, { dashboard: UI.slice(0, 12) }, { automations: null }, { unknown: UI }, { dashboard: 'x'.repeat(40) }]) {
        assert.throws(() => stampDeployment(fixture(), commits), /source|SHA/);
    }
    for (const text of [
        '<!-- victron-deployment-source -->',
        '<!-- victron-deployment-source -->bad JSON<!-- /victron-deployment-source -->',
        '<!-- victron-deployment-source -->{}<!-- /victron-deployment-source -->',
        '<!-- victron-deployment-source -->{"dashboard":"short","automations":null}<!-- /victron-deployment-source -->'
    ]) {
        const input = fixture();
        input[0].info = text;
        assert.throws(() => stampDeployment(input, { dashboard: UI }, fixture()), /metadata|SHA/);
        assert.equal(input[0].info, text);
    }
    const duplicated = stampDeployment(fixture(), { dashboard: UI, automations: UI });
    duplicated[0].info += duplicated[0].info;
    assert.throws(() => stampDeployment(duplicated, { dashboard: UI }, fixture()), /duplicate/);
});

test('ambiguous or missing metadata targets are rejected without altering input', () => {
    const original = fixture();
    for (const input of [
        original.filter((node) => node.type !== 'ui_base'),
        [...original, { ...original[0], id: 'second-version-tab' }],
        original.filter((node) => node.type !== 'ui_tab'),
        { rev: 'live', flows: null },
        undefined
    ]) assert.throws(() => stampDeployment(input, { dashboard: UI }, original));
    assert.equal(original[0].label, 'd#180 Grid Control');
});

test('CLI creates only a separate output and refuses replacement or duplicate source arguments', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victron-deploy-version-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'input.json');
    const output = path.join(dir, 'output.json');
    const raw = JSON.stringify({ rev: 'live', flows: fixture() });
    fs.writeFileSync(input, raw);
    const script = path.resolve(__dirname, '..', 'tools', 'deploy-version.js');
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const result = run(input, output, '--dashboard', UI, '--live', input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(input, 'utf8'), raw);
    const prepared = fs.readFileSync(output, 'utf8');
    assert.equal(JSON.parse(prepared).rev, 'live');
    const replacement = run(input, output, '--automations', AUTO, '--live', input);
    assert.notEqual(replacement.status, 0);
    assert.match(replacement.stderr, /EEXIST/);
    assert.equal(fs.readFileSync(output, 'utf8'), prepared);
    assert.notEqual(run(input, input, '--dashboard', UI).status, 0);
    assert.notEqual(run(input, path.join(dir, 'duplicate.json'), '--dashboard', UI, '--dashboard', UI).status, 0);
    assert.equal(fs.readFileSync(input, 'utf8'), raw);
});

test('CLI reads previous component metadata from --live, not the replaced repo tab', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victron-deploy-version-live-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = { rev: 'live', flows: stampDeployment(fixture(), { dashboard: UI, automations: AUTO }) };
    const patched = structuredClone(live);
    patched.flows[0] = { ...fixture()[0], label: 'd#181 Grid Control', info: 'Repo tab' };
    const liveFile = path.join(dir, 'live.json');
    const input = path.join(dir, 'patched.json');
    const output = path.join(dir, 'output.json');
    const original = JSON.stringify(live);
    fs.writeFileSync(liveFile, original);
    fs.writeFileSync(input, JSON.stringify(patched));
    const script = path.resolve(__dirname, '..', 'tools', 'deploy-version.js');
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const missingLive = run(input, output, '--dashboard', NEXT);
    assert.notEqual(missingLive.status, 0);
    assert.match(missingLive.stderr, /original live flow snapshot/);
    assert.equal(fs.existsSync(output), false);
    const result = run(input, output, '--dashboard', NEXT, '--live', liveFile);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(record(JSON.parse(fs.readFileSync(output, 'utf8')).flows), { dashboard: NEXT, automations: AUTO });
    assert.equal(fs.readFileSync(liveFile, 'utf8'), original);
    assert.equal(fs.readFileSync(input, 'utf8'), JSON.stringify(patched));
});
