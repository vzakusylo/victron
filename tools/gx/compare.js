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
//        [--tools tools/a.js,tools/b.js] [--overwrite-drift] [--summary summary.json]
//   node tools/gx/compare.js live.b64 --commit <sha> --summary summary.json     the result as JSON for a script
//
// What the report means:
// The diagnostic snapshot is useful for inspection but cannot be used to plan a deploy.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { snapshot, stable } = require('./live-snapshot.js');
const flow = require('./whole-flow.js');
const { stampDeployment } = require('../deploy-version.js');
const { prepareFlows } = require('../victron-secrets.js');

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
            const count = field === 'libs' ? value => value ? [value] : [] : lines;
            const liveSet = new Set(count(a)), repoSet = new Set(count(b));
            const item = { id: node.id, type: node.type, name: node.name, field,
                added: count(b).filter((line) => !liveSet.has(line)).length,
                removed: count(a).filter((line) => !repoSet.has(line)).length };
            (a.trimEnd() === b.trimEnd() ? result.trailing : result.code).push(item);
        }
        if (node.rest !== other.rest) result.config.push({ id: node.id, type: node.type, name: node.name });
    }
    return result;
}

module.exports = { diffSnapshots };

function readSnapshot(file) {
    // PowerShell may add a BOM or write UTF-16; keep only the base64 characters.
    let raw = fs.readFileSync(file);
    raw = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/[^A-Za-z0-9+/=]/g, '');
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
}

function git(...args) { return execFileSync('git', args, { maxBuffer: 1 << 27 }); }
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function writePlan(live, commit, file, summary, tools, overwriteDrift) {
    if (!commit) throw new Error('--plan requires --commit.');
    if (!Array.isArray(live.fingerprints) || !live.rev || !/^[a-f0-9]{40}$/.test(live.base || '')) {
        throw new Error('--plan requires a --drift snapshot with a Git deployment record and revision.');
    }
    let base;
    try {
        git('merge-base', '--is-ancestor', live.base, commit);
        base = git('show', live.base + ':flows.json');
    } catch {
        throw new Error('The recorded deployment is not a readable ancestor of the target commit.');
    }
    const target = git('show', commit + ':flows.json');
    const before = JSON.parse(base), after = JSON.parse(target);
    const label = flow.versionTab(after).label;
    if (summary) fs.writeFileSync(summary, JSON.stringify({
        live: { label: live.label, rev: live.rev, source: { dashboard: live.base, automations: live.base } },
        repo: { label, commit }
    }) + '\n');
    flow.checkDrift(flow.fingerprints(flow.prepared(before, live.base, prepareFlows, stampDeployment)),
        live.fingerprints, live.base, overwriteDrift);
    flow.report(before, after);
    const plan = {
        repo: 'vzakusylo/victron', sha: commit, expectRev: live.rev, overwriteDrift,
        base: { sha: live.base, flowsSha256: sha256(base) },
        flowsSha256: sha256(target), stampSha256: sha256(git('show', commit + ':tools/deploy-version.js')),
        prepareSha256: sha256(git('show', commit + ':tools/victron-secrets.js')),
        tools: Object.fromEntries(tools.map(tool => [tool, sha256(git('show', commit + ':' + tool))]))
    };
    fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
    console.log('plan written to ' + file);
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
    const planFile = option('--plan');
    const overwriteDrift = args.includes('--overwrite-drift');
    if (planFile) return writePlan(live, commit, planFile, option('--summary'),
        (option('--tools') || '').split(',').filter(Boolean), overwriteDrift);
    if (overwriteDrift) throw new Error('--overwrite-drift requires --plan.');
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
        return node ? (field === 'libs' && Object.hasOwn(node, field) ? stable(node[field]) : norm(node[field])) : null;
    };
    const liveById = new Map(live.nodes.map((node) => [node.id, node]));
    const list = (title, items) => {
        console.log('\n' + title + ' (' + items.length + ')');
        for (const item of items) {
            const label = item.field === 'libs' ? item.id + '.libs' : item.id;
            let line = '  ' + label.padEnd(24) + item.type.padEnd(18) + (item.name || '').padEnd(30);
            if (item.field) line += (item.field === 'libs' ? '' : item.field).padEnd(11) + '+' + item.added + ' -' + item.removed;
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
    list('config differs', diff.config);
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

}

if (require.main === module) {
    try { main(); } catch (error) { console.error('ABORT: ' + error.message); process.exitCode = 1; }
}
