'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { prepared } = require('../tools/gx/whole-flow.js');
const { prepareFlows } = require('../tools/victron-secrets.js');
const { stampDeployment } = require('../tools/deploy-version.js');
const createAdminApi = require('../tools/gx/admin-api.js');
const { ROOT } = require('./harness');

const GX = path.join(ROOT, 'tools', 'gx');
const run = promisify(execFile);
const curlAvailable = spawnSync('curl', ['--version']).status === 0;
const hash = data => createHash('sha256').update(data).digest('hex');
const listen = async (t, handler, options) => {
    const server = http.createServer(options, handler);
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return server.address().port;
};
const resultOf = promise => promise.catch(error => {
    assert.equal(typeof error.code, 'number', String(error));
    return error;
});

test('GX admin API opens a fresh connection for a 1 MiB POST after the server idle timeout', async t => {
    const sockets = new Set(), connections = [], sizes = [];
    const port = await listen(t, async (req, res) => {
        sockets.add(req.socket);
        connections.push(req.headers.connection);
        let size = 0;
        for await (const chunk of req) size += chunk.length;
        sizes.push(size);
        res.end('{}');
    }, { keepAliveTimeout: 100, keepAliveTimeoutBuffer: 0 });
    const api = createAdminApi({ port });
    await api('GET', '/flows');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await api('POST', '/flows', Buffer.alloc(1024 * 1024)), '{}');
    assert.deepEqual(sizes, [0, 1024 * 1024]);
    assert.deepEqual(connections, ['close', 'close']);
    assert.equal(sockets.size, 2);
});

function repoFlows() {
    return [
        { id: 'tab', type: 'tab', label: 'd#1 GX', info: '' },
        { id: 'ui', type: 'ui_base', site: { name: 'GX' } },
        { id: 'page', type: 'ui_tab', name: 'Heat' },
        { id: 'tuya', type: 'tuya-smart-device', deviceName: 'Test', deviceId: '', deviceKey: '', deviceIp: '' },
        { id: 'hpa-fn-01', type: 'function', z: 'tab', func: 'return msg;', libs: [{ module: 'fs', var: 'fs' }], wires: [[]] },
        { id: 'obsolete', type: 'inject', z: 'tab', x: 20, y: 20 }
    ];
}

