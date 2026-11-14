#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const START = '<!-- victron-deployment-source -->';
const END = '<!-- /victron-deployment-source -->';
const SCOPES = ['dashboard', 'automations'];
const SUFFIX = / \[(?:git [a-f0-9]{12}|UI (?:[a-f0-9]{12}|unrecorded); Auto (?:[a-f0-9]{12}|unrecorded))\]$/;

function commitSha(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
        throw new Error('Deployment source must be a full 40-character Git commit SHA.');
    }
    return value.toLowerCase();
}

function readMetadata(info) {
    const start = info.indexOf(START);
    const end = info.indexOf(END);
    if (start === -1 && end === -1) {
        return { record: { dashboard: null, automations: null }, start, end };
    }
    if (start < 0 || end < start || info.indexOf(START, start + START.length) !== -1 ||
        info.indexOf(END, end + END.length) !== -1) {
        throw new Error('Invalid or duplicate deployment metadata markers in tab info.');
    }
    let record;
    try { record = JSON.parse(info.slice(start + START.length, end)); }
    catch { throw new Error('Invalid deployment metadata JSON in tab info.'); }
    if (!record || Array.isArray(record) || Object.keys(record).length !== 2 ||
        !SCOPES.every((scope) => Object.hasOwn(record, scope))) {
        throw new Error('Deployment metadata must contain dashboard and automations.');
    }
    for (const scope of SCOPES) {
        if (record[scope] !== null) record[scope] = commitSha(record[scope]);
    }
    return { record, start, end };
}

function singleNode(flows, predicate, label) {
    const nodes = flows.filter(predicate);
    if (nodes.length !== 1) throw new Error('Expected exactly one ' + label + '.');
    return nodes[0];
}

function flowNodes(payload) {
    const flows = Array.isArray(payload) ? payload : payload && payload.flows;
    if (!Array.isArray(flows) || flows.some((node) => !node || typeof node !== 'object' || Array.isArray(node))) {
        throw new Error('Expected a flows array or a Node-RED v2 payload with flows.');
    }
    return flows;
}

function versionTab(flows) {
    return singleNode(flows, (node) => node.type === 'tab' && typeof node.label === 'string' && /d#\d+/.test(node.label), 'd# version tab');
}

function tabInfo(tab) {
    if (tab.info !== undefined && typeof tab.info !== 'string') {
        throw new Error('Version tab info must be a string.');
    }
    return tab.info || '';
}

function stampDeployment(input, commits, liveSnapshot) {
    flowNodes(input);
    if (!commits || !Object.keys(commits).length ||
        Object.keys(commits).some((scope) => !SCOPES.includes(scope))) {
        throw new Error('Specify the source commit for dashboard and/or automations.');
    }
    const sources = Object.fromEntries(Object.entries(commits).map(([scope, value]) => [scope, commitSha(value)]));
    if (Object.keys(sources).length !== SCOPES.length && liveSnapshot === undefined) {
        throw new Error('Partial deployments require the original live flow snapshot.');
    }
    const prepared = JSON.parse(JSON.stringify(input));
    const flows = flowNodes(prepared);
    const tab = versionTab(flows);
    const base = singleNode(flows, (node) => node.type === 'ui_base', 'dashboard ui_base');
    const pages = flows.filter((node) => node.type === 'ui_tab');
    if (!base.site || typeof base.site.name !== 'string' || !base.site.name ||
        !pages.length || pages.some((node) => typeof node.name !== 'string' || !node.name)) {
        throw new Error('Dashboard site/page names must be valid strings.');
    }
    const info = tabInfo(tab);
    const metadata = readMetadata(info);
    let previous = metadata.record;
    if (liveSnapshot !== undefined) {
        const liveTab = versionTab(flowNodes(liveSnapshot));
        if (liveTab.id !== tab.id) throw new Error('Original live snapshot has a different version tab ID.');
        if (!Array.isArray(input) && !Array.isArray(liveSnapshot) &&
            input.rev !== undefined && liveSnapshot.rev !== undefined && input.rev !== liveSnapshot.rev) {
            throw new Error('Original live snapshot revision differs from the prepared payload.');
        }
        previous = readMetadata(tabInfo(liveTab)).record;
    }
    const record = Object.assign({}, previous, sources);
    const short = (value) => value === null ? 'unrecorded' : value.slice(0, 12);
    const suffix = record.dashboard && record.dashboard === record.automations
        ? ' [git ' + short(record.dashboard) + ']'
        : ' [UI ' + short(record.dashboard) + '; Auto ' + short(record.automations) + ']';
    const label = (value) => value.replace(SUFFIX, '') + suffix;
    tab.label = label(tab.label);
    base.site.name = label(base.site.name);
    // With an unlocked menu the dashboard toolbar shows the selected page, not site.name.
    for (const page of pages) page.name = label(page.name);
    const block = START + '\n' + JSON.stringify(record) + '\n' + END;
    tab.info = metadata.start === -1
        ? info + (info ? '\n\n' : '') + block
        : info.slice(0, metadata.start) + block + info.slice(metadata.end + END.length);
    return prepared;
}

module.exports = { stampDeployment };

function readPayload(file, label) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('Cannot read valid ' + label + ' flow JSON; check the file and permissions.'); }
}

if (require.main === module) {
    try {
        const [input, output, ...args] = process.argv.slice(2);
        if (!input || !output || !args.length || args.length % 2) {
            throw new Error('Usage: deploy-version.js INPUT OUTPUT [--live ORIGINAL_LIVE] --dashboard SHA [--automations SHA] (--live is required for either scope alone).');
        }
        if (path.resolve(input) === path.resolve(output)) {
            throw new Error('Use a separate output file; do not overwrite the input flows.');
        }
        const commits = {};
        let liveFile;
        for (let i = 0; i < args.length; i += 2) {
            if (args[i] === '--live') {
                if (liveFile !== undefined) throw new Error('Duplicate original live snapshot argument.');
                liveFile = args[i + 1];
                continue;
            }
            const scope = args[i].replace(/^--/, '');
            if (args[i] !== '--' + scope || !SCOPES.includes(scope) || Object.hasOwn(commits, scope)) {
                throw new Error('Unknown or duplicate deployment scope.');
            }
            commits[scope] = args[i + 1];
        }
        const payload = readPayload(input, 'input');
        const liveSnapshot = liveFile === undefined ? undefined : readPayload(liveFile, 'original live');
        fs.writeFileSync(output, JSON.stringify(stampDeployment(payload, commits, liveSnapshot), null, 2), { mode: 0o600, flag: 'wx' });
        console.log('Prepared deployment source labels; no live deployment performed.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
