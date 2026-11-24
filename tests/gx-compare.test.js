'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { snapshot } = require('../tools/gx/live-snapshot.js');
const { diffSnapshots } = require('../tools/gx/compare.js');
const { fingerprints, differences, checkDrift, report, recordedBase } = require('../tools/gx/whole-flow.js');
const { incidentLive, assertAdoptedInputsReport } = require('../tools/test-gx/deploy-drift-fixture.js');
const { ROOT } = require('./harness');

const hashes = fingerprints;
const logLines = mock => mock.mock.calls.map(call => call.arguments[0]);

test('onlyChanges drift is accepted only when the target adopts it', t => {
    const log = t.mock.method(console, 'log', () => {});
    const [base, live] = [true, false].map(onlyChanges => hashes([{ id: 'input', onlyChanges }]));
    assert.equal(checkDrift(base, live, 'base', { target: live }), true);
    assert.deepEqual(logLines(log), ['adopted drift  : input onlyChanges']);
    assert.throws(() => checkDrift(base, live, 'base', { target: base }), /drift\):\ninput onlyChanges$/);
    assert.throws(() => checkDrift(base, live, 'base', { target: [] }), /drift\):\ninput onlyChanges$/);
});

test('node drift requires an identical addition or a matching removal in the target', t => {
    const log = t.mock.method(console, 'log', () => {});
    const base = hashes([{ id: 'old' }]);
    const live = hashes([{ id: 'new', name: 'live' }]);
    assert.equal(checkDrift(base, live, 'base', { target: live }), true);
    assert.deepEqual(logLines(log), ['adopted drift  : new (added)', 'adopted drift  : old (missing)']);
    const target = hashes([{ id: 'new', name: 'target' }, { id: 'old' }]);
    assert.throws(() => checkDrift(base, live, 'base', { target }), /new \(added\)\nold \(missing\)$/);
});

test('group member order is ignored, but membership changes are drift', t => {
    t.mock.method(console, 'log', () => {});
    const group = (...nodes) => hashes([{ id: 'g', type: 'group', nodes }]);
    const base = group('a', 'b');
    assert.equal(checkDrift(base, group('b', 'a'), 'base'), true);
    assert.throws(() => checkDrift(base, group('a', 'b', 'c'), 'base'), /drift\):\ng nodes$/);
    assert.throws(() => checkDrift(base, group('a'), 'base'), /drift\):\ng nodes$/);
});

test('flow node order is ignored', t => {
    t.mock.method(console, 'log', () => {});
    const nodes = [{ id: 'a' }, { id: 'b' }];
    assert.equal(checkDrift(hashes(nodes), hashes(nodes.reverse()), 'base'), true);
});

test('incident replay accepts twelve adopted fields and reports no work on the six inputs', t => {
    const ref = '0c1b770';
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 24 });
    if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true' &&
        spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: ROOT }).status !== 0) {
        return t.skip('historical replay requires the full Git history (covered by Check and Test GX)');
    }
    const base = JSON.parse(git('show', `${ref}:flows.json`));
    const live = incidentLive(base);
    const target = require('../flows.json');
    const log = t.mock.method(console, 'log', () => {});
    const targetHashes = hashes(target);
    assert.equal(checkDrift(hashes(base), hashes(live), ref, { target: targetHashes }), true);
    report(differences(hashes(live), targetHashes), [...base, ...target]);
    const lines = logLines(log);
    assertAdoptedInputsReport(lines.join('\n'));
    t.diagnostic(lines.filter(line => /^adopted drift|^nodes (added|removed|changed)/.test(line)).join('\n'));
});

test('diagnostic comparison still separates code, trailing whitespace, modules and config', () => {
    const base = [
        { id: 'tab', type: 'tab', label: 'd#7 Main', info: '' },
        { id: 'fn', type: 'function', func: 'return msg;', libs: [{ module: 'fs', var: 'fs' }], outputs: 1 },
        { id: 'tuya', type: 'tuya-smart-device', deviceId: 'template' }
    ];
    const live = snapshot([
        { ...base[0], label: 'd#7 Main [git 0123456789ab]', info: 'stamp' },
        { ...base[1], func: 'return msg;\n', libs: [{ var: 'fs', module: 'fs' }, { var: 'p', module: 'process' }], x: 50 },
        { ...base[2], deviceId: 'private-setting', credentials: { key: 'private-key' } }
    ]);
    assert.doesNotMatch(JSON.stringify(live), /private-setting|private-key/);
    const diff = diffSnapshots(live, snapshot(base));
    assert.deepEqual(diff.code.map(({ id, field, added, removed }) => [id, field, added, removed]), [['fn', 'libs', 1, 1]]);
    assert.deepEqual(diff.trailing.map(({ id, field }) => [id, field]), [['fn', 'func']]);
    assert.deepEqual(diff.config.map(({ id }) => id), ['tuya']);
});

test('drift normalization retains group, wiring, settings and interior whitespace', () => {
    const base = [{ id: 'one', type: 'function', x: 1, y: 1, g: 'a', wires: [['a', 'b']],
        func: 'const a = 1;\nreturn msg;', outputs: 1, info: 'note', settings: { b: 2, a: 1 } }];
    const edits = [{ ...base[0], x: 9, y: 7, settings: { a: 1, b: 2 }, func: 'const a = 1;\r\nreturn msg;\n' }];
    assert.deepEqual(fingerprints(edits), fingerprints(base));
    Object.assign(edits[0], { g: 'b', wires: [['b', 'a']], info: 'note ', func: 'const  a = 1;\nreturn msg;', outputs: 2 });
    assert.deepEqual(differences(fingerprints(base), fingerprints(edits)).changed,
        [{ id: 'one', fields: ['func', 'g', 'info', 'outputs', 'wires'] }]);
});

test('drift requires exactly one common Git baseline', () => {
    const sha = 'a'.repeat(40);
    const info = (dashboard, automations) => `<!-- victron-deployment-source -->
${JSON.stringify({ dashboard, automations })}
<!-- /victron-deployment-source -->`;
    assert.equal(recordedBase({ info: info(sha, sha) }), sha);
    for (const invalid of ['', info(sha, null), info(sha, 'b'.repeat(40)), info(sha, sha).repeat(2)]) {
        assert.throws(() => recordedBase({ info: invalid }), /same Git SHA/);
    }
});