async function harness(t, opts = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-whole-flow-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const baseSha = 'a'.repeat(40), sha = 'b'.repeat(40);
    const base = repoFlows(), target = repoFlows().filter(node => node.id !== 'obsolete');
    if (opts.removeBroker) base.push({ id: 'old-broker', type: 'mqtt-broker', name: 'Private broker' });
    target[0].label = 'd#2 GX';
    target.push({ id: 'new', type: 'ui_template', format: 'é', storeOutMessages: false });
    if (opts.module) {
        for (const flows of [base, target]) flows[4].libs[0].module = opts.module;
    }
    const original = prepared(base, baseSha, prepareFlows, stampDeployment);
    original[4].x = 412;
    original[4].y = 23;
    original[4].func += '\r\n';
    if (opts.drift) original[4].g = 'private-group-value';
    if (opts.adopt) {
        original[4].onlyChanges = target[4].onlyChanges = false;
        original.reverse();
    }
    const expected = prepared(target, sha, prepareFlows, stampDeployment);
    const data = (file) => fs.readFileSync(path.join(ROOT, 'tools', file));
    const stamp = data('deploy-version.js'), prepare = data('victron-secrets.js');
    const baseBlob = JSON.stringify(base), targetBlob = JSON.stringify(target);
    const files = new Map([
        [`${baseSha}/flows.json`, baseBlob], [`${sha}/flows.json`, targetBlob],
        [`${sha}/tools/deploy-version.js`, stamp], [`${sha}/tools/victron-secrets.js`, prepare]
    ]);
    const raw = await listen(t, (req, res) => {
        const file = files.get(req.url.replace(/^\/vzakusylo\/victron\//, ''));
        res.writeHead(file === undefined ? 404 : 200).end(file);
    });
    const posts = [];
    let rev = 'initial-rev', flows = original, getCount = 0;
    const port = await listen(t, async (req, res) => {
        if (req.url.startsWith('/context/')) {
            if (req.url.endsWith('/dhwView')) {
                if (opts.healthFail) res.writeHead(500);
                res.end('{}');
                return;
            }
            if (opts.retryDhw === 'always' || (opts.retryDhw && !getCount++)) { req.socket.destroy(); return; }
            res.end(JSON.stringify({ msg: JSON.stringify({ state: opts.dhw || 'HEATING' }) }));
        } else if (req.method === 'POST' && req.url === '/flows') {
            const body = [];
            for await (const chunk of req) body.push(chunk);
            const payload = JSON.parse(Buffer.concat(body));
            posts.push({ payload, headers: req.headers });
            if (opts.conflict || payload.rev !== rev) { res.writeHead(409).end(); return; }
            if (opts.postStatus) { res.writeHead(opts.postStatus).end(); return; }
            if (opts.postReset === 'during-response') {
                res.writeHead(200).flushHeaders();
                setTimeout(() => req.socket.destroy(), 100);
                return;
            }
            if (opts.postReset === 'always' || (opts.postReset === 'before-apply' && posts.length === 1)) {
                req.socket.destroy();
                return;
            }
            rev = `rev-${posts.length}`;
            flows = payload.flows;
            if (opts.postReset === 'after-apply' && posts.length === 1) { req.socket.destroy(); return; }
            if (opts.postReset === 'other-flow' && posts.length === 1) {
                flows = original.map(node => node.id === 'hpa-fn-01' ? { ...node, func: 'return null;' } : node);
                req.socket.destroy();
                return;
            }
            res.end(JSON.stringify({ rev }));
        } else if (req.url === '/flows') {
            const sent = opts.verifyFail && posts.length === 1 ? flows.map(node => node.id === 'new'
                ? { ...node, storeOutMessages: true } : node) : flows;
            res.end(JSON.stringify({ flows: sent, rev }));
        } else res.writeHead(404).end();
    });
    const nodeRedDir = path.join(home, '.node-red');
    fs.mkdirSync(nodeRedDir);
    fs.writeFileSync(path.join(nodeRedDir, 'flows.json'), JSON.stringify(original));
    fs.writeFileSync(path.join(nodeRedDir, 'flows_cred.json'), '{"fake":"credentials"}');
    const settings = path.join(home, 'settings.js');
    fs.writeFileSync(settings, 'module.exports = { functionExternalModules: true };');
    const planFile = path.join(home, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
        repo: 'vzakusylo/victron', sha, expectRev: rev, overwriteDrift: Boolean(opts.overwrite),
        base: { sha: baseSha, flowsSha256: hash(baseBlob) }, flowsSha256: hash(targetBlob),
        stampSha256: hash(stamp), prepareSha256: hash(prepare), tools: {}
    }));
    const invoke = (file, args, env = {}) => resultOf(run(process.execPath, [path.join(GX, file), ...args], {
        timeout: 20000, env: { ...process.env, VICTRON_HOME: home, VICTRON_NODE_RED_SETTINGS: settings,
            VICTRON_RAW_BASE: `http://127.0.0.1:${raw}`, VICTRON_API_PORT: String(port), ...env }
    }));
    return { original, expected, posts, nodeRedDir, invoke, deploy: (DRY = '0') => invoke('deploy.js', [planFile], { DRY }) };
}

test('equal baseline (layout and trailing newline only) deploys the entire stamped target with v2, nodes and rev', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { retryDhw: true });
    const dry = await h.deploy('1');
    assert.match(dry.stdout, /drift gate +: live flow equals a{40}/);
    assert.match(dry.stdout, /DRY RUN - nothing changed/);
    assert.match(dry.stderr, /api retry +: GET \/context\/node\/hpa-fn-01\/dhw/);
    assert.doesNotMatch(dry.stderr, /Flow-only rollback/);
    assert.equal(h.posts.length, 0);
    assert.equal(fs.readdirSync(h.nodeRedDir).length, 2);
    const result = await h.deploy();
    assert.match(result.stdout, /DEPLOYED +: d#2 GX \[git b{12}\]/, result.stderr);
    assert.equal(h.posts.length, 1);
    const { headers, payload } = h.posts[0];
    assert.equal(headers['node-red-api-version'], 'v2');
    assert.equal(headers['node-red-deployment-type'], 'nodes');
    assert.deepEqual(payload, { rev: 'initial-rev', flows: h.expected });
    const backup = fs.readdirSync(h.nodeRedDir).find(file => file.startsWith('backup-'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.nodeRedDir, backup, 'original-live.json'))).flows, h.original);
    assert.equal(fs.readFileSync(path.join(h.nodeRedDir, backup, 'flows_cred.json'), 'utf8'), '{"fake":"credentials"}');
});

test('dry run warns that a removed broker may need credential recovery', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { removeBroker: true });
    const result = await h.deploy('1');
    assert.match(result.stdout, /DRY RUN - nothing changed/);
    assert.match(result.stderr, /WARNING: removed credential-capable nodes: old-broker \(mqtt-broker\)/);
    assert.match(result.stderr, /Flow-only rollback cannot restore their credentials;.*backup.*flows_cred\.json/);
    assert.doesNotMatch(result.stderr, /Private broker|obsolete|tuya/);
    assert.equal(h.posts.length, 0);
    assert.equal(fs.readdirSync(h.nodeRedDir).length, 2);
});

