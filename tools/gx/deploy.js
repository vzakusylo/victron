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
//   4. copies only the planned code fields from the commit into the live nodes; a node that differs
//      from the commit in anything else (wires, outputs) stops the deploy
//   5. sets the d#<n> tab label of the commit and stamps the source commit (tools/deploy-version.js)
//   6. DRY=0 only: replaces the tool files (previous ones kept as <name>.pre-<sha12>), copies flows.json,
//      flows_cred.json and the original live flow to .node-red/backup-<time>-pre-d<n>/, POSTs with the
//      revision and deploy type "nodes", reads the flow back and compares
// Credentials are not touched: GET /flows has none and Node-RED keeps those of nodes it does not replace.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = process.env.VICTRON_HOME || '/data/home/nodered';
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
        const request = http.request({ host: '127.0.0.1', port: 1880, path: urlPath, method,
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
    if (!Array.isArray(plan.scopes) || !plan.scopes.length || plan.scopes.some((scope) => !SCOPES.includes(scope))) fail('plan.scopes must list dashboard and/or automations');
    plan.tools = plan.tools || {};
    for (const [tool, hash] of Object.entries(plan.tools)) {
        if (!/^tools\/[\w.-]+\.js$/.test(tool) || !hex(hash, 64)) fail('plan.tools entry is invalid: ' + tool);
    }
    return plan;
}

(async () => {
    if (!process.argv[2]) fail('Usage: [DRY=0] node deploy.js PLAN.json');
    const plan = readPlan(process.argv[2]);
    // Root-only directory on the data partition: files are renamed into place from here.
    const stage = fs.mkdtempSync(path.join(HOME, '.gx-deploy-stage.'));
    try {
        const download = (file, want) => {
            const url = 'https://raw.githubusercontent.com/' + plan.repo + '/' + plan.sha + '/' + file;
            const out = path.join(stage, file.replace(/\//g, '__'));
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
            const dest = path.join(toolsDir, path.basename(tool));
            const current = fs.existsSync(dest) ? sha256(Buffer.from(fs.readFileSync(dest, 'latin1').replace(/\r/g, ''), 'latin1')) : null;
            if (current === hash) console.log('tool up to date : ' + tool);
            else { console.log('tool to replace : ' + tool + (current ? '' : ' (new)')); toolJobs.push({ staged, dest }); }
        }

        const originalText = await api('GET', '/flows');
        const original = JSON.parse(originalText);
        if (original.rev !== plan.expectRev) fail('The live flow changed since the comparison (rev ' + original.rev.slice(0, 12) + '). Take a new snapshot and plan.');
        const payload = JSON.parse(originalText);
        const liveById = new Map(payload.flows.map((node) => [node.id, node]));
        const liveTab = liveById.get(repoTab.id) || fail('The d# tab of the commit is not on the GX.');
        const number = (label) => Number((/d#(\d+)/.exec(label) || [])[1]);
        if (!(number(liveTab.label) <= number(repoTab.label))) fail('Live ' + liveTab.label + ' is newer than the commit ' + repoTab.label + '.');

        const ids = Object.keys(plan.patch);
        if (liveById.has(AUTOMATIONS_NODE)) {
            const raw = JSON.parse(await api('GET', '/context/node/' + AUTOMATIONS_NODE + '/dhw'));
            let dhw = null;
            try { dhw = JSON.parse(raw.msg); } catch { /* no DHW context yet */ }
            console.log('DHW state       : ' + (dhw ? dhw.state + (dhw.run ? ' (cycle running)' : '') : 'no context'));
            if (dhw && (dhw.state !== 'HEATING' || dhw.run)) fail('A DHW cycle is running. Deploy after it ends.');
        }

        const changes = [];
        for (const id of ids) {
            const node = liveById.get(id) || fail('Planned node ' + id + ' is not on the GX.');
            const source = repoById.get(id) || fail('Planned node ' + id + ' is not in the commit.');
            for (const field of plan.patch[id]) {
                if (!['func', 'initialize', 'finalize', 'format', 'command'].includes(field)) fail('Field ' + field + ' cannot be deployed by a plan.');
                if (norm(node[field]) !== norm(source[field])) changes.push(id + '.' + field + ': ' + norm(node[field]).split('\n').length + ' -> ' + norm(source[field]).split('\n').length + ' lines');
                node[field] = source[field];
            }
            if (withoutLayout(node) !== withoutLayout(source)) fail(id + ' differs from the commit outside the planned fields (wires, outputs, settings). Deploy that node by hand.');
        }
        liveTab.label = repoTab.label;
        const commits = Object.fromEntries(plan.scopes.map((scope) => [scope, plan.sha]));
        const stamped = stampDeployment(payload, commits, original);
        if (stamped.flows.length !== original.flows.length) fail('Node count changed.');

        const before = new Map(original.flows.map((node) => [node.id, node]));
        const touched = stamped.flows.filter((node) => stable(node) !== stable(before.get(node.id)));
        const newTab = stamped.flows.find((node) => node.id === repoTab.id);
        console.log('code changes    :\n  ' + (changes.join('\n  ') || 'none'));
        console.log('nodes restarted : ' + touched.length + ' (' + touched.filter((node) => node.type === 'ui_tab').length + ' dashboard pages renamed by the source label)');
        console.log('  ' + touched.filter((node) => node.type !== 'ui_tab').map((node) => node.id + ' [' + node.type + ']').join('\n  '));
        console.log('live label      : ' + liveTab.label.replace(/ \[.*\]$/, '') + ' -> ' + newTab.label);
        if (DRY) { console.log('DRY RUN - nothing changed. Run again with DRY=0 to deploy.'); return; }

        const owner = fs.statSync(toolsDir);
        for (const job of toolJobs) {
            const keep = job.dest + '.pre-' + plan.sha.slice(0, 12);
            if (fs.existsSync(job.dest) && !fs.existsSync(keep)) fs.copyFileSync(job.dest, keep);
            fs.chownSync(job.staged, owner.uid, owner.gid);
            fs.chmodSync(job.staged, 0o644);
            fs.renameSync(job.staged, job.dest);   // replaces a symlink instead of writing through it
            console.log('tool replaced   : ' + job.dest);
        }

        const now = new Date(), two = (value) => String(value).padStart(2, '0');
        const backup = path.join(NODE_RED_DIR, 'backup-' + now.getFullYear() + two(now.getMonth() + 1) + two(now.getDate()) + 'T'
            + two(now.getHours()) + two(now.getMinutes()) + '-pre-d' + number(repoTab.label));
        fs.mkdirSync(backup, { mode: 0o700 });
        for (const file of ['flows.json', 'flows_cred.json']) fs.copyFileSync(path.join(NODE_RED_DIR, file), path.join(backup, file));
        fs.writeFileSync(path.join(backup, 'original-live.json'), originalText, { mode: 0o600 });
        console.log('backup          : ' + backup);

        const reply = await api('POST', '/flows', JSON.stringify(stamped), { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' });
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const after = JSON.parse(await api('GET', '/flows'));
        const afterById = new Map(after.flows.map((node) => [node.id, node]));
        for (const id of ids) for (const field of plan.patch[id]) {
            if (norm(afterById.get(id)[field]) !== norm(repoById.get(id)[field])) fail('VERIFY FAILED: ' + id + '.' + field + '. Roll back from ' + backup);
        }
        console.log('DEPLOYED        : ' + afterById.get(repoTab.id).label + ' (rev ' + JSON.parse(reply).rev.slice(0, 12) + ')');
        console.log('Now run tools/gx/verify.js, and again after 15-20 minutes.');
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
})().catch((error) => { console.error('ABORT: ' + error.message); process.exit(1); });
