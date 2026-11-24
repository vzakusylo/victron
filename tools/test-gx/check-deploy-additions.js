// Reproduce d#205 -> d#206 against real Node-RED in the synthetic Test GX image.
// Run from the repository after building the fixture image. No host ports or network.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { gzipSync } = require('node:zlib');

const expected = ['lay-g-utcp', 'utcp-http-get-01', 'utcp-http-post-01', 'utcp-server-fn-01', 'utcp-http-response-01', 'utcp-log-exec-01'];

function host() {
    const root = path.join(__dirname, '..', '..');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 27 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-additions-'));
    try {
        const sha = git('rev-parse', '084387f^{commit}').toString().trim();
        const original = git('show', '523ba74:flows.json');
        fs.writeFileSync(path.join(dir, 'before.json'), original);
        for (const [file, blob] of [['flows.json', 'flows.json'], ['stamp.js', 'tools/deploy-version.js']]) {
            fs.writeFileSync(path.join(dir, file), git('show', sha + ':' + blob));
        }
        for (const file of ['deploy.js', 'node-additions.js', 'admin-api.js']) fs.copyFileSync(path.join(root, 'tools', 'gx', file), path.join(dir, file));
        fs.copyFileSync(__filename, path.join(dir, 'check.js'));
        const { snapshot } = require('../gx/live-snapshot.js');
        const live = path.join(dir, 'live.b64');
        const plan = path.join(dir, 'plan.json');
        fs.writeFileSync(live, gzipSync(JSON.stringify(snapshot(JSON.parse(original), 'test-only', { topology: true }))).toString('base64'));
        const output = execFileSync(process.execPath, [path.join(root, 'tools', 'gx', 'compare.js'), live, '--commit', sha,
            '--plan', plan, '--allow-new-nodes'], { cwd: root, encoding: 'utf8' });
        console.log(output.split('\n').filter((line) => /^(plan written|node to add|wire patch)/.test(line)).join('\n'));
        execFileSync('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${dir},target=/d1,readonly`,
            '--entrypoint', 'node', 'test-gx-nodered:fixture-synthetic', '/d1/check.js', '--in-container'], { stdio: 'inherit', timeout: 90000 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function container() {
    const home = '/data/home/nodered';
    const dir = path.join(home, '.node-red');
    const plan = JSON.parse(fs.readFileSync('/d1/plan.json'));
    assert.deepEqual(plan.add, expected);
    assert.deepEqual(plan.wire, ['hp-hist-fn-01']);
    fs.copyFileSync('/d1/before.json', path.join(dir, 'flows.json'));
    const red = spawn(process.execPath, ['/usr/src/node-red/node_modules/node-red/red.js', '--userDir', dir, '--safe'], {
        cwd: home, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    for (const stream of [red.stdout, red.stderr]) stream.on('data', (chunk) => { log += chunk; });
    const files = new Map([
        [`/vzakusylo/victron/${plan.sha}/flows.json`, '/d1/flows.json'],
        [`/vzakusylo/victron/${plan.sha}/tools/deploy-version.js`, '/d1/stamp.js']
    ]);
    const raw = http.createServer((req, res) => {
        if (!files.has(req.url)) { res.writeHead(404); res.end(); return; }
        res.end(fs.readFileSync(files.get(req.url)));
    });
    const run = promisify(execFile);
    const readFlow = async () => JSON.parse((await run('curl', ['-fsS', '-H', 'Node-RED-API-Version: v2', 'http://127.0.0.1:1880/flows'],
        { maxBuffer: 1 << 27 })).stdout);
    try {
        await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
        let before;
        for (let i = 0; i < 40 && !before && red.exitCode === null; i++) {
            try { before = await readFlow(); }
            catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
        }
        assert.ok(before, 'Node-RED did not start');
        assert.deepEqual(before.flows, JSON.parse(fs.readFileSync('/d1/before.json')));
        plan.expectRev = before.rev;
        fs.writeFileSync('/tmp/d1-plan.json', JSON.stringify(plan));
        const env = { ...process.env, VICTRON_HOME: home, VICTRON_RAW_BASE: `http://127.0.0.1:${raw.address().port}` };
        const deploy = (DRY) => run(process.execPath, ['/d1/deploy.js', '/tmp/d1-plan.json'], { env: { ...env, DRY }, timeout: 30000 });
        assert.match((await deploy('1')).stdout, /DRY RUN - nothing changed/);
        assert.equal((await readFlow()).rev, before.rev);
        assert.match((await deploy('0')).stdout, /DEPLOYED\s+: d#206/);
        const after = await readFlow();
        assert.equal(after.flows.length, before.flows.length + expected.length);
        const ids = new Set(expected);
        const target = JSON.parse(fs.readFileSync('/d1/flows.json'));
        assert.deepEqual(after.flows.filter((n) => ids.has(n.id)), target.filter((n) => ids.has(n.id)));
        console.log('PASS: Node-RED added and verified all six d#206 UTCP nodes with a nodes deployment.');
    } catch (error) {
        console.error(log);
        throw error;
    } finally {
        raw.close();
        red.kill();
    }
}

if (process.argv[2] === '--in-container') container().catch((error) => { console.error(error); process.exitCode = 1; });
else host();
