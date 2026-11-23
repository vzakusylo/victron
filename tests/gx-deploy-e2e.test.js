'use strict';
// End-to-end repeat of the deploy steps of docs/gx-handoff.md against a fake GX:
//   snapshot -> compare -> plan -> window -> dry run -> refused deploys -> deploy -> verify -> compare again -> stale plan
// The real scripts run as child processes, exactly as on the GX. Only the outside world is replaced:
// a local HTTP server plays the Node-RED admin API, another one plays raw.githubusercontent.com and serves
// the files of HEAD, and a temp folder plays /data/home/nodered. Nothing here touches a real device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { ROOT } = require('./harness');

const GX = (name) => path.join(ROOT, 'tools', 'gx', name);
const TAB_STAMP = /<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/;

function gitShow(file) { return execFileSync('git', ['-C', ROOT, 'show', 'HEAD:' + file], { maxBuffer: 1 << 27 }); }
function run(file, args, env, cwd = ROOT) {
    return new Promise((resolve) => {
        execFile(process.execPath, [file].concat(args || []), { cwd, env: Object.assign({}, process.env, env), maxBuffer: 1 << 27 },
            (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    });
}
function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            // A TCP chunk can split a UTF-8 character in the flow's source.
            req.setEncoding('utf8');
            handler(req, res);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('fake GX preserves UTF-8 JSON when a character is split across HTTP chunks', { timeout: 10000 }, async (t) => {
    let received;
    const firstChunk = new Promise((resolve) => { received = resolve; });
    const server = await listen((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; received(); });
        req.on('end', () => res.end(body));
    });
    t.after(() => server.close());
    const payload = { func: '// ' + String.fromCodePoint(0x416, 0x1f600) };
    const bytes = Buffer.from(JSON.stringify(payload));
    const split = bytes.findIndex((byte) => byte > 127) + 1;
    let request;
    const reply = new Promise((resolve, reject) => {
        request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve(body));
            res.on('error', reject);
        });
        request.on('error', reject);
    });
    request.write(bytes.subarray(0, split));
    await firstChunk;
    request.end(bytes.subarray(split));
    assert.deepEqual(JSON.parse(await reply), payload);
});

let available = true;
try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', 'HEAD^{commit}'], { stdio: 'ignore' }); execFileSync('curl', ['--version'], { stdio: 'ignore' }); }
catch { available = false; }

