'use strict';
// The "safe moment" check (tools/gx/window.js) on the states met on 14-15 Nov 2026, and the fixed step
// lists of the two runners: the documentation quotes them, so they must not drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { ROOT } = require('./harness');
const { judge, format, defrostIntervalMin } = require('../tools/gx/window.js');
const { publicSummary, repositoryChanges, formatReport } = require('../tools/gx/deploy-report.js');

const MIN = 60000;
const NOW = new Date(2026, 10, 15, 1, 22).getTime();
// 15 Nov 01:22, read before the secret install: idle, last defrost start 38 min ago, one every ~42 min.
function idle() {
    return {
        now: NOW, view: { at: NOW - 3000 }, dhw: { state: 'HEATING', run: false }, sequences: {}, queue: [], flag: { on: false },
        hp: { fan: 591, hz: 69, fault: 0 }, valve: false, bypass: false,
        defrostStarts: [NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN]
    };
}

test('window: the defrost interval is the median gap of the recorded starts', () => {
    assert.equal(defrostIntervalMin([NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN]), 42);
    assert.equal(defrostIntervalMin([NOW - 400 * MIN, NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN, NOW - 37 * MIN]), 42, 'gaps under 15 min or over 3 h are not intervals');
    assert.equal(defrostIntervalMin([NOW]), null);
    assert.equal(defrostIntervalMin(undefined), null);
});

test('window: 15 Nov 01:22 was safe for a deploy but not for stopping Node-RED (a defrost was due)', () => {
    const deploy = judge(idle());
    assert.equal(deploy.safe, true);
    assert.match(format(deploy), /^SAFE for deploy \(defrost every ~42 min, last start 38 min ago, next in ~4 min\)$/);

    const stop = judge(idle(), { purpose: 'stop', marginMin: 8 });
    assert.equal(stop.safe, false);
    assert.match(format(stop), /^WAIT for stop[\s\S]*the next defrost is expected in 4 min .* needs 8 free minutes/);
});

test('window: right after a defrost there is room to stop Node-RED; an estimate overdue for long stops blocking', () => {
    const fresh = idle();
    fresh.defrostStarts = [NOW - 96 * MIN, NOW - 54 * MIN, NOW - 12 * MIN];
    assert.equal(judge(fresh, { purpose: 'stop' }).safe, true);

    const overdue = idle();
    overdue.defrostStarts = [NOW - 136 * MIN, NOW - 94 * MIN, NOW - 52 * MIN];   // due 10 min ago
    const waiting = judge(overdue, { purpose: 'stop' });
    assert.equal(waiting.safe, false);
    assert.match(format(waiting), /overdue by 10 min/);
    overdue.defrostStarts = overdue.defrostStarts.map((t) => t - 15 * MIN);       // due 25 min ago: it got warmer
    assert.equal(judge(overdue, { purpose: 'stop' }).safe, true);

    const none = idle();
    none.defrostStarts = [];
    assert.equal(judge(none, { purpose: 'stop' }).safe, true, 'no defrost season: nothing to wait for');
});

test('window: every state in which a redeploy or a stop would interrupt something is WAIT, with its reason', () => {
    const cases = [
        [(i) => { i.dhw = { state: 'DHW', run: true }; }, /a DHW cycle is running \(DHW\)/],
        [(i) => { i.dhw = { state: 'HEATING', run: true }; }, /a DHW cycle is running/],
        [(i) => { i.dhw = null; }, /no DHW state/],
        [(i) => { i.sequences = { df_exchange_on: { idx: 1 } }; }, /a rule sequence is running: df_exchange_on/],
        [(i) => { i.queue = [{}, {}]; }, /2 device write\(s\) still queued/],
        [(i) => { i.flag = { on: true }; }, /the defrost flag is ON/],
        [(i) => { i.hp = { fan: 0, hz: 59, fault: 0 }; }, /a defrost is running \(fan 0, compressor 59 Hz\)/],
        [(i) => { i.valve = true; }, /the 3-way valve is not on heating/],
        [(i) => { i.bypass = true; }, /the bypass is not OFF/],
        [(i) => { i.bypass = undefined; }, /the bypass is not OFF \(undefined\)/],
        [(i) => { i.hp.fault = 1; }, /fault code 1/],
        [(i) => { i.view = { at: NOW - 5 * MIN }; }, /the automations are not ticking/],
        [(i) => { i.view = null; }, /the automations are not ticking/]
    ];
    for (const [change, reason] of cases) {
        const input = idle();
        change(input);
        const result = judge(input);
        assert.equal(result.safe, false, String(reason));
        assert.match(result.wait.join('\n'), reason);
    }
});

