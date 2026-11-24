#!/usr/bin/env node
// [DRY=0] node deploy.js PLAN.json on the GX. See docs/gx-deploy.md.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { isBuiltin, builtinModules } = require('module');
const flow = require('./whole-flow.js');
const { verifyHealth } = require('./verify.js');
const api = require('./admin-api.js')();

const HOME = process.env.VICTRON_HOME || '/data/home/nodered';
const RAW_BASE = process.env.VICTRON_RAW_BASE || 'https://raw.githubusercontent.com';
const NODE_RED_DIR = path.join(HOME, '.node-red');
const NODE_RED_SETTINGS = process.env.VICTRON_NODE_RED_SETTINGS || '/usr/lib/node_modules/node-red/venus-settings.js';
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const fail = message => { throw new Error(message); };
const isCoreModule = isBuiltin || (name => builtinModules.includes(name.replace(/^node:/, '')));
const hasCredentials = flows => flows.some(node => Object.hasOwn(node, 'credentials'));
const post = (flows, rev) => {
    if (hasCredentials(flows)) fail('Refusing to send flow credentials.');
    return api('POST', '/flows', JSON.stringify({ flows, rev }),
        { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' });
};

function preflightModules(nodes) {
    const modules = new Map();
    for (const node of nodes) {
        if (!Object.hasOwn(node, 'libs')) continue;
        if (!Array.isArray(node.libs)) fail(node.id + '.libs: expected a module list.');
        for (const entry of node.libs) {
            const name = entry?.module;
            if (typeof name !== 'string' || (!isCoreModule(name) && !/^(?:@[\w-]+\/)?[\w-][\w.-]*$/.test(name))) {
                fail(node.id + '.libs: invalid module name.');
            }
            if (!modules.has(name)) modules.set(name, node.id);
        }
    }
    if (!modules.size) return;
    let settings;
    try { settings = require(NODE_RED_SETTINGS); }
    catch { fail('Cannot load Node-RED service settings at ' + NODE_RED_SETTINGS + '.'); }
    if (settings.functionExternalModules === false) fail('Node-RED functionExternalModules is disabled on the GX.');
    const userDir = settings.userDir || NODE_RED_DIR;
    const paths = [userDir, path.join(userDir, 'externalModules'), path.dirname(NODE_RED_SETTINGS)];
    for (const [name, id] of modules) {
        let resolved = 'builtin';
        if (!isCoreModule(name)) {
            try { resolved = require.resolve(name, { paths }); }
            catch { fail(id + '.libs: module ' + name + ' is not available to Node-RED on the GX'); }
        }
        console.log('module ' + name + ' : ' + resolved);
    }
}

function readPlan(file) {
    const plan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
    const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!/^[\w.-]+\/[\w.-]+$/.test(plan.repo || '') || !sha(plan.sha) || !sha(plan.base?.sha) ||
        ![plan.flowsSha256, plan.base.flowsSha256, plan.stampSha256, plan.prepareSha256].every(hash) ||
        typeof plan.expectRev !== 'string' || !plan.expectRev || typeof plan.overwriteDrift !== 'boolean') {
        fail('Invalid whole-flow plan: repository, commits, hashes, revision and drift policy are required.');
    }
    if (!plan.tools || typeof plan.tools !== 'object' || Array.isArray(plan.tools)) fail('Invalid plan.tools.');
    for (const [tool, digest] of Object.entries(plan.tools)) {
        if (!/^tools\/(?:gx\/)?[\w-][\w.-]*\.js$/.test(tool) || !hash(digest)) fail('Invalid plan.tools entry.');
    }
    return plan;
}

async function checkDhw(flows) {
    if (!flows.some(node => node.id === 'hpa-fn-01')) return;
    const raw = JSON.parse(await api('GET', '/context/node/hpa-fn-01/dhw'));
    let dhw = null;
    if (Object.keys(raw).length && raw.format !== 'undefined') {
        try { dhw = JSON.parse(raw.msg); } catch { fail('Cannot read the DHW state. Not deploying.'); }
        if (!dhw || typeof dhw.state !== 'string') fail('Unexpected DHW context. Not deploying.');
    }
    console.log('DHW state       : ' + (dhw ? dhw.state + (dhw.run ? ' (cycle running)' : '') : 'no context'));
    if (dhw && (dhw.state !== 'HEATING' || dhw.run)) fail('A DHW cycle is running. Deploy after it ends.');
}

function makeToolJobs(tools, download) {
    const jobs = [];
    for (const [tool, hash] of Object.entries(tools)) {
        const staged = download(tool, hash);
        execFileSync(process.execPath, ['--check', staged]);
        const dest = path.join(HOME, tool);
        const current = fs.existsSync(dest) ? sha256(Buffer.from(fs.readFileSync(dest, 'latin1').replace(/\r/g, ''), 'latin1')) : null;
        const executable = tool === 'tools/camera-mail-gate.js';
        const mode = executable ? 0o755 : 0o644;
        const modeOk = !executable || (current && (fs.statSync(dest).mode & 0o777) === mode);
        if (current === hash && modeOk) console.log('tool up to date : ' + tool);
        else {
            console.log('tool to replace : ' + tool + (current ? '' : ' (new)'));
            jobs.push({ staged, dest, mode });
        }
    }
    return jobs;
}

function replaceTools(jobs, backup, replaced) {
    if (!jobs.length) return;
    const toolsDir = path.join(HOME, 'tools');
    const owner = fs.statSync(toolsDir);
    for (const { staged, dest, mode } of jobs) {
        let saved = null;
        const folder = path.dirname(dest);
        if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { mode: 0o755 }); fs.chownSync(folder, owner.uid, owner.gid); }
        if (!fs.lstatSync(folder).isDirectory()) fail(folder + ' is not a directory.');
        const old = fs.lstatSync(dest, { throwIfNoEntry: false });
        if (old?.isFile()) {
            saved = path.join(backup, path.relative(toolsDir, dest).replace(/[\\/]/g, '__'));
            fs.copyFileSync(dest, saved, fs.constants.COPYFILE_EXCL);
            fs.chownSync(saved, owner.uid, owner.gid);
            fs.chmodSync(saved, old.mode & 0o777);
        }
        fs.chownSync(staged, owner.uid, owner.gid);
        fs.chmodSync(staged, mode);
        fs.renameSync(staged, dest); // Replace an existing symlink rather than following it.
        replaced.push({ dest, saved });
        console.log('tool replaced   : ' + dest);
    }
}