test('GX dry run accepts adopted drift and omits the adopted field from changes', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { adopt: true });
    const result = await h.deploy('1');
    assert.match(result.stdout, /^adopted drift +: hpa-fn-01 onlyChanges$/m);
    assert.doesNotMatch(result.stdout, /^ +hpa-fn-01 /m);
    assert.match(result.stdout, /DRY RUN - nothing changed/, result.stderr);
    assert.equal(h.posts.length, 0);
});

test('drift reports only ID and changed field, writes no backup, and the explicit override works', { skip: !curlAvailable }, async t => {
    const refused = await harness(t, { drift: true });
    const stop = await refused.deploy();
    assert.match(stop.stderr, /ABORT: live flow differs from a{40} \(drift\):\r?\nhpa-fn-01 g/);
    assert.doesNotMatch(stop.stderr, /private-group-value/);
    assert.equal(refused.posts.length, 0);
    assert.equal(fs.readdirSync(refused.nodeRedDir).length, 2);
    const snap = await refused.invoke('live-snapshot.js', ['--drift']);
    const decoded = gunzipSync(Buffer.from(snap.stdout.trim(), 'base64')).toString();
    assert.doesNotMatch(decoded, /private-group-value|return msg|deviceKey.*VICTRON/);

    const allowed = await harness(t, { drift: true, overwrite: true });
    const applied = await allowed.deploy();
    assert.match(applied.stdout, /overwrite drift +: live flow differs/);
    assert.match(applied.stdout, /DEPLOYED/, applied.stderr);
    assert.deepEqual(allowed.posts.map(({ payload }) => payload.flows), [allowed.expected]);
});

test('409 is not retried or rolled back', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { conflict: true });
    assert.match((await h.deploy()).stderr, /^ABORT: the live flow changed during the deploy\s*$/);
    assert.equal(h.posts.length, 1);
});

test('a reset with unchanged live revision retries the identical POST once', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'before-apply' });
    const result = await h.deploy();
    assert.match(result.stderr, /api retry +: POST \/flows \(live rev unchanged, attempt 2\/2: socket hang up\)/);
    assert.match(result.stdout, /DEPLOYED +: d#2 GX/, result.stderr);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[0].payload, h.posts[1].payload);
});

test('two resets with unchanged live revision exhaust the retry', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'always' });
    assert.match((await h.deploy()).stderr, /ABORT: POST \/flows failed after 2 attempts: socket hang up/);
    assert.equal(h.posts.length, 2);
});

test('a reset after applying the target verifies the changed revision without reposting', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'after-apply' });
    const result = await h.deploy();
    assert.match(result.stdout, /DEPLOYED +: d#2 GX.*\(rev rev-1\)/, result.stderr);
    assert.doesNotMatch(result.stderr, /api retry/);
    assert.equal(h.posts.length, 1);
});

test('a reset with an unrelated revision goes to verification without retry or rollback', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'other-flow' });
    const result = await h.deploy();
    assert.match(result.stderr, /ROLLBACK NOT ATTEMPTED: no confirmed deployment revision/);
    assert.match(result.stderr, /VERIFY FAILED: live flow differs from the stamped target/);
    assert.doesNotMatch(result.stderr, /api retry/);
    assert.equal(h.posts.length, 1);
});

test('a reset after applying the target still allows rollback if health verification fails', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'after-apply', healthFail: true });
    const result = await h.deploy();
    assert.match(result.stderr, /rollback +: restored the original flow/);
    assert.match(result.stderr, /VERIFY FAILED: GET .* HTTP 500/);
    assert.doesNotMatch(result.stderr, /api retry/);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[1].payload, { rev: 'rev-1', flows: h.original });
});

test('a reset after response headers does not retry the POST', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postReset: 'during-response' });
    assert.match((await h.deploy()).stderr, /^ABORT: POST \/flows failed after 1 attempt: aborted\s*$/);
    assert.equal(h.posts.length, 1);
});

test('a POST HTTP 500 is not retried even if the revision is unchanged', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { postStatus: 500 });
    assert.match((await h.deploy()).stderr, /^ABORT: POST \/flows failed after 1 attempt: HTTP 500\s*$/);
    assert.equal(h.posts.length, 1);
});

