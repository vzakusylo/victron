'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const check = dir => spawnSync(process.execPath, [path.join(dir, 'tools', 'flows.js'), 'check'], { encoding: 'utf8' });

test('repository flow has no unapproved unwired inputs', () => {
    const result = check(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('flows check rejects unwired inputs and injects but accepts a wired inject', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-check-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'tools'));
    for (const file of ['flows.js', 'includes.js']) {
        fs.copyFileSync(path.join(root, 'tools', file), path.join(dir, 'tools', file));
    }
    const flows = [
        { id: 'tab', type: 'tab', label: 'd#1 Test' },
        { id: 'sink', type: 'debug', z: 'tab', wires: [] },
        { id: 'wired', type: 'inject', z: 'tab', wires: [[], ['sink']] },
        { id: 'unused-inject', type: 'inject', z: 'tab', wires: [[]] },
        { id: 'unused-battery', type: 'victron-input-battery', z: 'tab' },
        { id: 'unused-http', type: 'http in', z: 'tab', wires: [[]] }
    ];
    fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2));
    const result = check(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    for (const id of ['unused-inject', 'unused-battery', 'unused-http']) {
        assert.match(result.stderr, new RegExp(`${id}.*unwired`));
    }
    assert.doesNotMatch(result.stderr, /\bwired\b.*unwired/);
});
