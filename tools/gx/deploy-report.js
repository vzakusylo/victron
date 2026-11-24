'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { versions } = require('../infra-version.js');
const { differences, fingerprints } = require('./whole-flow.js');

// Only counts, validated commit IDs and addition metadata from Git may leave the private run folder.
function publicSummary(before, { commit, mode, outcome, version }) {
    if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('Expected a full deployment commit SHA.');
    if (!['dry-run', 'apply'].includes(mode)) throw new Error('Unexpected deployment mode.');
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(outcome)) throw new Error('Unexpected deployment outcome.');
    if (!['stable', 'test'].includes(version)) throw new Error('Unexpected version label.');
    const sha = (value) => /^[0-9a-f]{40}$/.test(value || '') ? value : null;
    return {
        commit, mode, outcome, version,
        previous: {
            dashboard: sha(before?.live?.source?.dashboard),
            automations: sha(before?.live?.source?.automations)
        }
    };
}

function plannedChanges(runFolder, commit, root = path.join(__dirname, '..', '..')) {
    const file = path.join(runFolder, 'plan.json');
    if (!fs.existsSync(file)) return null;
    const plan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const base = plan.base?.sha;
    if (![base, commit].every(sha => /^[0-9a-f]{40}$/.test(sha || '')) || plan.sha !== commit) {
        throw new Error('Invalid plan for deployment report.');
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 27 });
    git('merge-base', '--is-ancestor', base, commit);
    const old = JSON.parse(git('show', base + ':flows.json'));
    const target = JSON.parse(git('show', commit + ':flows.json'));
    const { added, removed, changed } = differences(fingerprints(old), fingerprints(target));
    const nodes = new Map([...old, ...target].map(({ id, type, name }) => [id, { id, type, name: name || '' }]));
    return { additions: added.map(id => nodes.get(id)), removals: removed.map(id => nodes.get(id)), changed: changed.length };
}

function repositoryChanges(previous, commit, root = path.join(__dirname, '..', '..')) {
    if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('Expected a full deployment commit SHA.');
    const groups = new Map();
    for (const scope of ['dashboard', 'automations']) {
        const from = previous[scope];
        if (from !== null && !/^[0-9a-f]{40}$/.test(from || '')) throw new Error('Invalid previous commit SHA.');
        if (!groups.has(from)) groups.set(from, []);
        groups.get(from).push(scope);
    }
    const git = (args, input) => execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8', input, maxBuffer: 1 << 27, stdio: ['pipe', 'pipe', 'pipe']
    });
    return [...groups].map(([from, scopes]) => {
        if (from === null) return { scopes, from, to: commit, status: 'previous-not-recorded' };
        if (git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], from + '\n').trim().endsWith(' missing')) {
            return { scopes, from, to: commit, status: 'previous-not-in-repository' };
        }
        const log = git(['log', '--reverse', '--format=%H%x00%s', `${from}..${commit}`]).trim();
        const files = git(['diff', '--name-status', '-z', '--no-renames', from, commit, '--']).split('\0');
        files.pop();
        const changedFiles = [];
        for (let i = 0; i < files.length; i += 2) changedFiles.push({ status: files[i], path: files[i + 1] });
        return {
            scopes, from, to: commit, status: 'compared',
            commits: log ? log.split('\n').map((line) => {
                const [sha, subject] = line.split('\0');
                return { sha, subject };
            }) : [],
            files: changedFiles
        };
    });
}

function formatReport(report) {
    const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]|]/g, '\\$&');
    const lines = [
        '### GX deployment',
        '',
        `Version label: **${report.version}** (report only)`,
        ...(report.repositoryVersion ? [`Repository version: **${report.repositoryVersion.d} · ${report.repositoryVersion.i}**`] : []),
        `Mode: **${report.mode}**; outcome: **${report.outcome}**`,
        `Target commit: \`${report.commit}\``,
        '',
        'Repository changes since the previous GX version (not every repository file is deployed):'
    ];
    for (const change of report.changes) {
        lines.push('', `#### ${change.scopes.join(' / ')}`);
        if (change.status !== 'compared') {
            lines.push(change.status === 'previous-not-recorded'
                ? 'Previous Git commit is not recorded; comparison is unavailable.'
                : `Previous commit \`${change.from}\` is not in the repository; comparison is unavailable.`);
            continue;
        }
        lines.push(`Compared \`${change.from}\` to \`${change.to}\`.`, '', 'Commits:');
        if (!change.commits.length) lines.push('No new commits in the target history.');
        for (const commit of change.commits) lines.push(`- \`${commit.sha.slice(0, 12)}\` ${escape(commit.subject)}`);
        lines.push('', 'Changed files:');
        if (!change.files.length) lines.push('No repository file changes.');
        for (const file of change.files) lines.push(`- ${escape(file.status)} ${escape(file.path)}`);
    }
    if (report.flow) {
        lines.push('', `Git flow diff: ${report.flow.additions.length} added, ${report.flow.removals.length} removed, ${report.flow.changed} changed.`);
        for (const [label, nodes] of [['Added', report.flow.additions], ['Removed', report.flow.removals]]) {
            for (const node of nodes) lines.push(`- ${label}: ` + escape(JSON.stringify(node)));
        }
    }
    return lines.join('\n') + '\n';
}

module.exports = { publicSummary, repositoryChanges, formatReport, plannedChanges };

if (require.main === module) {
    const [runFolder, output] = process.argv.slice(2);
    if (!runFolder || !output) throw new Error('Usage: deploy-report.js RUN_FOLDER OUTPUT.json');
    const read = (name) => {
        const file = path.join(runFolder, name);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    const report = publicSummary(read('summary-before.json'), {
        commit: process.env.DEPLOY_SHA || process.env.GITHUB_SHA, mode: process.env.MODE, outcome: process.env.DEPLOY_OUTCOME,
        version: process.env.VERSION_TYPE
    });
    report.changes = repositoryChanges(report.previous, report.commit);
    report.repositoryVersion = versions();
    report.flow = plannedChanges(runFolder, report.commit);
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(formatReport(report));
}
