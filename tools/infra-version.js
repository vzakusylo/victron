#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const ROOT = path.join(__dirname, '..');
const FILE = 'tools/infra-version.json';
const EMPTY = { i: 0, changes: [] };
const AGENT_DOCS = new Set([
    'CLAUDE.md', 'docs/claude-operating-guide.md', 'docs/agent-workflow.md', '.github/copilot-instructions.md'
]);
const INFRA = /^(tools|scripts|\.github\/workflows|tests|\.claude\/skills)\//;

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parse(text) {
    const data = JSON.parse(text);
    if (!data || !Number.isSafeInteger(data.i) || data.i < 1 ||
        !Array.isArray(data.changes) || data.changes.length !== data.i ||
        !data.changes.every((change, index) => change && change.i === index + 1 &&
            typeof change.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(change.date) &&
            (change.pr === null || (Number.isSafeInteger(change.pr) && change.pr > 0)) &&
            typeof change.what === 'string' && change.what.trim() && !/[\r\n]/.test(change.what))) {
        throw new Error(`Invalid ${FILE}: expected sequential i# entries with date, PR (or null), and description.`);
    }
    return data;
}

function read(root = ROOT) {
    const file = path.join(root, FILE);
    return fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : EMPTY;
}

function versions(root = ROOT) {
    const flows = JSON.parse(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'));
    const d = flows.find(node => node.type === 'tab' && /d#\d+/.test(node.label || ''))?.label.match(/d#\d+/)[0];
    if (!d) throw new Error('No tab with a d# label in flows.json.');
    return { d, i: `i#${read(root).i}` };
}

function compare(root, ref) {
    // Local checks compare the worktree to its fork point; CI supplies the actual base of the tested tree.
    const base = (ref ? git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
        : git(root, 'merge-base', 'HEAD', 'origin/master')).trim();
    const baseline = git(root, 'ls-tree', base, '--', FILE) ? parse(git(root, 'show', `${base}:${FILE}`)) : EMPTY;
    const current = read(root);
    const files = `${git(root, 'diff', '--name-only', '--no-renames', '-z', base, '--')}${git(root, 'ls-files', '--others', '--exclude-standard', '-z')}`
        .split('\0').filter(file => file !== FILE && (INFRA.test(file) || AGENT_DOCS.has(file)));
    if (current.i < baseline.i || !isDeepStrictEqual(current.changes.slice(0, baseline.i), baseline.changes)) {
        throw new Error(`Preserve the ${FILE} history from the base branch.`);
    }
    if (current.i > baseline.i + 1) throw new Error(`Only one i# bump is allowed (base i#${baseline.i}, found i#${current.i}).`);
    return { baseline, current, files };
}

function main([command, ...args]) {
    if (command === 'check' && args.length <= 1) {
        const { baseline, current, files } = compare(ROOT, args[0]);
        const expected = baseline.i + Number(Boolean(files.length));
        if (current.i !== expected) {
            throw new Error(files.length
                ? `Infrastructure changed (${[...new Set(files)].slice(0, 5).join(', ')}); run: node tools/infra-version.js bump "Short description"`
                : 'No infrastructure changes; do not bump i#.');
        }
        console.log(`OK  i#${current.i} (${files.length ? 'one infrastructure bump' : 'unchanged'})`);
    } else if (command === 'bump' && args.length <= 2) {
        const { baseline, current, files } = compare(ROOT);
        const [what, pr] = args;
        if (!files.length) throw new Error('No infrastructure changes; do not bump i#.');
        if (current.i === baseline.i + 1 && pr === undefined) {
            console.log(`Already bumped to i#${current.i}`);
            return;
        }
        const i = baseline.i + 1;
        const entry = current.changes[i - 1];
        const next = { i, changes: [...baseline.changes, {
            i, date: entry?.date ?? new Date().toISOString().slice(0, 10),
            pr: pr === undefined ? null : Number(pr), what: what?.trim() || entry?.what
        }] };
        const text = JSON.stringify(next, null, 2) + '\n';
        parse(text);
        fs.writeFileSync(path.join(ROOT, FILE), text);
        console.log(`${entry ? 'Updated' : 'Bumped to'} i#${i}`);
    } else {
        throw new Error('Usage: node tools/infra-version.js check [base-commit] | bump "Short description" [PR-number]');
    }
}

module.exports = { versions };

if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch (error) {
        console.error('FAIL  ' + error.message);
        process.exitCode = 1;
    }
}