test('a removal plan rechecks the verified baseline on the GX before applying and cleans up wires',
    { skip: !available && 'needs git and curl', timeout: 60000 }, async t => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-removal-test-'));
        t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
        const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        git('init', '-q');
        git('config', 'user.name', 'GX test');
        git('config', 'user.email', 'gx-test@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        const stamp = gitShow('tools/deploy-version.js');
        fs.mkdirSync(path.join(cwd, 'tools'));
        fs.writeFileSync(path.join(cwd, 'tools', 'deploy-version.js'), stamp);
        const old = [{ id: 'tab', type: 'tab', label: 'd#1 GX' },
            { id: 'input', type: 'inject', z: 'tab', wires: [['gone']] },
            { id: 'gone', type: 'delay', z: 'tab', wires: [[]] },
            { id: 'ui', type: 'ui_base', site: { name: 'Test' } },
            { id: 'page', type: 'ui_tab', name: 'Test' },
            { id: 'layout', type: 'group', z: 'tab', name: 'Control', style: { label: true },
                nodes: ['battery', 'keep'], x: 10, y: 20, w: 200, h: 80 },
            { id: 'battery', type: 'victron-input-battery', z: 'tab', g: 'layout', wires: [['keep']] },
            { id: 'keep', type: 'delay', z: 'tab', g: 'layout', wires: [[]] }];
        const next = [{ ...old[0], label: 'd#2 GX' }, { ...old[1], wires: [[]] }, old[3], old[4],
            { ...old[5], nodes: ['keep'] }, old[7]];
        const commit = (flows, label) => {
            fs.writeFileSync(path.join(cwd, 'flows.json'), JSON.stringify(flows));
            git('add', '--all');
            git('commit', '-qm', label);
            return git('rev-parse', 'HEAD');
        };
        const base = commit(old, 'previous deployment');
        const target = commit(next, 'removal');
        let live = require('../tools/deploy-version.js').stampDeployment({ rev: 'r1', flows: old }, { dashboard: base, automations: base });
        const api = await listen((req, res) => {
            if (req.method === 'GET') return res.end(JSON.stringify(live));
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                assert.equal(req.headers['node-red-deployment-type'], 'nodes');
                live = { ...JSON.parse(body), rev: 'r2' };
                res.end(JSON.stringify({ rev: live.rev }));
            });
        });
        const raw = await listen((req, res) => {
            const file = req.url.split('/').slice(3).join('/');
            if (file === `${base}/flows.json`) return res.end(JSON.stringify(old));
            if (file === `${target}/flows.json`) return res.end(JSON.stringify(next));
            if (file === `${target}/tools/deploy-version.js`) return res.end(stamp);
            res.writeHead(404).end();
        });
        t.after(() => { api.close(); raw.close(); });
        const env = { VICTRON_API_PORT: api.address().port, VICTRON_HOME: cwd, VICTRON_RAW_BASE: `http://127.0.0.1:${raw.address().port}` };
        const nr = path.join(cwd, '.node-red');
        fs.mkdirSync(nr);
        fs.writeFileSync(path.join(nr, 'flows.json'), JSON.stringify(old));
        fs.writeFileSync(path.join(nr, 'flows_cred.json'), '{}');
        const snap = await run(GX('live-snapshot.js'), ['--topology'], env);
        assert.equal(snap.code, 0, snap.stderr);
        const input = path.join(cwd, 'live.b64'), plan = path.join(cwd, 'plan.json');
        fs.writeFileSync(input, snap.stdout);
        const result = await run(GX('compare.js'), [input, '--commit', target, '--plan', plan, '--allow-removed-nodes', 'gone,battery'], env, cwd);
        assert.equal(result.code, 0, result.stderr);
        const report = require('../tools/gx/deploy-report.js');
        const removals = report.plannedRemovals(cwd, target, cwd);
        assert.deepEqual(removals, [{ id: 'gone', type: 'delay', name: '' }, { id: 'battery', type: 'victron-input-battery', name: '' }]);
        assert.match(report.formatReport({ mode: 'dry-run', commit: target, changes: [], removals }), /Planned node removals \(2/);
        const deploy = DRY => run(GX('deploy.js'), [plan], { ...env, DRY });
        const dry = await deploy('1');
        assert.equal(dry.code, 0, dry.stderr);
        assert.match(dry.stdout, /node to remove\s+: gone/);
        assert.match(dry.stdout, /node to remove\s+: battery/);
        live.flows[2].name = 'edited since snapshot';
        const rejected = await deploy('0');
        assert.match(rejected.stderr, /does not match the recorded commit/);
        assert.equal(live.rev, 'r1');
        delete live.flows[2].name;
        const applied = await deploy('0');
        assert.equal(applied.code, 0, applied.stderr);
        assert.equal(live.rev, 'r2');
        assert.deepEqual(live.flows.map(node => node.id), ['tab', 'input', 'ui', 'page', 'layout', 'keep']);
        assert.deepEqual(live.flows[1].wires, [[]]);
        assert.deepEqual(live.flows.find(node => node.id === 'layout'), next.find(node => node.id === 'layout'));
    });

