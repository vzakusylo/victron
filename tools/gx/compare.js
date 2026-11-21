#!/usr/bin/env node
// Compares a live snapshot of the GX flow (tools/gx/live-snapshot.js) with the repository and,
// on request, writes the deploy plan for tools/gx/deploy.js. Runs ON THE PC; changes nothing on the GX.
//
// Usage:
//   node tools/gx/compare.js live.b64                      compare with flows.json of the work tree
//   node tools/gx/compare.js live.b64 --commit <sha>       compare with flows.json of a commit
//   node tools/gx/compare.js a.b64 --against b.b64         snapshot against snapshot (a = "live" side, b = "repo" side)
//   node tools/gx/compare.js live.b64 --show <node id>     print the lines that differ in one node
//   node tools/gx/compare.js live.b64 --history 20         also name the newest commit the live code equals
//   node tools/gx/compare.js live.b64 --commit <sha> --plan plan.json
//        [--tools tools/a.js,tools/b.js] [--scopes dashboard,automations] [--include-trailing] [--allow-new-nodes]
//   node tools/gx/compare.js live.b64 --commit <sha> --summary summary.json     the result as JSON for a script
//
// What the report means:
//   code      a function / template / exec command differs: this is what a deploy changes
//   trailing  only whitespace at the end differs (an editor artefact): left alone unless --include-trailing
//   config    other properties differ (wires, outputs, settings). Expected for the Tuya nodes: the GX has
//             file-secret references, the repository a portable template. Only reviewed new-node
//             connections (and necessary function outputs) can be patched.
//   only live / only repo   removed nodes stop; additions need an explicit opt-in.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { snapshot } = require('./live-snapshot.js');
const { additionPlan, describe } = require('./node-additions.js');

const norm = (text) => String(text === undefined ? '' : text).replace(/\r\n/g, '\n');
const lines = (text) => norm(text).split('\n');

function diffSnapshots(live, repo) {
    const liveById = new Map(live.nodes.map((node) => [node.id, node]));
    const repoById = new Map(repo.nodes.map((node) => [node.id, node]));
    const result = { onlyLive: [], onlyRepo: [], code: [], trailing: [], config: [] };
    for (const node of live.nodes) if (!repoById.has(node.id)) result.onlyLive.push(node);
    for (const node of repo.nodes) {
        const other = liveById.get(node.id);
        if (!other) { result.onlyRepo.push(node); continue; }
        const fields = new Set(Object.keys(node.code).concat(Object.keys(other.code)));
        for (const field of fields) {
            const a = norm(other.code[field]), b = norm(node.code[field]);
            if (a === b) continue;
            const liveSet = new Set(lines(a)), repoSet = new Set(lines(b));
            const item = { id: node.id, type: node.type, name: node.name, field,
                added: lines(b).filter((line) => !liveSet.has(line)).length,
                removed: lines(a).filter((line) => !repoSet.has(line)).length };
            (a.trimEnd() === b.trimEnd() ? result.trailing : result.code).push(item);
        }
        if (node.rest !== other.rest) result.config.push({ id: node.id, type: node.type, name: node.name });
    }
    return result;
}

function buildPatch(diff, includeTrailing) {
    const patch = {};
    for (const item of diff.code.concat(includeTrailing ? diff.trailing : [])) (patch[item.id] = patch[item.id] || []).push(item.field);
    return patch;
}

module.exports = { diffSnapshots, buildPatch };

function readSnapshot(file) {
    // PowerShell may add a BOM or write UTF-16; keep only the base64 characters.
    let raw = fs.readFileSync(file);
    raw = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/[^A-Za-z0-9+/=]/g, '');
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
}