function restoreTools(replaced) {
    for (const { dest, saved } of replaced) {
        try {
            if (saved) fs.renameSync(saved, dest); else fs.rmSync(dest, { force: true });
            console.error('tool restored   : ' + dest);
        } catch (error) {
            console.error('TOOL NOT RESTORED: ' + dest + ' (' + error.message + '); previous copy: ' + (saved || 'none'));
        }
    }
}

const revFrom = text => {
    const { rev } = JSON.parse(text);
    if (typeof rev !== 'string' || !rev) fail('Node-RED did not return a revision.');
    return rev;
};

async function apply(target, original, originalText, label, jobs, sameDeployment) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    const backup = path.join(NODE_RED_DIR, 'backup-' + timestamp + '-pre-' + /d#\d+/.exec(label)[0].replace('#', ''));
    fs.mkdirSync(backup, { mode: 0o700 });
    for (const file of ['flows.json', 'flows_cred.json']) {
        fs.copyFileSync(path.join(NODE_RED_DIR, file), path.join(backup, file));
    }
    fs.writeFileSync(path.join(backup, 'original-live.json'), originalText, { mode: 0o600 });
    console.log('backup          : ' + backup);

    const replaced = [];
    let reply;
    try {
        replaceTools(jobs, backup, replaced);
    } catch (error) {
        restoreTools(replaced);
        throw error;
    }
    if (sameDeployment) {
        // Node-RED hashes the flow as its revision; a tool-only update must not repost it.
        try {
            const after = JSON.parse(await api('GET', '/flows'));
            if (after.rev !== original.rev) fail('the live flow changed during the tool update');
            await verifyHealth(after);
        } catch (error) {
            restoreTools(replaced);
            throw error;
        }
        console.log('DEPLOYED        : ' + label + ' (tools only; rev ' + original.rev.slice(0, 12) + ')');
        return;
    }
    try {
        reply = await post(target, original.rev);
    } catch (error) {
        if (error.status === 409) {
            restoreTools(replaced);
            fail('the live flow changed during the deploy');
        }
        if (replaced.length) {
            // A transport failure can come after Node-RED accepted the flow.
            let liveRev;
            try { liveRev = revFrom(await api('GET', '/flows')); }
            catch (readError) { console.error('Cannot determine flow state: ' + readError.message); }
            if (liveRev === original.rev) restoreTools(replaced);
            else console.error('Flow state after the failed step is uncertain; tool files left as replaced. Check ' + backup);
        }
        throw error;
    }

    let deployedRev;
    try {
        deployedRev = revFrom(reply);
        if (deployedRev === original.rev) {
            deployedRev = undefined;
            fail('Node-RED did not return a new revision.');
        }
        await new Promise(resolve => setTimeout(resolve, 4000));
        const after = JSON.parse(await api('GET', '/flows'));
        if (after.rev !== deployedRev) fail('Live revision does not match the deployed revision.');
        flow.checkDrift(flow.fingerprints(target), flow.fingerprints(after.flows), 'the stamped target', false, false);
        if (flow.versionTab(after.flows).label !== label) fail('The stamped version label does not match.');
        await verifyHealth(after);
    } catch (error) {
        if (deployedRev) {
            try {
                await post(original.flows, deployedRev);
                restoreTools(replaced);
                console.error('rollback        : restored the original flow');
            } catch (rollbackError) {
                console.error('ROLLBACK FAILED: ' + rollbackError.message + '; backup: ' + backup);
            }
        } else {
            console.error('ROLLBACK NOT ATTEMPTED: no confirmed deployment revision; backup: ' + backup);
        }
        fail('VERIFY FAILED: ' + error.message);
    }
    console.log('DEPLOYED        : ' + label + ' (rev ' + deployedRev.slice(0, 12) + ')');
    console.log('Now run tools/gx/verify.js, and again after 15-20 minutes.');
}

