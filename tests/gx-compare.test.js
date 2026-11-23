'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { ROOT } = require('./harness');
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

test('function module declarations are compared as ordered, stable JSON', () => {
    const live = repoFlows(), repo = repoFlows();
    live[2].libs = [{ module: 'fs', var: 'fs' }];
    repo[2].libs = [{ var: 'fs', module: 'fs' }];
    live[3].libs = [{ module: 'process', var: 'clock' }];
    repo[4].libs = [{ module: 'fs', var: 'fs' }];
    const diff = diffSnapshots(snapshot(live), snapshot(repo));
    assert.deepEqual(buildPatch(diff, false), { fn2: ['libs'] });
    assert.deepEqual(diff.config.map(node => node.id), ['tuya1']);
    assert.equal(diff.code[0].removed, 1, 'a dropped declaration is a live-only code change');
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
    assert.equal(verifyDeployedCode(snapshot(live), record, read), sha);
    live[2].func = 'return  msg;\n';
    assert.throws(() => verifyDeployedCode(snapshot(live), record, read), /differ from the recorded deployment/);
});

test('d#210 to d#214 verified replacement accepts trailing whitespace with the G2 allowlist, not a local edit', t => {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 27 });
    const sha = 'e85eece1acab82d754fdd18cdd93b1095c7da7ae';
    const target = 'b1f40f04ffdd307897e630919b0428b5e92957cf';
    if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true' &&
        [sha, target].some(commit => spawnSync('git', ['cat-file', '-e', commit], { cwd: ROOT }).status !== 0)) {
        return t.skip('requires the d#210 and d#214 commits (covered by full-history CI)');
    }
    const before = JSON.parse(git('show', `${sha}:flows.json`));
    const after = JSON.parse(git('show', `${target}:flows.json`));
    const targetIds = new Set(after.map(node => node.id));
    const removed = before.filter(node => !targetIds.has(node.id)).map(node => node.id);
    assert.equal(removed.length, 15);
    const { stampDeployment } = require('../tools/deploy-version.js');
    const { flows } = stampDeployment({ flows: before }, { dashboard: sha, automations: sha });
    flows.find(node => node.id === 'hpc-fn-01').func += '\n\n';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-verified-replacement-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'live.b64'), plan = path.join(dir, 'plan.json');
    const run = () => {
        fs.rmSync(plan, { force: true });
        fs.writeFileSync(input, gzipSync(JSON.stringify(snapshot(flows, 'recorded-rev', { topology: true }))).toString('base64'));
        const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gx', 'compare.js'), input, '--commit', target,
            '--plan', plan, '--allow-new-nodes', '--allow-removed-nodes', removed.join(','), '--allow-replace-deployed-lines'],
        { cwd: ROOT, encoding: 'utf8' });
        assert.ifError(result.error);
        return result;
    };
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    const result = JSON.parse(fs.readFileSync(plan, 'utf8'));
    assert.equal(result.replacedFrom, sha);
    assert.deepEqual(result.remove, removed);
    assert.equal(result.add.length, 3);
    assert.equal(result.patch['hpc-fn-01'], undefined);
    flows.find(node => node.id === 'e4766632305fb432').func += '\n// Local edit';
    const refused = run();
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /Verified replacement.*refused: the live nodes or code differ/);
    assert.ok(!fs.existsSync(plan));
});
