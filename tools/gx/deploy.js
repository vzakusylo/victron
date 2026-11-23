#!/usr/bin/env node
// Selective deploy of a pushed commit to the LIVE Node-RED flow. Runs ON THE GX as root, with the
// plan written by tools/gx/compare.js --plan. Default is a dry run that changes nothing.
//
// Usage on the GX (see docs/gx-deploy.md):
//   node /tmp/gx-deploy.js /tmp/gx-plan.json            dry run: all checks, prints what would change
//   DRY=0 node /tmp/gx-deploy.js /tmp/gx-plan.json      backup, replace the tool files, POST, verify
//
// What it does, in order, and stops at the first failed check:
//   1. downloads flows.json, tools/deploy-version.js and the planned tool files of plan.sha from
//      raw.githubusercontent.com and checks their SHA-256 against the plan (large pushes from the PC stall)
//   2. GET /flows; the live revision must still be plan.expectRev (nobody deployed since the comparison)
//   3. the heat pump automations must not be in a DHW cycle (their node context is lost on a redeploy)
//   4. copies only the planned code and reviewed wiring from the commit, and adds reviewed nodes;
//      any other settings differences on a patched node stop the deploy
//   5. sets the d#<n> tab label of the commit and stamps the source commit (tools/deploy-version.js)
//   6. DRY=0 only: copies flows.json,
//      flows_cred.json and the original live flow to .node-red/backup-<time>-pre-d<n>/, replaces the tool
//      files (previous ones saved in that backup, restored if the POST fails), POSTs with the
//      revision and deploy type "nodes", reads the flow back and compares
// Credentials are not touched: GET /flows has none and Node-RED keeps those of nodes it does not replace.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { additionPlan, describe, recordedCommit, removalPlan, cleanTopology } = require('./node-additions.js');

const HOME = process.env.VICTRON_HOME || '/data/home/nodered';
// Overridden only by the end-to-end test (tests/gx-deploy-e2e.test.js): a local admin API and file server.
const API_PORT = Number(process.env.VICTRON_API_PORT) || 1880;
const RAW_BASE = process.env.VICTRON_RAW_BASE || 'https://raw.githubusercontent.com';
const NODE_RED_DIR = path.join(HOME, '.node-red');
const DRY = process.env.DRY !== '0';
const SCOPES = ['dashboard', 'automations'];
const AUTOMATIONS_NODE = 'hpa-fn-01';

const fail = (message) => { throw new Error(message); };
const norm = (text) => String(text === undefined ? '' : text).replace(/\r\n/g, '\n');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}
const withoutLayout = (node) => { const copy = Object.assign({}, node); delete copy.x; delete copy.y; delete copy.g; return stable(copy); };

function api(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: API_PORT, path: urlPath, method,
            headers: Object.assign({ 'Node-RED-API-Version': 'v2' }, headers || {}) }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(text)
                : reject(new Error(method + ' ' + urlPath + ' -> ' + res.statusCode + ' ' + text.slice(0, 300)))));
        });
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

function readPlan(file) {
    const plan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
    if (!/^[\w.-]+\/[\w.-]+$/.test(plan.repo || '')) fail('plan.repo must be owner/name');
    if (!hex(plan.sha, 40)) fail('plan.sha must be a full commit SHA');
    if (!hex(plan.flowsSha256, 64) || !hex(plan.stampSha256, 64)) fail('plan file hashes are missing');
    if (typeof plan.expectRev !== 'string' || !plan.expectRev) fail('plan.expectRev is missing');
    if (!plan.patch || typeof plan.patch !== 'object' || Array.isArray(plan.patch)) fail('plan.patch must be an object');
    for (const key of ['add', 'wire', 'groups', 'remove', 'allowNewWires']) {
        if (plan[key] === undefined) plan[key] = [];
        if (!Array.isArray(plan[key]) || plan[key].some((id) => typeof id !== 'string')) fail('plan.' + key + ' must list node IDs');
    }
    if ((plan.remove.length || plan.allowNewWires.length) &&
        (!hex(plan.removalBase?.sha, 40) || !hex(plan.removalBase?.flowsSha256, 64))) fail('Topology baseline SHA and hash are required.');
    if (!Array.isArray(plan.scopes) || !plan.scopes.length || plan.scopes.some((scope) => !SCOPES.includes(scope))) fail('plan.scopes must list dashboard and/or automations');
    plan.tools = plan.tools || {};
    for (const [tool, hash] of Object.entries(plan.tools)) {
        if (!/^tools\/(?:gx\/)?[\w-][\w.-]*\.js$/.test(tool) || !hex(hash, 64)) fail('plan.tools entry is invalid: ' + tool);
    }
    return plan;
}

