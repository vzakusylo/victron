// Run after building the synthetic Test GX image. The test publishes no ports and has no network.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const { once } = require('node:events');
const { adoptInputs, incidentLive, assertAdoptedInputsReport } = require('./deploy-drift-fixture');

const BASE = '0c1b770';
// origin/master at the time of the incident; pinned so the regression stays reproducible.
const TARGET = 'c933b9c534fc2faacc909b495d2b4f7f29f2db6b';
const BROKER = 'air-broker-01';
const credentials = { user: 'test-user', password: 'test-password' };
const maxBuffer = 1 << 24;
const run = promisify(execFile);

function host() {
    const root = path.join(__dirname, '..', '..');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer });
    const parent = process.env.RUNNER_TEMP || os.tmpdir();
    const dir = fs.mkdtempSync(path.join(parent, 'test-gx-deploy-'));
    try {
        const base = git('rev-parse', `${BASE}^{commit}`).toString().trim();
        fs.writeFileSync(path.join(dir, 'base.json'), git('show', `${base}:flows.json`));
        // Keep the historical topology stable while the fake raw server serves the adopted input fields.
        fs.writeFileSync(path.join(dir, 'target.json'), JSON.stringify(adoptInputs(JSON.parse(git('show', `${TARGET}:flows.json`)))));
        fs.writeFileSync(path.join(dir, 'base-sha'), base);
        for (const file of ['deploy-version.js', 'victron-secrets.js']) {
            fs.writeFileSync(path.join(dir, file), git('show', `${TARGET}:tools/${file}`));
        }
        fs.writeFileSync(path.join(dir, 'camera-mail-gate.js'), git('show', `${TARGET}:tools/camera-mail-gate.js`));
        for (const file of ['deploy.js', 'verify.js', 'admin-api.js', 'whole-flow.js']) {
            fs.copyFileSync(path.join(root, 'tools', 'gx', file), path.join(dir, file));
        }
        fs.copyFileSync(path.join(__dirname, 'deploy-drift-fixture.js'), path.join(dir, 'deploy-drift-fixture.js'));
        fs.copyFileSync(__filename, path.join(dir, 'check.js'));
        const tag = process.env.TEST_GX_TAG || 'fixture-synthetic';
        execFileSync('docker', ['run', '--rm', '--network', 'none',
            '--mount', `type=bind,source=${dir},target=/deploy-test,readonly`, '--entrypoint', 'node',
            `test-gx-nodered:${tag}`, '/deploy-test/check.js', '--in-container'], { stdio: 'inherit', timeout: 120000 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function container() {
    const app = require('/usr/src/node-red/node_modules/express')();
    const RED = require('/usr/src/node-red/node_modules/node-red');
    const { events } = require('/usr/src/node-red/node_modules/@node-red/runtime');
    const input = file => fs.readFileSync(path.join(__dirname, file));
    const baseSha = input('base-sha').toString();
    const base = JSON.parse(input('base.json'));
    const target = JSON.parse(input('target.json'));
    const { prepareFlows } = require('./victron-secrets.js');
    const { stampDeployment } = require('./deploy-version.js');
    const { prepared } = require('./whole-flow.js');
    const { createHash } = require('node:crypto');
    const digest = file => createHash('sha256').update(input(file)).digest('hex');
    const home = '/data/home/nodered', userDir = path.join(home, '.node-red');
    const settingsFile = path.join(userDir, 'settings.js');
    const previous = prepared(incidentLive(base), baseSha, prepareFlows, stampDeployment);
    const expected = prepared(target, TARGET, prepareFlows, stampDeployment);
    assert.ok(previous.some(node => node.id === BROKER && node.type === 'mqtt-broker'));
    fs.writeFileSync(path.join(userDir, 'flows.json'), JSON.stringify(previous));
    fs.writeFileSync(path.join(userDir, 'flows_cred.json'), JSON.stringify({ [BROKER]: credentials }));
    const tool = path.join(home, 'tools', 'camera-mail-gate.js');
    fs.writeFileSync(tool, '// Before test deployment\n');
    const settings = { ...require(settingsFile), userDir, flowFile: 'flows.json', credentialSecret: false,
        httpAdminRoot: '/', httpNodeRoot: '/runtime', logging: { console: { level: 'warn' } } };
    const server = http.createServer(app);
    RED.init(server, settings);
    app.use(settings.httpAdminRoot, RED.httpAdmin);
    app.use(settings.httpNodeRoot, RED.httpNode);
    const files = new Map([
        [`${baseSha}/flows.json`, 'base.json'],
        [`${TARGET}/flows.json`, 'target.json'],
        [`${TARGET}/tools/deploy-version.js`, 'deploy-version.js'],
        [`${TARGET}/tools/victron-secrets.js`, 'victron-secrets.js'],
        [`${TARGET}/tools/camera-mail-gate.js`, 'camera-mail-gate.js']
    ]);
    const raw = http.createServer((req, res) => {
        const file = files.get(req.url.replace(/^\/vzakusylo\/victron\//, ''));
        if (file) res.end(input(file)); else res.writeHead(404).end();
    });
    const listen = server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    try {
        await Promise.all([listen(server), listen(raw)]);
        const started = () => once(events, 'flows:started', { signal: AbortSignal.timeout(20000) });
        await Promise.all([started(), RED.start()]);
        const api = require('./admin-api.js')({ port: server.address().port });
        const read = async () => JSON.parse(await api('GET', '/flows'));
        const original = await read();
        assert.deepEqual(original.flows, previous);
        assert.deepEqual(RED.nodes.getCredentials(BROKER), credentials);
        const byId = new Map(expected.map(node => [node.id, node]));
        const running = new Map(previous.filter(node => isDeepStrictEqual(node, byId.get(node.id)))
            .map(({ id }) => [id, RED.nodes.getNode(id)]).filter(([, instance]) => Boolean(instance)));
        assert.ok(running.size, 'no unchanged running nodes to instrument');
        const plan = {
            repo: 'vzakusylo/victron', sha: TARGET, expectRev: original.rev, overwriteDrift: false,
            base: { sha: baseSha, flowsSha256: digest('base.json') },
            flowsSha256: digest('target.json'), stampSha256: digest('deploy-version.js'),
            prepareSha256: digest('victron-secrets.js'),
            tools: { 'tools/camera-mail-gate.js': digest('camera-mail-gate.js') }
        };
        const planFile = path.join(userDir, 'deploy-test-plan.json');
        fs.writeFileSync(planFile, JSON.stringify(plan));
        const deploy = DRY => run(process.execPath, [path.join(__dirname, 'deploy.js'), planFile], {
            env: { ...process.env, DRY, VICTRON_HOME: home, VICTRON_NODE_RED_SETTINGS: settingsFile,
                VICTRON_API_PORT: String(server.address().port), VICTRON_RAW_BASE: `http://127.0.0.1:${raw.address().port}` },
            timeout: 45000, maxBuffer
        });
        const dry = (await deploy('1')).stdout;
        console.log(dry.trim());
        assertAdoptedInputsReport(dry);
        assert.match(dry, /nodes added +: 8/);
        assert.match(dry, /nodes removed +: 2/);
        assert.match(dry, /hp-page-template-01 .*resendOnRefresh, storeOutMessages/);
        assert.match(dry, /DRY RUN - nothing changed/);
        assert.equal((await read()).rev, original.rev);
        assert.equal(fs.readFileSync(tool, 'utf8'), '// Before test deployment\n');
        const [, result] = await Promise.all([started(), deploy('0')]);
        const apply = result.stdout;
        assert.match(apply, /DEPLOYED +: d#230/);
        console.log(apply.split('\n').find(line => line.startsWith('DEPLOYED')));
        const after = await read();
        assert.notEqual(after.rev, original.rev);
        assert.deepEqual(after.flows, expected);
        assert.deepEqual(RED.nodes.getCredentials(BROKER), credentials);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDir, 'flows_cred.json')))[BROKER], credentials);
        assert.deepEqual(fs.readFileSync(tool), input('camera-mail-gate.js'));
        assert.equal(fs.statSync(tool).mode & 0o777, 0o755);
        console.log(`PASS: stamped target returned by GET /flows; dummy MQTT credentials kept for ${BROKER}.`);
        const retained = [...running].filter(([id, instance]) => RED.nodes.getNode(id) === instance);
        assert.ok(retained.length, 'all unchanged running nodes were restarted');
        console.log(`PASS: ${retained.length} unchanged node instances retained (for example ${retained[0][0]}).`);
        await assert.rejects(api('POST', '/flows', JSON.stringify({ rev: original.rev, flows: expected }),
            { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' }), { status: 409 });
        assert.equal((await read()).rev, after.rev);
        console.log('PASS: stale revision returned HTTP 409; no flow was written.');
        plan.base = { sha: TARGET, flowsSha256: plan.flowsSha256 };
        plan.expectRev = after.rev;
        fs.writeFileSync(planFile, JSON.stringify(plan));
        fs.writeFileSync(tool, '// Wrong tool version\n');
        assert.match((await deploy('0')).stdout, /DEPLOYED .*tools only/);
        assert.equal((await read()).rev, after.rev);
        assert.deepEqual(fs.readFileSync(tool), input('camera-mail-gate.js'));
    } finally {
        raw.close();
        server.close();
        await RED.stop();
    }
}

if (process.argv[2] === '--in-container') {
    const finish = code => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
    container().then(() => finish(0), error => {
        console.error(error.stderr || error.stack);
        finish(1);
    });
} else host();