test('module preflight checks even unchanged target functions and DHW still blocks apply', { skip: !curlAvailable }, async t => {
    const missing = await harness(t, { module: 'not-installed-deploy-fixture' });
    assert.match((await missing.deploy()).stderr, /hpa-fn-01\.libs: module not-installed-deploy-fixture is not available/);
    assert.equal(missing.posts.length, 0);
    const blocked = await harness(t, { dhw: 'DHW' });
    assert.match((await blocked.deploy()).stderr, /A DHW cycle is running/);
    assert.equal(blocked.posts.length, 0);
});

test('exhausted DHW read retries name the request and prevent all writes', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { retryDhw: 'always' });
    const result = await h.deploy();
    assert.match(result.stderr, /ABORT: GET \/context\/node\/hpa-fn-01\/dhw failed after 3 attempts: socket hang up/);
    assert.equal(h.posts.length, 0);
    assert.equal(fs.readdirSync(h.nodeRedDir).length, 2);
});

test('verification failure rolls back the backed up original using the accepted revision', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { verifyFail: true });
    const result = await h.deploy();
    assert.match(result.stderr, /rollback +: restored the original flow/);
    assert.match(result.stderr, /VERIFY FAILED:.*\nnew storeOutMessages/);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[1].payload, { rev: 'rev-1', flows: h.original });
    assert.equal(h.posts[1].headers['node-red-api-version'], 'v2');
    assert.equal(h.posts[1].headers['node-red-deployment-type'], 'nodes');
});

test('a verification health read failure rolls back with the accepted revision', { skip: !curlAvailable }, async t => {
    const h = await harness(t, { healthFail: true });
    const result = await h.deploy();
    assert.match(result.stderr, /rollback +: restored the original flow/);
    assert.match(result.stderr, /VERIFY FAILED: GET \/context\/flow\/tab\/dhwView failed after 1 attempt: HTTP 500/);
    assert.deepEqual(h.posts[1].payload, { rev: 'rev-1', flows: h.original });
});

test('planner reports live-to-target changes, accepts adopted drift and rejects other drift', async t => {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const refs = ['0c1b770', 'c933b9c534fc2faacc909b495d2b4f7f29f2db6b'];
    if (git('rev-parse', '--is-shallow-repository') === 'true' &&
        refs.some(ref => spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: ROOT }).status !== 0)) {
        return t.skip('historical replay requires the full Git history (covered by Check and Test GX)');
    }
    const [base, target] = refs.map(ref => git('rev-parse', `${ref}^{commit}`));
    const before = JSON.parse(execFileSync('git', ['show', base + ':flows.json'], { cwd: ROOT, maxBuffer: 1 << 24 }));
    const expected = prepared(before, base, prepareFlows, stampDeployment);
    const port = await listen(t, (_req, res) => res.end(JSON.stringify({ rev: 'planner-rev', flows: expected })));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-planner-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const liveFile = path.join(dir, 'live.b64'), plan = path.join(dir, 'plan.json');
    const planRun = async () => {
        const env = { ...process.env, VICTRON_API_PORT: String(port) };
        const snap = await run(process.execPath, [path.join(GX, 'live-snapshot.js'), '--drift'], { env });
        fs.writeFileSync(liveFile, snap.stdout);
        return resultOf(run(process.execPath, [path.join(GX, 'compare.js'), liveFile, '--commit', target, '--plan', plan], { cwd: ROOT }));
    };
    expected[0].x = 2;
    expected[0].y = 9;
    const report = await planRun();
    assert.match(report.stdout, /nodes added +: 8/);
    assert.match(report.stdout, /nodes removed +: 2/);
    assert.match(report.stdout, /hp-page-template-01 \(ui_template "[^"]*"\): .*resendOnRefresh, storeOutMessages/);
    assert.equal(JSON.parse(fs.readFileSync(plan)).expectRev, 'planner-rev');
    fs.unlinkSync(plan);
    const template = expected.find(node => node.id === 'hp-page-template-01');
    template.storeOutMessages = false;
    expected.reverse();
    const adopted = await planRun();
    assert.match(adopted.stdout, /^adopted drift +: hp-page-template-01 storeOutMessages$/m);
    assert.match(adopted.stdout, /^ +hp-page-template-01 .*resendOnRefresh$/m);
    assert.equal(JSON.parse(fs.readFileSync(plan)).expectRev, 'planner-rev');
    fs.unlinkSync(plan);
    template.storeOutMessages = 'private-value';
    const refused = await planRun();
    assert.match(refused.stderr, /ABORT: live flow differs from [a-f0-9]{40} \(drift\):\r?\nhp-page-template-01 storeOutMessages/);
    assert.doesNotMatch(refused.stderr, /private-value/);
    assert.equal(fs.existsSync(plan), false);
});