(async () => {
    if (!process.argv[2]) fail('Usage: [DRY=0] node deploy.js PLAN.json');
    const plan = readPlan(process.argv[2]);
    const stage = fs.mkdtempSync(path.join(HOME, '.gx-deploy-stage.'));
    try {
        const download = (file, want, sha = plan.sha) => {
            const url = RAW_BASE + '/' + plan.repo + '/' + sha + '/' + file;
            const out = path.join(stage, sha + '__' + file.replace(/\//g, '__'));
            try { execFileSync('curl', ['-fsSL', '--max-time', '120', '-o', out, url], { stdio: 'ignore' }); }
            catch { execFileSync('wget', ['-q', '-T', '120', '-O', out, url], { stdio: 'ignore' }); }
            if (sha256(fs.readFileSync(out)) !== want) fail('Downloaded ' + file + ' does not match the plan (is the commit pushed?).');
            return out;
        };
        const read = (hash, sha) => JSON.parse(fs.readFileSync(download('flows.json', hash, sha), 'utf8'));
        const base = read(plan.base.flowsSha256, plan.base.sha);
        const target = read(plan.flowsSha256);
        const { stampDeployment } = require(download('tools/deploy-version.js', plan.stampSha256));
        const { prepareFlows } = require(download('tools/victron-secrets.js', plan.prepareSha256));
        const originalText = await api('GET', '/flows');
        const original = JSON.parse(originalText);
        if (original.rev !== plan.expectRev) fail('The live flow changed since the comparison. Take a new snapshot and plan.');
        const liveTab = flow.versionTab(original.flows);
        if (flow.recordedBase(liveTab) !== plan.base.sha) fail('The live deployment record changed since the comparison.');
        if (hasCredentials(original.flows)) fail('GET /flows unexpectedly returned credentials.');
        const preparedBase = flow.prepared(base, plan.base.sha, prepareFlows, stampDeployment);
        const preparedTarget = flow.prepared(target, plan.sha, prepareFlows, stampDeployment);
        const liveHashes = flow.fingerprints(original.flows);
        const matchesBase = flow.checkDrift(flow.fingerprints(preparedBase), liveHashes, plan.base.sha, plan.overwriteDrift);
        await checkDhw(original.flows);
        preflightModules(preparedTarget);
        const jobs = makeToolJobs(plan.tools, download);
        flow.report(base, target);
        // Node-RED can also restart dependants. Count direct definition changes only.
        const changes = flow.differences(flow.fingerprints(original.flows, false), flow.fingerprints(preparedTarget, false));
        const label = flow.versionTab(preparedTarget).label;
        console.log('nodes restarted : ' + (changes.added.length + changes.changed.length) + ' (estimate: direct changes only)');
        console.log('live label      : ' + liveTab.label + ' -> ' + label);
        if (process.env.DRY !== '0') {
            console.log('DRY RUN - nothing changed. Run again with DRY=0 to deploy.');
            return;
        }
        const sameDeployment = plan.base.sha === plan.sha && matchesBase;
        if (sameDeployment && !jobs.length) {
            console.log('NOTHING TO DO: the GX already runs ' + plan.sha.slice(0, 12));
            return;
        }
        await apply(preparedTarget, original, originalText, label, jobs, sameDeployment);
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
})().catch(error => { console.error('ABORT: ' + error.message); process.exitCode = 1; });