test('verified dry-run code replacement plans against a fake GX only when it matches the recorded Git deployment',
    // Two PowerShell deploy runs and multiple snapshots compete with the full suite on Windows.
    { skip: !available && 'needs git and curl', timeout: 180000 }, async t => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-replacement-test-'));
        t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
        const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        git('init', '-q');
        git('config', 'user.name', 'GX test');
        git('config', 'user.email', 'gx-test@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        const flows = [{ id: 'tab', type: 'tab', label: 'd#1 GX' },
            { id: 'fn', z: 'tab', type: 'function', func: 'msg.payload = 1;\nreturn msg;' }];
        const putFlows = () => fs.writeFileSync(path.join(cwd, 'flows.json'), JSON.stringify(flows));
        fs.mkdirSync(path.join(cwd, 'tools'));
        fs.writeFileSync(path.join(cwd, 'tools', 'deploy-version.js'), '');
        putFlows();
        git('add', 'flows.json', 'tools');
        git('commit', '-qm', 'previous deployment');
        const previous = git('rev-parse', 'HEAD');
        const live = structuredClone(flows);
        flows[1].func = 'msg.payload = 2;\nreturn msg;';
        putFlows();
        git('commit', '-qam', 'replacement');
        const target = git('rev-parse', 'HEAD');
        const stamp = (sha = previous) => '<!-- victron-deployment-source -->\n' +
            JSON.stringify({ dashboard: sha, automations: sha }) + '\n<!-- /victron-deployment-source -->';
        live[0].info = stamp();
        const api = await listen((req, res) => {
            assert.equal(req.method, 'GET');
            assert.equal(req.url, '/flows');
            res.end(JSON.stringify({ rev: 'fake-revision-001', flows: live }));
        });
        t.after(() => api.close());
        const env = { VICTRON_API_PORT: api.address().port };
        const baseline = path.join(cwd, 'live.b64');
        const plan = path.join(cwd, 'plan.json');
        const makePlan = async () => {
            fs.rmSync(plan, { force: true });
            const snap = await run(GX('live-snapshot.js'), [], env);
            assert.equal(snap.code, 0, snap.stderr);
            fs.writeFileSync(baseline, snap.stdout);
            return run(GX('compare.js'), [baseline, '--commit', target, '--plan', plan,
                '--allow-replace-deployed-lines'], env, cwd);
        };
        const ok = await makePlan();
        assert.equal(ok.code, 0, ok.stderr);
        assert.ok(ok.stdout.includes(`replaced lines of ${previous}`));
        const result = JSON.parse(fs.readFileSync(plan, 'utf8'));
        assert.deepEqual([result.replacedFrom, result.expectRev, result.patch], [previous, 'fake-revision-001', { fn: ['func'] }]);
        const runManual = async name => {
            const runner = path.join(cwd, 'scripts', 'gx-deploy.ps1');
            fs.mkdirSync(path.dirname(runner), { recursive: true });
            fs.copyFileSync(path.join(ROOT, 'scripts', 'gx-deploy.ps1'), runner);
            fs.mkdirSync(path.join(cwd, 'tools', 'gx'), { recursive: true });
            for (const script of ['compare.js', 'node-additions.js', 'deploy.js', 'window.js', 'verify.js', 'live-snapshot.js']) {
                fs.copyFileSync(GX(script), path.join(cwd, 'tools', 'gx', script));
            }
            const summary = path.join(cwd, `${name}.md`);
            // Same verified flag as workflow_dispatch. SSH/SCP are local test doubles.
            const output = await new Promise(resolve => execFile('pwsh', ['-NoProfile', '-Command', `
                $realGit = (Get-Command git -CommandType Application).Source | Select-Object -First 1
                function git {
                    if ($args[2] -eq 'fetch') { $global:LASTEXITCODE = 0; return }
                    if ($args[2] -eq 'branch') { $global:LASTEXITCODE = 0; return 'origin/master' }
                    & $realGit @args
                }
                function ssh {
                    $global:LASTEXITCODE = 0
                    switch -Wildcard ($args[-1]) {
                        '*node - ' { return Get-Content -Raw -LiteralPath $env:GX_TEST_SNAPSHOT }
                        '*node - --for deploy' { return 'SAFE for deploy' }
                        '*mktemp*' { return '/tmp/gx-deploy.Test' }
                        'node /tmp/gx-deploy.Test/deploy.js*' { return 'DRY RUN - nothing changed' }
                        'rm -f /tmp/gx-deploy.Test/*' { return }
                        default { throw "Unexpected SSH arguments: $args" }
                    }
                }
                function scp { $global:LASTEXITCODE = 0 }
                & $env:GX_TEST_RUNNER -GxHost 'root@fake-host' -SshKey 'unused' -Commit HEAD -UseWorkTreeScripts -AllowReplaceDeployedLines -RunDirectory $env:GX_TEST_RUN
                exit $LASTEXITCODE
            `], { cwd, timeout: 60000, env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GX_TEST_SNAPSHOT: baseline,
                GX_TEST_RUNNER: runner, GX_TEST_RUN: path.join(cwd, name) } },
            (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
            return { ...output, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
        };
        const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-Command', '1']).status === 0;
        if (pwshAvailable) {
            const dry = await runManual('verified');
            assert.equal(dry.code, 0, dry.stdout + dry.stderr);
            assert.match(dry.stdout, /DRY RUN - nothing changed/);
            assert.ok(dry.summary.includes(`replaced lines of ${previous}`));
        }
        const mail = await run(GX('deploy-mail.js'), [cwd], { DEPLOY_SHA: target, TRIGGER_EVENT: 'workflow_run',
            ALLOW_LIVE_ONLY_LINES: 'false' }, cwd);
        assert.equal(mail.code, 0, mail.stderr);
        assert.match(JSON.parse(mail.stdout).subject, /d#\d+ · i#\d+/);
        assert.match(JSON.parse(mail.stdout).text, /allow_live_only_lines: USED/);
        live[1].func += '\n// hand edit';
        const changed = await makePlan();
        assert.equal(changed.code, 1);
        assert.match(changed.stderr, /differ from the recorded deployment/);
        assert.equal(fs.existsSync(plan), false);
        if (pwshAvailable) {
            const dry = await runManual('hand-edit');
            assert.equal(dry.code, 1, dry.stdout + dry.stderr);
            assert.match(dry.summary, /could not be verified against the recorded deployment/);
            assert.match(dry.summary, /live nodes or code differ/);
            assert.match(dry.summary, /Next: .*allow_live_only_lines/);
            assert.doesNotMatch(dry.summary, /\/\/ hand edit/);
        }
        live[1].func = 'msg.payload = 1;\nreturn msg;';
        delete live[0].info;
        const unrecorded = await makePlan();
        assert.equal(unrecorded.code, 1);
        assert.match(unrecorded.stderr, /deployment record is missing/);
        assert.equal(fs.existsSync(plan), false);
        live[0].info = stamp('0'.repeat(40));
        const unknown = await makePlan();
        assert.equal(unknown.code, 1);
        assert.match(unknown.stderr, /not a readable ancestor/);
        assert.equal(fs.existsSync(plan), false);
    });

test('GX deploy end to end: every step of the runbook against a fake GX', { skip: !available && 'needs git and curl', timeout: 120000 }, async (t) => {
    const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
    const repoFlows = JSON.parse(gitShow('flows.json').toString('utf8'));
    const repoById = new Map(repoFlows.map((node) => [node.id, node]));
    const repoTab = repoFlows.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    const number = Number(/d#(\d+)/.exec(repoTab.label)[1]);

    // ---- the fake GX: an older flow with the secrets migration applied, and an older tool file ----------
    const live = JSON.parse(JSON.stringify(repoFlows));
    const liveNode = (id) => live.find((node) => node.id === id);
    const oldSha = '0123456789abcdef0123456789abcdef01234567';
    liveNode(repoTab.id).label = repoTab.label.replace(/d#\d+/, 'd#' + (number - 1)) + ' [git ' + oldSha.slice(0, 12) + ']';
    liveNode(repoTab.id).info = '<!-- victron-deployment-source -->\n' + JSON.stringify({ dashboard: oldSha, automations: oldSha }) + '\n<!-- /victron-deployment-source -->';
    for (const node of live) {
        const suffix = ' [git ' + oldSha.slice(0, 12) + ']';
        if (node.type === 'ui_base') node.site.name += suffix;
        if (node.type === 'ui_tab') node.name += suffix;
    }
    const behind = ['hp-cmd-fn-01', 'hpls-fn-01'];                    // function code behind the commit
    for (const id of behind) liveNode(id).func = repoById.get(id).func.split('\n').slice(1).join('\n');
    const page = 'hp-page-template-01';                                // a dashboard template behind the commit
    liveNode(page).format = repoById.get(page).format.split('\n').slice(0, -3).join('\n');
    const trailing = 'hpc-fn-01';                                      // editor artefact: must be left alone
    liveNode(trailing).func = repoById.get(trailing).func + '\n';
    const tuya = live.find((node) => node.type === 'tuya-smart-device');   // file-secret reference: must survive
    tuya.deviceId = '${VICTRON_TEST_ID}';
    const added = repoById.get('utcp-http-get-01');
    live.splice(live.indexOf(liveNode(added.id)), 1);
    const liveGroup = liveNode(added.g);
    liveGroup.nodes = liveGroup.nodes.filter((id) => id !== added.id).reverse();
    liveGroup.x += 10;
    const original = JSON.stringify(live);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-e2e-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    for (const dir of ['.node-red', 'tools']) fs.mkdirSync(path.join(home, dir));
    fs.writeFileSync(path.join(home, '.node-red', 'flows.json'), original);
    fs.writeFileSync(path.join(home, '.node-red', 'flows_cred.json'), '{"$":"encrypted"}');
    const toolFile = path.join(home, 'tools', 'tuya-local-sensors.js');
    const oldTool = '// an older copy, with CRLF as copied from Windows\r\nconsole.log(1);\r\n';
    fs.writeFileSync(toolFile, oldTool);
    const logFile = path.join(home, 'node-red.log');
    fs.writeFileSync(logFile, '@400000006af89ae01f481074 14 Nov 18:31:02 - [info] Started flows\n');

    const state = { rev: 'rev-1', flows: JSON.parse(original), posts: [], failNextPost: false,
        dhw: { state: 'HEATING', run: null, why: 'tank warm', outAvg: 1 }, now: Date.now() };
    const context = (value) => (value === undefined ? { msg: '(undefined)', format: 'undefined' } : { msg: JSON.stringify(value), format: 'Object' });
    const api = await listen((req, res) => {
        const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method === 'GET' && req.url === '/flows') return send(200, { rev: state.rev, flows: state.flows });
        if (req.method === 'POST' && req.url === '/flows') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const payload = JSON.parse(body);
                state.posts.push({ type: req.headers['node-red-deployment-type'], rev: payload.rev });
                if (state.failNextPost) { state.failNextPost = false; return send(500, { message: 'simulated failure' }); }
                if (payload.rev !== state.rev) return send(409, { code: 'version_mismatch' });
                state.flows = payload.flows;
                state.rev = crypto.createHash('sha256').update(body).digest('hex');
                send(200, { rev: state.rev });
            });
            return undefined;
        }
        const node = /^\/context\/node\/hpa-fn-01\/(\w+)$/.exec(req.url);
        if (node) {
            return send(200, context({ dhw: state.dhw, seqs: {}, queue: [], flag: { on: false },
                settings: { master: true, modes: { dhw: 'live', heat: 'live' }, defrostStarts: [] } }[node[1]]));
        }
        const flow = /^\/context\/flow\/[^/]+\/(\w+)$/.exec(req.url);
        if (flow) {
            const device = (dps) => ({ state: 'CONNECTED', lastData: Date.now(), dps });
            return send(200, context({
                dhwView: { at: Date.now(), master: true, state: state.dhw.state, heat: { pumpMode: 'Silent', boost: 0, target: 36, lag: 0, why: 'collecting data' } },
                heatPump: { hp: device({ 1: true, 2: 'mute', 15: 0, 101: 31, 102: 36, 108: 47, 115: 69, 116: 590 }), valve: device({ 1: false }), bypass: device({ 1: false }) }
            }[flow[1]]));
        }
        return send(404, {});
    });
    const raw = await listen((req, res) => {
        const m = /^\/vzakusylo\/victron\/([0-9a-f]{40})\/(.+)$/.exec(req.url);
        if (!m || m[1] !== sha) { res.writeHead(404); return res.end(); }
        try { res.writeHead(200); res.end(gitShow(m[2])); } catch { res.writeHead(404); res.end(); }
    });
    t.after(() => { api.close(); raw.close(); });
    const env = { VICTRON_HOME: home, VICTRON_API_PORT: String(api.address().port), VICTRON_RAW_BASE: 'http://127.0.0.1:' + raw.address().port, VICTRON_LOG: logFile };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-e2e-pc-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const file = (name) => path.join(work, name);
    const backups = () => fs.readdirSync(path.join(home, '.node-red')).filter((name) => name.startsWith('backup-'));
    const leftovers = () => fs.readdirSync(home).filter((name) => name.startsWith('.gx-deploy-stage.'));

    // ---- step 2: snapshot (read-only), as piped over SSH ---------------------------------------------------
    const snap = await run(GX('live-snapshot.js'), ['--topology'], env);
    assert.equal(snap.code, 0, snap.stderr);
    fs.writeFileSync(file('live.b64'), snap.stdout);
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(snap.stdout.trim(), 'base64')).toString('utf8'));
    assert.equal(decoded.rev, 'rev-1');
    assert.ok(!snap.stdout.includes('VICTRON_TEST_ID') && !JSON.stringify(decoded).includes('VICTRON_TEST_ID'), 'no Tuya settings leave the GX');

    // ---- steps 3 and 4: compare and plan -------------------------------------------------------------------
    const gateTool = 'tools/camera-mail-gate.js';
    // The deploy fixture serves committed bytes; exercise the new tool after the first commit.
    const committedGate = execFileSync('git', ['-C', ROOT, 'ls-tree', 'HEAD', '--', gateTool], { encoding: 'utf8' });
    const tools = 'tools/tuya-local-sensors.js,tools/gx/verify.js,tools/send-mail.js' + (committedGate ? `,${gateTool}` : '');
    const compareArgs = [file('live.b64'), '--commit', sha, '--plan', file('plan.json'), '--summary', file('summary.json'), '--tools', tools];
    const refused = await run(GX('compare.js'), compareArgs);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /require --allow-new-nodes/);
    assert.ok(!fs.existsSync(file('plan.json')));
    const cmp = await run(GX('compare.js'), [...compareArgs, '--allow-new-nodes']);
    assert.equal(cmp.code, 0, cmp.stderr);
    const summary = JSON.parse(fs.readFileSync(file('summary.json'), 'utf8'));
    assert.deepEqual(summary.code.slice().sort(), ['hp-cmd-fn-01.func', 'hp-page-template-01.format', 'hpls-fn-01.func']);
    assert.deepEqual(summary.trailing, ['hpc-fn-01.func']);
    assert.ok(summary.config.includes(tuya.id), 'the Tuya node is reported as config, never as code');
    assert.deepEqual([summary.onlyLive, summary.onlyRepo, summary.liveOnlyLines], [[], [added.id], []]);
    assert.equal(summary.live.source.dashboard, oldSha);
    const plan = JSON.parse(fs.readFileSync(file('plan.json'), 'utf8'));
    assert.deepEqual(plan.add, [added.id]);
    assert.deepEqual(plan.wire, []);
    assert.deepEqual(plan.groups, [added.g]);
    assert.deepEqual(Object.keys(plan.patch).sort(), ['hp-cmd-fn-01', 'hp-page-template-01', 'hpls-fn-01']);
    assert.deepEqual([plan.sha, plan.expectRev], [sha, 'rev-1']);
    assert.equal(plan.tools['tools/tuya-local-sensors.js'], crypto.createHash('sha256').update(gitShow('tools/tuya-local-sensors.js')).digest('hex'));

    // ---- step 5: window ------------------------------------------------------------------------------------
    const safe = await run(GX('window.js'), ['--for', 'stop'], env);
    assert.equal(safe.code, 0, safe.stdout + safe.stderr);
    assert.match(safe.stdout, /^SAFE for stop/);

    // ---- refused: a DHW cycle is running -------------------------------------------------------------------
    state.dhw = { state: 'DHW', run: 'x:dhw' };
    const busyWindow = await run(GX('window.js'), ['--for', 'deploy'], env);
    assert.equal(busyWindow.code, 1);
    assert.match(busyWindow.stdout, /WAIT[\s\S]*a DHW cycle is running/);
    const busy = await run(GX('deploy.js'), [file('plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /ABORT: A DHW cycle is running/);
    state.dhw = { state: 'HEATING', run: null, why: 'tank warm', outAvg: 1 };

    // ---- refused: the DHW state cannot be read (fail closed) -----------------------------------------------
    state.dhw = 'not an object';
    const blind = await run(GX('deploy.js'), [file('plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(blind.code, 1);
    assert.match(blind.stderr, /ABORT: (Cannot read the DHW state|Unexpected DHW context)/);
    state.dhw = { state: 'HEATING', run: null, why: 'tank warm', outAvg: 1 };

    // ---- step 6: dry run -----------------------------------------------------------------------------------
    const dry = await run(GX('deploy.js'), [file('plan.json')], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /tool to replace : tools\/tuya-local-sensors\.js/);
    assert.match(dry.stdout, /tool to replace : tools\/gx\/verify\.js \(new\)/);
    const findAddition = (out) => JSON.parse(out.match(/^node to add\s+: (.*)$/m)[1]);
    const reviewed = { id: added.id, type: 'http in', name: added.name, url: added.url, wires: added.wires };
    assert.deepEqual(findAddition(cmp.stdout), reviewed);
    assert.deepEqual(findAddition(dry.stdout), reviewed);
    const report = require('../tools/gx/deploy-report.js');
    const additions = report.plannedAdditions(work, sha);
    assert.deepEqual(additions, [reviewed]);
    assert.match(report.formatReport({ commit: sha, changes: [], additions }), /Planned node additions \(1; from the target commit\):[\s\S]+GET \/utcp/);
    const mail = require('../tools/gx/deploy-mail.js').buildMail({ newCommit: sha, additions });
    assert.match(mail.text, /Added nodes \(1\):[\s\S]+GET \/utcp/);
    assert.match(dry.stdout, /DRY RUN - nothing changed/);
    const untouched = () => {
        assert.equal(JSON.stringify(state.flows), original, 'the live flow is unchanged');
        assert.equal(fs.readFileSync(toolFile, 'utf8'), oldTool, 'the tool file is unchanged');
        assert.ok(!fs.existsSync(path.join(home, 'tools', 'gx')), 'no new tool folder');
        assert.deepEqual(leftovers(), [], 'no staging folder left');
    };
    untouched();
    assert.deepEqual([state.posts.length, backups().length], [0, 0], 'nothing posted, no backup made by refused or dry runs');

    // ---- refused: the POST fails; the tool files are put back ----------------------------------------------
    state.failNextPost = true;
    const failed = await run(GX('deploy.js'), [file('plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /tool restored\s+: .*tuya-local-sensors\.js/);
    assert.match(failed.stderr, /ABORT: POST \/flows -> 500/);
    assert.equal(state.posts.length, 1);
    assert.equal(JSON.stringify(state.flows), original);
    assert.equal(fs.readFileSync(toolFile, 'utf8'), oldTool, 'the previous tool file is back after a rejected POST');
    assert.ok(!fs.existsSync(path.join(home, 'tools', 'gx', 'verify.js')), 'a tool that was new is removed again');
    assert.deepEqual(leftovers(), []);
    fs.rmSync(path.join(home, '.node-red', backups()[0]), { recursive: true });

    // ---- step 7: deploy ------------------------------------------------------------------------------------
    const done = await run(GX('deploy.js'), [file('plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /DEPLOYED\s+: d#\d+ .* \[git [0-9a-f]{12}\]/);
    assert.deepEqual(state.posts[1], { type: 'nodes', rev: 'rev-1' }, 'one POST, deploy type nodes, with the revision of the snapshot');
    const after = new Map(state.flows.map((node) => [node.id, node]));
    assert.deepEqual(after.get(added.id), added);
    assert.deepEqual(after.get(added.g), { ...liveGroup, nodes: [...liveGroup.nodes, added.id] });
    assert.equal(state.flows.length, repoFlows.length);
    for (const id of behind) assert.equal(after.get(id).func, repoById.get(id).func, id);
    assert.equal(after.get(page).format, repoById.get(page).format);
    assert.equal(after.get(trailing).func, repoById.get(trailing).func + '\n', 'a trailing-newline node is not touched');
    assert.equal(after.get(tuya.id).deviceId, '${VICTRON_TEST_ID}', 'the file-secret reference is kept');
    assert.equal(after.get(repoTab.id).label, repoTab.label + ' [git ' + sha.slice(0, 12) + ']');
    assert.deepEqual(JSON.parse(TAB_STAMP.exec(after.get(repoTab.id).info)[1]), { dashboard: sha, automations: sha });
    for (const node of state.flows) {
        if (node.type === 'ui_base') assert.equal(node.site.name, repoById.get(node.id).site.name);
        if (node.type === 'ui_tab') assert.equal(node.name, repoById.get(node.id).name);
    }
    // Only the planned nodes, the version tab, and the legacy dashboard names changed.
    const before = new Map(JSON.parse(original).map((node) => [node.id, node]));
    const changedTypes = new Set(state.flows.filter((node) => JSON.stringify(node) !== JSON.stringify(before.get(node.id)))
        .filter((node) => !behind.includes(node.id) && node.id !== page && node.id !== added.id).map((node) => node.type));
    assert.deepEqual([...changedTypes].sort(), ['group', 'tab', 'ui_base', 'ui_tab']);

    const [backup] = backups();
    assert.match(backup, new RegExp('^backup-\\d{8}T\\d{6}-pre-d' + number + '$'));
    const kept = (name) => fs.readFileSync(path.join(home, '.node-red', backup, name), 'utf8');
    assert.equal(kept('flows.json'), original);
    assert.equal(kept('flows_cred.json'), '{"$":"encrypted"}');
    assert.equal(JSON.stringify(JSON.parse(kept('original-live.json')).flows), original);
    assert.equal(kept('tuya-local-sensors.js'), oldTool, 'the previous tool file is saved in the backup folder');
    assert.ok(fs.readFileSync(toolFile).equals(gitShow('tools/tuya-local-sensors.js')), 'the tool file is the one of the commit');
    assert.ok(fs.readFileSync(path.join(home, 'tools', 'gx', 'verify.js')).equals(gitShow('tools/gx/verify.js')));
    assert.ok(fs.readFileSync(path.join(home, 'tools', 'send-mail.js')).equals(gitShow('tools/send-mail.js')), 'a tool missing on the GX is added');
    if (committedGate) {
        const gate = path.join(home, gateTool);
        assert.ok(fs.readFileSync(gate).equals(gitShow(gateTool)));
        assert.match(committedGate, /^100755 /);
        if (process.platform !== 'win32') assert.equal(fs.statSync(gate).mode & 0o777, 0o755);
    }
    assert.deepEqual(leftovers(), []);

    // ---- step 8: verify, monitor, and the proof: the live code equals the commit ---------------------------
    fs.appendFileSync(logFile, '@400000006af89ae01f481075 14 Nov 18:31:03 - [info] Started modified nodes\n');
    const verify = await run(GX('verify.js'), [], env);
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, new RegExp('label   : d#' + number + ' .*\\[git ' + sha.slice(0, 12) + '\\]'));
    assert.match(verify.stdout, new RegExp('source  : .*' + sha));
    assert.match(verify.stdout, /errors since then: none/);
    const monitor = require('../tools/gx/monitor.js');
    const observed = await monitor.collect({ port: api.address().port, home, log: logFile, svstat: () => '/service/node-red-venus: up (pid 1) 900 seconds' });
    assert.deepEqual(JSON.parse(observed.flow.source), { dashboard: sha, automations: sha });
    const health = monitor.evaluate(observed);
    assert.equal(health.status, 'OK', monitor.format(health));

    const snap2 = await run(GX('live-snapshot.js'), [], env);
    fs.writeFileSync(file('live-after.b64'), snap2.stdout);
    const cmp2 = await run(GX('compare.js'), [file('live-after.b64'), '--commit', sha, '--summary', file('summary-after.json')]);
    assert.equal(cmp2.code, 0, cmp2.stderr);
    const end = JSON.parse(fs.readFileSync(file('summary-after.json'), 'utf8'));
    assert.deepEqual([end.code, end.onlyLive, end.onlyRepo], [[], [], []], 'after the deploy no code differs');
    assert.deepEqual(end.live.source, { dashboard: sha, automations: sha });
    assert.deepEqual(end.trailing, ['hpc-fn-01.func']);

    // ---- a plan is for one moment: replaying it is refused -------------------------------------------------
    const stale = await run(GX('deploy.js'), [file('plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /ABORT: The live flow changed since the comparison/);
    assert.equal(state.posts.length, 2, 'no further POST');

    // ---- a tampered plan is refused before anything is read from the GX ------------------------------------
    fs.writeFileSync(file('bad-plan.json'), JSON.stringify(Object.assign({}, plan, { flowsSha256: '0'.repeat(64) })));
    const tampered = await run(GX('deploy.js'), [file('bad-plan.json')], Object.assign({ DRY: '0' }, env));
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /ABORT: Downloaded flows\.json does not match the plan/);
});
