'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot } = require('../tools/gx/live-snapshot.js');
const { diffSnapshots, buildPatch, verifyDeployedCode } = require('../tools/gx/compare.js');

const repoFlows = () => [
    { id: 'tab1', type: 'tab', label: 'd#7 Main', info: '' },
    { id: 'page1', type: 'ui_tab', name: 'Energy', order: 1 },
    { id: 'fn1', type: 'function', name: 'One', z: 'tab1', func: 'return msg;', outputs: 1, x: 10, y: 20, wires: [[]] },
    { id: 'fn2', type: 'function', name: 'Two', z: 'tab1', func: 'const a = 1;\nreturn msg;', outputs: 1, wires: [[]] },
    { id: 'tuya1', type: 'tuya-smart-device', deviceId: 'template', z: 'tab1' }
];

test('GX comparison separates code, trailing whitespace and config differences', () => {
    const live = repoFlows();
    live[0].label = 'd#7 Main [git 0123456789ab]';
    live[0].info = 'stamp';
    live[1].name = 'Energy [UI 0123456789ab; Auto unrecorded]';
    live[2] = { wires: [[]], outputs: 1, func: 'return msg;\n', z: 'tab1', name: 'One', type: 'function', id: 'fn1', x: 500, y: 600, g: 'group1' };
    live[3].func = 'const a = 1;\r\nconst liveOnly = 2;\r\nreturn msg;';
    live[4].deviceId = '${VICTRON_TUYA1_ID}';
    live.push({ id: 'extra', type: 'debug', z: 'tab1' });

    const diff = diffSnapshots(snapshot(live, 'rev1'), snapshot(repoFlows()));

    assert.deepEqual(diff.code.map((item) => [item.id, item.field, item.added, item.removed]), [['fn2', 'func', 0, 1]]);
    assert.deepEqual(diff.trailing.map((item) => item.id), ['fn1']);
    // Source labels, key order and editor position are not differences; the Tuya settings are.
    assert.deepEqual(diff.config.map((item) => item.id), ['tuya1']);
    assert.deepEqual(diff.onlyLive.map((item) => item.id), ['extra']);
    assert.deepEqual(diff.onlyRepo, []);
    assert.deepEqual(buildPatch(diff, false), { fn2: ['func'] });
    assert.deepEqual(buildPatch(diff, true), { fn2: ['func'], fn1: ['func'] });
});

test('GX snapshot carries code and hashes, never node settings or credentials', () => {
    const flows = repoFlows();
    flows[4].credentials = { localKey: 'do-not-export' };
    const text = JSON.stringify(snapshot(flows, 'rev1'));
    assert.ok(text.includes('return msg;'));
    assert.ok(!text.includes('do-not-export'));
    assert.ok(!text.includes('template'));
});

test('automatic replacement accepts only the recorded common SHA and matching node code', () => {
    const sha = 'a'.repeat(40);
    const record = { dashboard: sha, automations: sha };
    const previous = snapshot(repoFlows());
    const read = value => {
        assert.equal(value, sha);
        return previous;
    };
    const live = repoFlows();
    live[3].func = live[3].func.replace('\n', '\r\n');
    live[4].deviceId = '${VICTRON_TUYA1_ID}';
    assert.equal(verifyDeployedCode(snapshot(live), record, read), sha);
    for (const invalid of [null, { dashboard: sha }, { ...record, automations: 'b'.repeat(40) }]) {
        assert.throws(() => verifyDeployedCode(snapshot(live), invalid,
            () => assert.fail('must not read a commit')), /not recorded/);
    }
    live[2].func += '\n';
    assert.throws(() => verifyDeployedCode(snapshot(live), record, read), /differ from the recorded deployment/);
});