function git(...args) { return execFileSync('git', args, { maxBuffer: 1 << 27 }); }
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function checkCommitSources(commit) {
    const files = git('ls-tree', '-r', '-z', '--name-only', commit).toString().split('\0');
    const sources = files.filter((file) => /^\d\d [^/]+\.(?:js|html)$/.test(file));
    const inputs = files.filter((file) => file.startsWith('lib/'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-flow-check-'));
    try {
        const archive = git('archive', '--format=tar', commit, '--', 'flows.json', 'tools/flows.js', 'tools/includes.js', ...sources, ...inputs);
        execFileSync('tar', ['-xf', '-', '-C', dir], { input: archive });
        execFileSync(process.execPath, [path.join(dir, 'tools', 'flows.js'), 'check'], { stdio: 'pipe' });
        const names = new Set(sources.filter((file) => file.endsWith('.js') && !file.endsWith('.init.js')).map((file) => file.slice(3, -3)));
        return names;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function main() {
    const args = process.argv.slice(2);
    const file = args.shift();
    const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
    if (!file) throw new Error('Usage: node tools/gx/compare.js LIVE.b64 [--commit SHA] [--show ID] [--history N] [--plan OUT.json] [--summary OUT.json]');
    const live = readSnapshot(file);

    // --against SNAPSHOT.b64: snapshot against snapshot (e.g. the Docker test GX against the live GX or a backup).
    const against = option('--against');
    if (against && (option('--commit') || option('--plan'))) throw new Error('--against cannot be combined with --commit or --plan.');
    let commit = option('--commit');
    if (commit) commit = git('rev-parse', '--verify', commit + '^{commit}').toString().trim();
    const flowsBuffer = against ? null : commit ? git('show', commit + ':flows.json') : fs.readFileSync('flows.json');
    const repo = against ? readSnapshot(against) : snapshot(JSON.parse(flowsBuffer.toString('utf8')));
    const diff = diffSnapshots(live, repo);

    const liveTab = live.nodes.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    const repoTab = repo.nodes.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    console.log('live  : ' + (liveTab && liveTab.label) + '  (rev ' + String(live.rev).slice(0, 12) + ', read ' + new Date(live.at).toISOString() + ')');
    console.log('repo  : ' + (repoTab && repoTab.label) + '  (' + (against ? 'snapshot ' + against : commit ? 'commit ' + commit.slice(0, 12) : 'work tree') + ')');
    const meta = liveTab && /<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/.exec(liveTab.info || '');
    console.log('live deployment source: ' + (meta ? meta[1] : 'not recorded'));

    const history = Number(option('--history') || 0);
    const revisions = history ? git('log', '--format=%h', '-' + history, commit || 'HEAD', '--', 'flows.json').toString().trim().split('\n') : [];
    const cache = {};
    const fieldAt = (rev, id, field) => {
        if (!cache[rev]) cache[rev] = new Map(JSON.parse(git('show', rev + ':flows.json').toString('utf8')).map((node) => [node.id, node]));
        const node = cache[rev].get(id);
        return node ? norm(node[field]) : null;
    };
    const liveById = new Map(live.nodes.map((node) => [node.id, node]));
    const list = (title, items) => {
        console.log('\n' + title + ' (' + items.length + ')');
        for (const item of items) {
            let line = '  ' + item.id.padEnd(24) + item.type.padEnd(18) + (item.name || '').padEnd(30);
            if (item.field) line += item.field.padEnd(11) + '+' + item.added + ' -' + item.removed;
            if (item.field && revisions.length) {
                const text = norm(liveById.get(item.id).code[item.field]).trimEnd();
                const match = revisions.find((rev) => { const at = fieldAt(rev, item.id, item.field); return at !== null && at.trimEnd() === text; });
                line += '  live = ' + (match || 'no commit of the last ' + revisions.length);
            }
            console.log(line);
        }
    };
    list('code differs: repo lines to add (+) / live lines to drop (-)', diff.code);
    list('trailing whitespace only', diff.trailing);
    list('config differs (only validated new-node wiring can be patched)', diff.config);
    list('only on the GX', diff.onlyLive);
    list('only in the repository', diff.onlyRepo);
    const liveOnlyCode = diff.code.filter((item) => item.removed > 0);
    if (liveOnlyCode.length) {
        console.log('\nWARNING: the GX has lines that the repository does not (-N above). A deploy removes them.');
        console.log('         Look at them with --show <id> and copy them into the numbered source first if they are wanted.');
    }

    const show = option('--show');
    if (show) {
        const a = liveById.get(show), b = repo.nodes.find((node) => node.id === show);
        if (!a || !b) throw new Error('Node ' + show + ' is not on both sides.');
        for (const field of new Set(Object.keys(a.code).concat(Object.keys(b.code)))) {
            const la = lines(a.code[field]), lb = lines(b.code[field]);
            const sa = new Set(la), sb = new Set(lb);
            console.log('\n' + show + '.' + field + ' - only on the GX:');
            la.forEach((line, i) => { if (!sb.has(line)) console.log('  L' + (i + 1) + ': ' + line); });
            console.log(show + '.' + field + ' - only in the repository:');
            lb.forEach((line, i) => { if (!sa.has(line)) console.log('  R' + (i + 1) + ': ' + line); });
        }
    }

    // Machine-readable result for scripts/gx-deploy.ps1: what a runner needs to decide, nothing else.
    const summaryFile = option('--summary');
    if (summaryFile) {
        const ids = (items) => items.map((item) => item.id + (item.field ? '.' + item.field : ''));
        fs.writeFileSync(summaryFile, JSON.stringify({
            live: { label: liveTab && liveTab.label, rev: live.rev, source: meta ? JSON.parse(meta[1]) : null },
            repo: { label: repoTab && repoTab.label, commit: commit || null },
            code: ids(diff.code), liveOnlyLines: ids(diff.code.filter((item) => item.removed > 0)),
            trailing: ids(diff.trailing), config: ids(diff.config), onlyLive: ids(diff.onlyLive), onlyRepo: ids(diff.onlyRepo)
        }, null, 2) + '\n');
    }

    const planFile = option('--plan');
    if (planFile) {
        if (!commit) throw new Error('--plan needs --commit: a deploy is always from a pushed commit.');
        if (git('status', '--porcelain', '--', 'flows.json').toString().trim()) console.log('\nNote: flows.json has uncommitted changes; the plan uses the commit, not the work tree.');
        const tools = {};
        for (const tool of (option('--tools') || '').split(',').filter(Boolean)) tools[tool] = sha256(git('show', commit + ':' + tool));
        const repoFlows = JSON.parse(flowsBuffer.toString('utf8'));
        const allowNewNodes = args.includes('--allow-new-nodes');
        if (allowNewNodes && diff.onlyRepo.length && !live.nodes.every((node) => node.topology)) {
            throw new Error('New-node planning requires a live-snapshot.js --topology snapshot.');
        }
        const nodes = additionPlan(live.nodes.map(({ id, type, topology }) => ({ id, type, ...topology })), repoFlows, allowNewNodes);
        const added = new Set(nodes.add);
        const newNodes = repoFlows.filter((node) => added.has(node.id));
        if (newNodes.some((node) => node.type === 'function')) {
            const names = checkCommitSources(commit);
            for (const node of newNodes) {
                if (node.type === 'function' && !names.has(node.name)) throw new Error(node.id + ': no numbered function source in the commit.');
            }
        }
        const plan = {
            repo: 'vzakusylo/victron', sha: commit, expectRev: live.rev,
            flowsSha256: sha256(flowsBuffer), stampSha256: sha256(git('show', commit + ':tools/deploy-version.js')),
            scopes: (option('--scopes') || 'dashboard,automations').split(',').filter(Boolean),
            patch: buildPatch(diff, args.includes('--include-trailing')), ...nodes, tools
        };
        fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
        console.log('\nplan written to ' + planFile + ': ' + Object.keys(plan.patch).length + ' code patch(es), ' + nodes.wire.length +
            ' wire patch(es), ' + nodes.add.length + ' addition(s), ' + Object.keys(tools).length + ' tool file(s), scopes ' + plan.scopes.join('+'));
        for (const node of newNodes) console.log('node to add     : ' + JSON.stringify(describe(node)));
        for (const id of nodes.wire) console.log('wire patch      : ' + id);
    }
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