(async () => {
    if (!process.argv[2]) fail('Usage: [DRY=0] node deploy.js PLAN.json');
    const plan = readPlan(process.argv[2]);
    // Root-only directory on the data partition: files are renamed into place from here.
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
        const repoFlows = JSON.parse(fs.readFileSync(download('flows.json', plan.flowsSha256), 'utf8'));
        const { stampDeployment } = require(download('tools/deploy-version.js', plan.stampSha256));
        const repoById = new Map(repoFlows.map((node) => [node.id, node]));
        const repoTab = repoFlows.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || '')) || fail('No d# tab in the commit.');

        // Tool files: compare without CR (earlier copies from Windows have CRLF).
        const toolsDir = path.join(HOME, 'tools');
        const toolJobs = [];
        for (const [tool, hash] of Object.entries(plan.tools)) {
            const staged = download(tool, hash);
            execFileSync(process.execPath, ['--check', staged]);
            const dest = path.join(HOME, tool);   // tools/<name>.js or tools/gx/<name>.js
            const current = fs.existsSync(dest) ? sha256(Buffer.from(fs.readFileSync(dest, 'latin1').replace(/\r/g, ''), 'latin1')) : null;
            const executable = tool === 'tools/camera-mail-gate.js';
            const mode = executable ? 0o755 : 0o644;
            const modeOk = !executable || (current && (fs.statSync(dest).mode & 0o777) === mode);
            if (current === hash && modeOk) console.log('tool up to date : ' + tool);
            else { console.log('tool to replace : ' + tool + (current ? '' : ' (new)')); toolJobs.push({ staged, dest, mode }); }
        }

        const originalText = await api('GET', '/flows');
        const original = JSON.parse(originalText);
        if (original.rev !== plan.expectRev) fail('The live flow changed since the comparison (rev ' + original.rev.slice(0, 12) + '). Take a new snapshot and plan.');
        const payload = JSON.parse(originalText);
        const liveById = new Map(payload.flows.map((node) => [node.id, node]));
        const liveTab = liveById.get(repoTab.id) || fail('The d# tab of the commit is not on the GX.');
        const number = (label) => Number((/d#(\d+)/.exec(label) || [])[1]);
        if (!(number(liveTab.label) <= number(repoTab.label))) fail('Live ' + liveTab.label + ' is newer than the commit ' + repoTab.label + '.');

        let removals = { remove: [], reconnect: {} };
        let previous = [];
        if (plan.remove.length || plan.allowNewWires.length) {
            const base = plan.removalBase;
            if (recordedCommit(liveTab.info) !== base.sha) fail('Live deployment record does not match the topology baseline.');
            previous = JSON.parse(fs.readFileSync(download('flows.json', base.flowsSha256, base.sha), 'utf8'));
        }
        if (plan.remove.length) {
            const { snapshot } = require('./live-snapshot.js');
            const topology = flows => snapshot(flows, null, { topology: true }).nodes;
            removals = removalPlan(topology(original.flows), topology(repoFlows), plan.remove, topology(previous), plan.allowNewWires);
            payload.flows = cleanTopology(payload.flows, removals);
            liveById.clear();
            for (const node of payload.flows) liveById.set(node.id, node);
            for (const id of removals.remove) console.log('node to remove  : ' + id);
            for (const [id, fields] of Object.entries(removals.reconnect)) console.log('removal wiring  : ' + id + ' ' + JSON.stringify(fields));
        }
        const nodes = additionPlan(payload.flows, repoFlows, plan.add.length > 0, plan.allowNewWires,
            { baseline: previous, beforeRemovals: original.flows, removed: removals.remove });
        for (const key of ['add', 'wire', 'groups']) {
            if (stable(plan[key]) !== stable(nodes[key] || [])) fail('Planned ' + key + ' IDs do not match the live/commit comparison.');
        }
        const wireIds = new Set(nodes.wire);
        const reviewedWires = new Set(plan.allowNewWires);
        const ids = [...new Set([...Object.keys(plan.patch), ...wireIds])];
        if (liveById.has(AUTOMATIONS_NODE)) {
            const raw = JSON.parse(await api('GET', '/context/node/' + AUTOMATIONS_NODE + '/dhw'));
            // Fail closed: only a value that was never set counts as "no context".
            let dhw = null;
            const neverSet = !Object.keys(raw).length || raw.format === 'undefined';
            if (!neverSet) {
                try { dhw = JSON.parse(raw.msg); } catch { fail('Cannot read the DHW state. Not deploying.'); }
                if (!dhw || typeof dhw.state !== 'string') fail('Unexpected DHW context. Not deploying.');
            }
            console.log('DHW state       : ' + (dhw ? dhw.state + (dhw.run ? ' (cycle running)' : '') : 'no context'));
            if (dhw && (dhw.state !== 'HEATING' || dhw.run)) fail('A DHW cycle is running. Deploy after it ends.');
        }

        const changes = [];
        for (const id of ids) {
            const node = liveById.get(id) || fail('Planned node ' + id + ' is not on the GX.');
            const source = repoById.get(id) || fail('Planned node ' + id + ' is not in the commit.');
            const reviewed = reviewedWires.has(id);
            const keepsLiveSettings = reviewed && node.type === 'tuya-smart-device';
            for (const field of plan.patch[id] || []) {
                if (!['func', 'initialize', 'finalize', 'format', 'command'].includes(field)) fail('Field ' + field + ' cannot be deployed by a plan.');
                if (norm(node[field]) !== norm(source[field])) changes.push(id + '.' + field + ': ' + norm(node[field]).split('\n').length + ' -> ' + norm(source[field]).split('\n').length + ' lines');
                node[field] = source[field];
            }
            if (wireIds.has(id)) {
                if (Object.hasOwn(source, 'wires')) node.wires = source.wires;
                else delete node.wires;
                // In a reviewed rewire, only a function's output count is part of the patch.
                if ((!reviewed || node.type === 'function') && Object.hasOwn(source, 'outputs')) node.outputs = source.outputs;
                console.log('wire patch      : ' + id + ' ' + JSON.stringify(node.wires));
            }
            if (!keepsLiveSettings && withoutLayout(node) !== withoutLayout(source)) {
                fail(id + ' differs from the commit outside the planned fields (wires, outputs, settings). Deploy that node by hand.');
            }
        }
        for (const id of nodes.add) {
            const node = repoById.get(id);
            payload.flows.push(Object.assign({}, node));
            console.log('node to add     : ' + JSON.stringify(describe(node)));
        }
        const groupMembers = nodes.groupMembers || new Map();
        for (const [id, members] of groupMembers) {
            liveById.get(id).nodes = members;
            console.log('group patch     : ' + id);
        }
        const oldLabel = liveTab.label;
        liveTab.label = repoTab.label;
        const commits = Object.fromEntries(plan.scopes.map((scope) => [scope, plan.sha]));
        const stamped = stampDeployment(payload, commits, original);
        if (stamped.flows.length !== original.flows.length + nodes.add.length - removals.remove.length) fail('Unexpected node count.');

        const before = new Map(original.flows.map((node) => [node.id, node]));
        const touched = stamped.flows.filter((node) => stable(node) !== stable(before.get(node.id)));
        const newTab = stamped.flows.find((node) => node.id === repoTab.id);
        console.log('code changes    :\n  ' + (changes.join('\n  ') || 'none'));
        console.log('nodes restarted : ' + touched.length);
        console.log('  ' + touched.map((node) => node.id + ' [' + node.type + ']').join('\n  '));
        console.log('live label      : ' + oldLabel + ' -> ' + newTab.label);
        if (DRY) { console.log('DRY RUN - nothing changed. Run again with DRY=0 to deploy.'); return; }

        // Backup first: nothing is replaced before the previous state is saved.
        const now = new Date(), two = (value) => String(value).padStart(2, '0');
        const backup = path.join(NODE_RED_DIR, 'backup-' + now.getFullYear() + two(now.getMonth() + 1) + two(now.getDate()) + 'T'
            + two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds()) + '-pre-d' + number(repoTab.label));
        fs.mkdirSync(backup, { mode: 0o700 });
        for (const file of ['flows.json', 'flows_cred.json']) fs.copyFileSync(path.join(NODE_RED_DIR, file), path.join(backup, file));
        fs.writeFileSync(path.join(backup, 'original-live.json'), originalText, { mode: 0o600 });
        console.log('backup          : ' + backup);

        // tools/ belongs to nodered: never follow a link there. Previous tool files go to the
        // root-only backup directory, and come back if the flow deploy fails.
        const isPlain = (file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
        const owner = fs.statSync(toolsDir);
        const replaced = [];
        const restoreTools = () => {
            for (const item of replaced) {
                try {
                    if (item.saved) fs.renameSync(item.saved, item.dest); else fs.rmSync(item.dest, { force: true });
                    console.error('tool restored   : ' + item.dest);
                } catch (error) { console.error('TOOL NOT RESTORED: ' + item.dest + ' (' + error.message + '); previous copy: ' + (item.saved || 'none')); }
            }
        };
        let reply, afterById;
        try {
            for (const job of toolJobs) {
                let saved = null;
                const folder = path.dirname(job.dest);
                if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { mode: 0o755 }); fs.chownSync(folder, owner.uid, owner.gid); }
                if (!fs.lstatSync(folder).isDirectory()) fail(folder + ' is not a directory.');
                if (isPlain(job.dest)) {
                    saved = path.join(backup, path.relative(toolsDir, job.dest).replace(/[\\/]/g, '__'));
                    fs.copyFileSync(job.dest, saved, fs.constants.COPYFILE_EXCL);
                    fs.chownSync(saved, owner.uid, owner.gid);
                    fs.chmodSync(saved, fs.statSync(job.dest).mode & 0o777);
                }
                fs.chownSync(job.staged, owner.uid, owner.gid);
                fs.chmodSync(job.staged, job.mode);
                fs.renameSync(job.staged, job.dest);   // replaces a symlink instead of writing through it
                replaced.push({ dest: job.dest, saved });
                console.log('tool replaced   : ' + job.dest);
            }
            reply = await api('POST', '/flows', JSON.stringify(stamped), { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' });
        } catch (error) {
            // Put the tool files back only if the flow really was not replaced: a transport error
            // on the POST can come after Node-RED accepted it.
            let liveRev = null;
            try { liveRev = JSON.parse(await api('GET', '/flows')).rev; } catch { /* unknown */ }
            if (liveRev === plan.expectRev) restoreTools();
            else console.error('Flow state after the failed step is unknown (rev ' + liveRev + '); tool files left as replaced. Check the flow and roll back from ' + backup);
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const after = JSON.parse(await api('GET', '/flows'));
        afterById = new Map(after.flows.map((node) => [node.id, node]));
        // The POST was accepted, so the new flow runs with the new tools: keep both and report.
        const verifyFailed = (item) => fail('VERIFY FAILED: ' + item + '. The flow was posted and the tool files replaced; roll back both from ' + backup);
        for (const id of removals.remove) if (afterById.has(id)) verifyFailed(id + ' not removed');
        const deployedById = new Map(stamped.flows.map(node => [node.id, node]));
        for (const [id, fields] of Object.entries(removals.reconnect)) {
            for (const key of Object.keys(fields)) if (stable(afterById.get(id)?.[key]) !== stable(deployedById.get(id)[key])) verifyFailed(id + '.' + key);
        }
        for (const id of nodes.add) {
            if (stable(afterById.get(id)) !== stable(repoById.get(id))) verifyFailed(id);
        }
        for (const [id, members] of groupMembers) {
            if (stable(afterById.get(id)?.nodes) !== stable(members)) verifyFailed(id + '.nodes');
        }
        for (const id of ids) {
            const got = afterById.get(id), want = repoById.get(id);
            if (!got) verifyFailed(id);
            for (const field of plan.patch[id] || []) if (norm(got[field]) !== norm(want[field])) verifyFailed(id + '.' + field);
            if (wireIds.has(id) && (stable(got.wires) !== stable(want.wires) ||
                got.outputs !== liveById.get(id).outputs)) verifyFailed(id + '.wires/outputs');
        }
        console.log('DEPLOYED        : ' + afterById.get(repoTab.id).label + ' (rev ' + JSON.parse(reply).rev.slice(0, 12) + ')');
        console.log('Now run tools/gx/verify.js, and again after 15-20 minutes.');
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
})().catch((error) => { console.error('ABORT: ' + error.message); process.exit(1); });
