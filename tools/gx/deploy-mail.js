'use strict';
// Builds the "GX deployed" mail ({subject, text}) that deploy-gx-code.yml pipes into
// /data/home/nodered/tools/send-mail.js on the GX after a successful apply. Pure text, no secrets, no hosts.
//
// CLI: deploy-mail.js RUN_FOLDER   (env: DEPLOY_SHA, TRIGGER_EVENT, ACTOR, TEST_RUN_URL, DEPLOY_RUN_URL,
//                                   ALLOW_LIVE_ONLY_LINES) -> mail JSON on stdout
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { plannedAdditions } = require('./deploy-report.js');
const { versions } = require('../infra-version.js');

const MAX_COMMITS = 40;
const SHA = /^[0-9a-f]{40}$/;

// Subjects come from the public history, but keep addresses and IPs out of a mail anyway.
function scrub(value) {
    return String(value).replace(/[\r\n]+/g, ' ')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
        .replace(/[\w.+-]+@[\w.-]+/g, '<address>');
}

function groupFiles(files) {
    const groups = { 'flow sources': [], lib: [], pages: [], tools: [], other: [] };
    for (const file of files) {
        if (/^\d+ .*\.js$/.test(file)) groups['flow sources'].push(file);
        else if (/^\d+ .*\.html$/.test(file)) groups.pages.push(file);
        else if (file.startsWith('lib/') || file === 'flows.json') groups.lib.push(file);
        else if (file.startsWith('tools/') || file.startsWith('scripts/')) groups.tools.push(file);
        else groups.other.push(file);
    }
    return groups;
}

function buildMail(input) {
    const short = (sha) => (sha ? String(sha).slice(0, 7) : null);
    const version = (label, sha) => [label, short(sha) && `(${short(sha)})`].filter(Boolean).join(' ') || 'not recorded';
    const lines = [];
    const subject = `GX deployed ${input.newLabel || 'd#?'} (${short(input.newCommit)})`;

    lines.push(`${version(input.oldLabel, input.oldCommit)} -> ${version(input.newLabel, input.newCommit)}`, '');
    if (input.trigger && input.trigger.kind === 'manual') {
        lines.push(`Trigger: manual dispatch by ${scrub(input.trigger.actor || 'unknown')}`);
    } else {
        lines.push(`Trigger: automatic after Test GX run${input.trigger && input.trigger.testRunUrl ? ' ' + input.trigger.testRunUrl : ''}`);
    }
    if (input.allowLiveOnlyLines) lines.push('allow_live_only_lines: USED (GX-only code lines were replaced)');
    if (input.additions?.length) {
        lines.push('', `Added nodes (${input.additions.length}):`);
        for (const node of input.additions) lines.push('  ' + scrub(JSON.stringify(node)));
    }

    const files = input.files || [];
    lines.push('', `Changed files (${files.length}):`);
    if (input.files === null || input.files === undefined) lines.push('  comparison unavailable (previous commit not recorded or not in the repository)');
    else if (!files.length) lines.push('  none');
    else {
        for (const [name, list] of Object.entries(groupFiles(files))) {
            if (!list.length) continue;
            if (name === 'other') lines.push(`  other: ${list.length} file(s), not deployed to the GX`);
            else lines.push(`  ${name}: ${list.map(scrub).join(', ')}`);
        }
    }

    const commits = input.commits || [];
    lines.push('', `Commits (${commits.length}):`);
    if (!commits.length) lines.push('  none');
    for (const commit of commits.slice(0, MAX_COMMITS)) lines.push(`  ${short(commit.sha)} ${scrub(commit.subject)}`);
    if (commits.length > MAX_COMMITS) lines.push(`  +${commits.length - MAX_COMMITS} more`);

    lines.push('');
    if (input.testRunUrl) lines.push(`Test GX run: ${input.testRunUrl}`);
    if (input.deployRunUrl) lines.push(`Deploy run: ${input.deployRunUrl}`);
    return { subject, text: lines.join('\n') + '\n' };
}

function collect(runFolder, env, root = path.join(__dirname, '..', '..')) {
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'pipe'] });
    const newCommit = env.DEPLOY_SHA;
    const { d, i } = versions(root);
    const newLabel = `${d} · ${i}`;

    let before = null;
    const beforeFile = path.join(runFolder, 'summary-before.json');
    if (fs.existsSync(beforeFile)) before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
    const source = (before && before.live && before.live.source) || {};
    const oldCommit = [source.automations, source.dashboard].find((sha) => SHA.test(sha || '')) || null;
    const oldLabel = before && before.live && before.live.label ? (/d#\d+/.exec(before.live.label) || [null])[0] : null;

    let commits = [];
    let files = null;
    if (oldCommit && SHA.test(newCommit || '')) {
        try {
            commits = git(['log', '--no-merges', '--format=%H%x00%s', `${oldCommit}..${newCommit}`]).split('\n').filter(Boolean)
                .map((line) => { const [sha, subject] = line.split('\0'); return { sha, subject }; });
            files = git(['diff', '--name-only', '--no-renames', oldCommit, newCommit, '--']).split('\n').filter(Boolean);
        } catch { commits = []; files = null; }
    }
    return {
        oldLabel, oldCommit, newLabel, newCommit, commits, files,
        trigger: env.TRIGGER_EVENT === 'workflow_run'
            ? { kind: 'automatic', testRunUrl: env.TEST_RUN_URL }
            : { kind: 'manual', actor: env.ACTOR },
        testRunUrl: env.TEST_RUN_URL || '',
        deployRunUrl: env.DEPLOY_RUN_URL || '',
        allowLiveOnlyLines: env.ALLOW_LIVE_ONLY_LINES === 'true' ||
            (env.TRIGGER_EVENT === 'workflow_run' && SHA.test(planReplacedFrom(runFolder) || '')),
        additions: plannedAdditions(runFolder, newCommit, root)
    };
}

function planReplacedFrom(runFolder) {
    const file = path.join(runFolder, 'plan.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).replacedFrom : null;
}

module.exports = { buildMail, collect, groupFiles, scrub, MAX_COMMITS };

if (require.main === module) {
    const runFolder = process.argv[2];
    if (!runFolder) throw new Error('Usage: deploy-mail.js RUN_FOLDER');
    process.stdout.write(JSON.stringify(buildMail(collect(runFolder, process.env))));
}
