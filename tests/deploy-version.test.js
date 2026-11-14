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
    const first = stampDeployment(fixture(), { automations: AUTO });
    assert.deepEqual(record(first), { dashboard: null, automations: AUTO });
    assert.equal(first[2].name, 'Heat Pump [UI unrecorded; Auto bbbbbbbbbbbb]');
    const second = stampDeployment(first, { dashboard: UI });
    assert.deepEqual(record(second), { dashboard: UI, automations: AUTO });
    assert.equal(second[0].label, 'd#180 Grid Control [UI aaaaaaaaaaaa; Auto bbbbbbbbbbbb]');
    assert.equal(second[2].name, 'Heat Pump [UI aaaaaaaaaaaa; Auto bbbbbbbbbbbb]');
});

test('repeated stamping is idempotent and updating a component replaces rather than stacks its old label', () => {
    const first = stampDeployment(fixture(), { dashboard: UI, automations: AUTO });
    assert.deepEqual(stampDeployment(first, { dashboard: UI, automations: AUTO }), first);
    const next = stampDeployment(first, { automations: NEXT });
    assert.equal(next[0].label, 'd#180 Grid Control [UI aaaaaaaaaaaa; Auto cccccccccccc]');
    assert.equal(next[2].name, 'Heat Pump [UI aaaaaaaaaaaa; Auto cccccccccccc]');
    assert.deepEqual(record(next), { dashboard: UI, automations: NEXT });
    assert.equal(next[0].info.split('<!-- victron-deployment-source -->').length, 2);
});

test('v2 payload revision and unrelated envelope properties survive preparation for a guarded POST', () => {
    const input = { rev: 'observed-live-revision', flows: fixture(), deployment: 'nodes' };
    const output = stampDeployment(input, { dashboard: UI });
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
        assert.throws(() => stampDeployment(input, { dashboard: UI }), /metadata|SHA/);
        assert.equal(input[0].info, text);
    }
    const duplicated = stampDeployment(fixture(), { dashboard: UI });
    duplicated[0].info += duplicated[0].info;
    assert.throws(() => stampDeployment(duplicated, { dashboard: UI }), /duplicate/);
});

test('ambiguous or missing metadata targets are rejected without altering input', () => {
    const original = fixture();
    for (const input of [
        original.filter((node) => node.type !== 'ui_base'),
        [...original, { ...original[0], id: 'second-version-tab' }],
        original.filter((node) => node.type !== 'ui_tab'),
        { rev: 'live', flows: null },
        undefined
    ]) assert.throws(() => stampDeployment(input, { dashboard: UI }));
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
    const result = run(input, output, '--dashboard', UI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(input, 'utf8'), raw);
    const prepared = fs.readFileSync(output, 'utf8');
    assert.equal(JSON.parse(prepared).rev, 'live');
    assert.notEqual(run(input, output, '--automations', AUTO).status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), prepared);
    assert.notEqual(run(input, input, '--dashboard', UI).status, 0);
    assert.notEqual(run(input, path.join(dir, 'duplicate.json'), '--dashboard', UI, '--dashboard', UI).status, 0);
    assert.equal(fs.readFileSync(input, 'utf8'), raw);
});