test('runners: the step lists are fixed and the handoff document quotes them exactly', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    const steps = (script) => {
        const out = spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'scripts', script), '-Steps'], { encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
        return out.stdout.trim().split(/\r?\n/).map((line) => line.trim());
    };
    const deploy = steps('gx-deploy.ps1'), install = steps('gx-secrets-install.ps1');
    assert.deepEqual(deploy.map((line) => line.split(/\s+/).slice(0, 2).join(' ')),
        ['1 preflight', '2 snapshot', '3 compare', '4 plan', '5 window', '6 dry', '7 deploy', '8 verify']);
    assert.deepEqual(install.map((line) => line.split(/\s+/).slice(0, 2).join(' ')),
        ['1 preflight', '2 sync', '3 check', '4 window', '5 dispatch', '6 approve', '7 compare', '8 start']);
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'gx-handoff.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const line of deploy.concat(install)) assert.ok(doc.includes(line), 'docs/gx-handoff.md does not quote: ' + line);
});

test('runners: without -Apply / with -DryRun nothing can change, and bad hosts are refused before any connection', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    for (const script of ['gx-deploy.ps1', 'gx-secrets-install.ps1']) {
        const text = fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8');
        for (const bad of ['root@gx; reboot', "root@gx'x", 'gx.example.test']) {
            const out = spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'scripts', script), '-GxHost', bad, '-SshKey', 'nokey'], { encoding: 'utf8' });
            assert.notEqual(out.status, 0, script + ' accepted ' + bad);
            assert.match(out.stderr + out.stdout, /GxHost must look like/);
        }
        // every command that changes the GX sits behind the switch
        if (script === 'gx-deploy.ps1') {
            assert.ok(text.indexOf('if (-not $Apply) {') < text.indexOf('DRY=0 node'), 'the real deploy comes after the -Apply gate');
            assert.equal((text.match(/DRY=0/g) || []).length, 1);
        } else {
            const gate = text.indexOf("if ($DryRun) { Write-Host ''; Write-Host 'DRY RUN finished");
            assert.ok(gate > 0 && gate < text.indexOf('svc -d $service') && gate < text.indexOf("'action=install'"), 'stop and install come after the -DryRun exit');
            assert.ok(text.indexOf('finally {') > text.indexOf('svc -d $service') && text.includes('svc -u $service'), 'Node-RED is started again in the finally block');
        }
    }
});

test('public deploy report excludes live code, labels, identifiers and arbitrary source metadata', () => {
    const secret = 'PRIVATE-GX-TOKEN';
    const commit = 'a'.repeat(40);
    const previous = 'b'.repeat(40);
    const summary = {
        live: { label: secret, rev: secret, source: { dashboard: previous, automations: secret } },
        code: [secret], trailing: [], config: [secret], onlyLive: [], onlyRepo: [], liveOnlyLines: [secret],
        nodes: [{ func: secret }], error: secret
    };
    const result = publicSummary(summary, null, { commit, mode: 'dry-run', outcome: 'failure', version: 'test' });
    assert.deepEqual(result, {
        commit, mode: 'dry-run', outcome: 'failure', version: 'test',
        previous: { dashboard: previous, automations: null },
        before: { code: 1, trailing: 0, config: 1, onlyLive: 0, onlyRepo: 0, liveOnlyLines: 1 },
        after: null
    });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(publicSummary(null, null, { commit, mode: 'apply', outcome: 'cancelled', version: 'stable' }).before, null);
    assert.throws(() => publicSummary(null, null, { commit: secret, mode: 'apply', outcome: 'success', version: 'test' }), /commit SHA/);
    assert.throws(() => publicSummary({ code: secret }, null, { commit, mode: 'apply', outcome: 'success', version: 'test' }), /summary field/);
    assert.throws(() => publicSummary(null, null, { commit, mode: 'apply', outcome: 'success', version: 'unknown' }), /version label/);
});

