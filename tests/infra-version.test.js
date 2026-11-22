'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { ROOT } = require('./harness');

const ledger = 'tools/infra-version.json';
const entry = (i, what = 'Test infrastructure change') => ({ i, date: '2026-11-22', pr: null, what });

function fixture(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'victron-infra-version-'));
    t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const put = (file, contents) => {
        const full = path.join(cwd, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    };
    git('init', '-q');
    for (const file of ['infra-version.js', 'flows.js', 'includes.js']) {
        put(`tools/${file}`, fs.readFileSync(path.join(ROOT, 'tools', file)));
    }
    put('flows.json', JSON.stringify([{ type: 'tab', label: 'd#210 Test flow' }]));
    const commit = () => {
        git('add', '--all');
        git('-c', 'user.name=Infra test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
        return git('rev-parse', 'HEAD');
    };
    const base = commit();
    git('update-ref', 'refs/remotes/origin/master', base);
    const run = (tool, ...args) => spawnSync(process.execPath, [`tools/${tool}.js`, ...args], { cwd, encoding: 'utf8' });
    return {
        put, commit, git, base,
        remove: file => fs.unlinkSync(path.join(cwd, file)),
        readLedger: () => JSON.parse(fs.readFileSync(path.join(cwd, ledger), 'utf8')),
        infra: (...args) => run('infra-version', ...args),
        version: () => run('flows', 'version')
    };
}

test('every infrastructure scope needs a bump, including untracked files and designated agent docs', t => {
    const f = fixture(t);
    const files = ['tools/test-gx/runner.js', 'scripts/check.ps1', '.github/workflows/check.yml', 'tests/new.test.js',
        '.claude/skills/new/SKILL.md', 'CLAUDE.md', 'docs/claude-operating-guide.md', 'docs/agent-workflow.md', '.github/copilot-instructions.md'];
    for (const file of files) {
        f.put(file, 'change\n');
        const missing = f.infra('check');
        assert.equal(missing.status, 1, `${file}: ${missing.stderr}`);
        assert.ok(missing.stderr.includes(`Infrastructure changed (${file})`), missing.stderr);
        f.remove(file);
    }
    f.put(files[0], 'change\n');
    const bump = f.infra('bump', 'Add versioned tools', '128');
    assert.equal(bump.status, 0, bump.stderr);
    const journal = f.readLedger();
    assert.equal(journal.i, 1);
    const [{ date, ...change }] = journal.changes;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(change, { i: 1, pr: 128, what: 'Add versioned tools' });
    assert.match(f.infra('bump', 'Another description').stdout, /Already bumped to i#1/);
    assert.equal(f.readLedger().changes[0].what, 'Add versioned tools');
    const check = f.infra('check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /one infrastructure bump/);
});

test('production-only and ordinary docs-only changes leave i# unchanged', t => {
    const f = fixture(t);
    for (const file of ['flows.json', '01 Grid.js', 'lib/grid/helper.js', 'docs/development.md', 'BACKLOG.md']) {
        f.put(file, 'change\n');
    }
    const check = f.infra('check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /i#0 \(unchanged\)/);
    f.put(ledger, JSON.stringify({ i: 1, changes: [entry(1)] }));
    assert.match(f.infra('check').stderr, /No infrastructure changes; do not bump/);
});

test('CI compares the tested commit against the supplied base and rejects two bumps', t => {
    const f = fixture(t);
    f.put('tests/changed.js', 'change\n');
    f.put(ledger, JSON.stringify({ i: 1, changes: [entry(1)] }));
    const first = f.commit();
    f.put('tests/changed.js', 'another change\n');
    f.put(ledger, JSON.stringify({ i: 2, changes: [entry(1), entry(2)] }));
    const tip = f.commit();
    f.git('update-ref', 'refs/remotes/origin/master', tip);
    const double = f.infra('check', f.base);
    assert.equal(double.status, 1);
    assert.match(double.stderr, /Only one i# bump is allowed/);
    const single = f.infra('check', first);
    assert.equal(single.status, 0, single.stderr);
    f.put(ledger, JSON.stringify({ i: 2, changes: [entry(1, 'Rewritten history'), entry(2)] }));
    assert.match(f.infra('check', first).stderr, /Preserve .* history/);
});

test('flows version prints both counters without touching production flows', t => {
    const f = fixture(t);
    f.put('tools/extra.js', 'change\n');
    const bump = f.infra('bump', 'Add a tool');
    assert.equal(bump.status, 0, bump.stderr);
    const version = f.version();
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), 'd#210 · i#1');
    assert.equal(f.git('diff', '--name-only', 'HEAD', '--', 'flows.json'), '');
});
