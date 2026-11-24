'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot } = require('../tools/gx/live-snapshot.js');
const { diffSnapshots } = require('../tools/gx/compare.js');
const { fingerprints, differences, recordedBase } = require('../tools/gx/whole-flow.js');

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