test('runner extracts the committed additions helper and uploads it with the dry-run scripts', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-runner-add-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const gitShow = (file) => execFileSync('git', ['show', 'HEAD:' + file], { cwd: ROOT, maxBuffer: 1 << 27 });
    const helper = 'tools/gx/node-additions.js';
    const added = 'utcp-http-get-01';
    const flows = JSON.parse(gitShow('flows.json')).filter((node) => node.id !== added);
    const { snapshot } = require('../tools/gx/live-snapshot.js');
    const snapshotFile = path.join(dir, 'live.b64');
    const before = require('node:zlib').gzipSync(JSON.stringify(snapshot(flows, 'test-revision', { topology: true }))).toString('base64');
    fs.writeFileSync(snapshotFile, before);
    const run = path.join(dir, 'run');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
        $realGit = (Get-Command git -CommandType Application).Source | Select-Object -First 1
        $ErrorActionPreference = 'Stop'
        function git {
            # Only the two remote preflight probes are mocked; blobs still come from HEAD.
            if ($args[2] -eq 'fetch') { $global:LASTEXITCODE = 0; return }
            if ($args[2] -eq 'branch') { $global:LASTEXITCODE = 0; return 'origin/test' }
            & $realGit @args
        }
        function ssh {
            $global:LASTEXITCODE = 0
            switch -Wildcard ($args[-1]) {
                '*node - --topology' { return Get-Content -Raw -LiteralPath $env:GX_TEST_SNAPSHOT }
                '*node - --for deploy' { return 'SAFE for deploy' }
                '*mktemp*' { return '/tmp/gx-deploy.Test' }
                'node /tmp/gx-deploy.Test/deploy.js*' { return 'DRY RUN - nothing changed' }
                'rm -f /tmp/gx-deploy.Test/*' { return }
                default { throw "Unexpected SSH arguments: $args" }
            }
        }
        function scp {
            foreach ($name in 'deploy.js','node-additions.js','plan.json') {
                if (-not ($args | Where-Object { (Split-Path -Leaf $_) -eq $name -and (Test-Path -LiteralPath $_ -PathType Leaf) })) {
                    throw "Missing $name in SCP upload"
                }
            }
            $global:LASTEXITCODE = 0
        }
        & $env:GX_TEST_RUNNER -GxHost 'root@fake-host' -SshKey 'unused' -Commit HEAD -AllowNewNodes -RunDirectory $env:GX_TEST_RUN
        exit $LASTEXITCODE
    `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GX_TEST_SNAPSHOT: snapshotFile,
        GX_TEST_RUNNER: path.join(ROOT, 'scripts', 'gx-deploy.ps1'), GX_TEST_RUN: run } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(run, helper)), gitShow(helper));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'plan.json'))).add, [added]);
    assert.match(result.stdout, /DRY RUN - nothing changed/);
});

test('deployment changelog and workflow command use recorded Git commits and report missing baselines', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-report-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    const commitFile = (text, subject) => {
        fs.writeFileSync(path.join(root, 'test.js'), text);
        git('add', 'test.js');
        git('-c', 'user.name=GX report test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false',
            'commit', '--quiet', '-m', subject);
        return git('rev-parse', 'HEAD');
    };
    const first = commitFile('old\n', 'Initial version');
    const second = commitFile('new\n', 'Update controller');
    const third = commitFile('latest\n', 'Fix dashboard <script>');
    const changes = repositoryChanges({ dashboard: first, automations: second }, third, root);
    assert.deepEqual(changes.map((change) => change.scopes), [['dashboard'], ['automations']]);
    assert.deepEqual(changes[0].commits.map((commit) => commit.subject), ['Update controller', 'Fix dashboard <script>']);
    assert.deepEqual(changes[1].commits.map((commit) => commit.sha), [third]);
    assert.deepEqual(changes[0].files, [{ status: 'M', path: 'test.js' }]);
    const grouped = repositoryChanges({ dashboard: third, automations: third }, third, root);
    assert.equal(grouped.length, 1);
    assert.deepEqual(grouped[0].scopes, ['dashboard', 'automations']);
    assert.deepEqual([grouped[0].commits, grouped[0].files], [[], []]);
    const unavailable = repositoryChanges({ dashboard: null, automations: 'a'.repeat(40) }, third, root);
    assert.deepEqual(unavailable.map((change) => change.status), ['previous-not-recorded', 'previous-not-in-repository']);
    const report = publicSummary(null, null, { commit: third, mode: 'dry-run', outcome: 'success', version: 'stable' });
    const formatted = formatReport({ ...report, changes });
    assert.match(formatted, /Version label: \*\*stable\*\* \(report only\)/);
    assert.match(formatted, /Fix dashboard &lt;script&gt;/);
    assert.ok(formatted.includes(first) && formatted.includes(third));
    assert.match(formatted, /M test\.js/);
    assert.match(formatReport({ ...report, changes: unavailable }), /comparison is unavailable/);
    // Preserve the CLI's repository-root convention with controlled fixture history.
    const script = path.join(root,'tools','gx','deploy-report.js');
    fs.mkdirSync(path.dirname(script),{recursive:true});
    fs.copyFileSync(path.join(ROOT,'tools','gx','deploy-report.js'),script);
    const runFolder = path.join(root,'private-run');
    fs.mkdirSync(runFolder);
    const privateValue = 'PRIVATE-CLI-LIVE-CODE';
    fs.writeFileSync(path.join(runFolder,'summary-before.json'),JSON.stringify({
        live:{source:{dashboard:first,automations:second},label:privateValue},
        code:[privateValue],trailing:[],config:[],onlyLive:[],onlyRepo:[],liveOnlyLines:[]
    }));
    for (const [mode,outcome,version] of [['apply','success','stable'],['dry-run','failure','test']]) {
        const output = path.join(root,mode+'.json');
        const cli = spawnSync(process.execPath,[script,runFolder,output],{encoding:'utf8',env:{
            ...process.env,GITHUB_SHA:third,MODE:mode,DEPLOY_OUTCOME:outcome,VERSION_TYPE:version
        }});
        assert.equal(cli.status,0,cli.stderr);
        const artifact = JSON.parse(fs.readFileSync(output,'utf8'));
        assert.deepEqual([artifact.commit,artifact.mode,artifact.outcome,artifact.version],[third,mode,outcome,version]);
        assert.deepEqual(artifact.changes[0].commits.map(commit=>commit.sha),[second,third]);
        assert.deepEqual(artifact.changes[1].commits.map(commit=>commit.sha),[third]);
        assert.deepEqual(artifact.changes[0].files,[{status:'M',path:'test.js'}]);
        assert.equal(artifact.before.code,1);
        assert.equal(artifact.after,null);
        assert.match(cli.stdout,/Fix dashboard &lt;script&gt;/);
        assert.ok(cli.stdout.includes(`Version label: **${version}**`));
        assert.ok(!cli.stdout.includes(privateValue) && !JSON.stringify(artifact).includes(privateValue));
    }
    const invalidOutput = path.join(root,'invalid.json');
    const invalid = spawnSync(process.execPath,[script,runFolder,invalidOutput],{encoding:'utf8',env:{
        ...process.env,GITHUB_SHA:third,MODE:'apply',DEPLOY_OUTCOME:'success',VERSION_TYPE:'invalid'
    }});
    assert.notEqual(invalid.status,0);
    assert.match(invalid.stderr,/Unexpected version label/);
    assert.ok(!fs.existsSync(invalidOutput));
});

test('runner extracts committed scripts byte-for-byte without cmd, and keeps Git error detail', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    const script = path.join(ROOT, 'scripts', 'gx-deploy.ps1');
    const out = spawnSync('pwsh', ['-NoProfile', '-Command', `
        $root = $env:TEST_REPO
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_SCRIPT, [ref]$tokens, [ref]$errors)
        $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-GitBlob' }, $true)
        Invoke-Expression $fn.Extent.Text
        $destination = [IO.Path]::GetTempFileName()
        try {
            Save-GitBlob 'HEAD' 'scripts/gx-deploy.ps1' $destination
            $actual = & git -C $root hash-object --no-filters $destination
            $expected = & git -C $root rev-parse 'HEAD:scripts/gx-deploy.ps1'
            if ($actual -ne $expected) { throw 'Blob bytes differ.' }
            try { Save-GitBlob 'HEAD' 'missing-file.js' $destination; throw 'Missing blob accepted.' }
            catch { if ($_.Exception.Message -notmatch 'git cat-file failed.*missing-file.js') { throw } }
        }
        finally { if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force } }
    `], { encoding: 'utf8', env: { ...process.env, TEST_REPO: ROOT, TEST_SCRIPT: script } });
    assert.equal(out.status, 0, out.stderr + out.stdout);
});
