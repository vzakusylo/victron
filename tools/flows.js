#!/usr/bin/env node
// Sync the numbered sources into flows.json and check the flow file.
//
//   node tools/flows.js sync            sync every source, bump d#<n> once if anything changed
//   node tools/flows.js sync 01 40      sync only the sources with these numbers
//   node tools/flows.js sync --no-bump  sync without touching the tab version
//   node tools/flows.js bump            bump d#<n> (after a manual edit of flows.json)
//   node tools/flows.js check           verify sync, syntax, wiring, secrets (exit 1 on a problem)
//   node tools/flows.js version         print the tab label
//
// Source -> node mapping (no table to maintain):
//   "NN Name.js"       -> function node "Name", property `func`
//   "NN Name.init.js"  -> function node "Name", property `initialize` (On Start)
//   "NN Name.html"     -> ui_template "Name" (or "Name" without a trailing " page"), property `format`
// Sources are embedded with LF line endings and without trailing blank lines, whatever the
// checkout uses, so the same source always gives the same flows.json.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = path.join(ROOT, 'flows.json');
const SOURCE_RE = /^(\d\d) (.+?)(\.init\.js|\.js|\.html)$/;

function normalize(text) {
    return String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function listSources() {
    return fs.readdirSync(ROOT).map((file) => {
        const m = file.match(SOURCE_RE);
        if (!m) return null;
        const kind = m[3];
        return {
            file,
            number: m[1],
            name: m[2],
            type: kind === '.html' ? 'ui_template' : 'function',
            prop: kind === '.html' ? 'format' : (kind === '.init.js' ? 'initialize' : 'func'),
            text: normalize(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        };
    }).filter(Boolean).sort((a, b) => a.file.localeCompare(b.file));
}

function nodesFor(flows, source) {
    const names = source.type === 'ui_template'
        ? [source.name, source.name.replace(/ page$/, '')]
        : [source.name];
    for (const name of names) {
        const found = flows.filter((n) => n.type === source.type && n.name === name);
        if (found.length) return found;
    }
    return [];
}

function readFlows() {
    const raw = fs.readFileSync(FLOWS, 'utf8');
    return { raw, flows: JSON.parse(raw), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

function serialize(flows, eol) {
    const text = JSON.stringify(flows, null, 2);
    return eol === '\n' ? text : text.replace(/\n/g, eol);
}

function versionTab(flows) {
    return flows.find((n) => n.type === 'tab' && /d#\d+/.test(n.label || ''));
}

function bump(flows) {
    const tab = versionTab(flows);
    if (!tab) throw new Error('no tab with a d#<n> label in flows.json');
    tab.label = tab.label.replace(/d#(\d+)/, (_, n) => 'd#' + (Number(n) + 1));
    return tab.label;
}

function cmdSync(args) {
    const noBump = args.includes('--no-bump');
    const only = args.filter((a) => /^\d\d$/.test(a));
    const { flows, eol } = readFlows();
    let changed = 0;
    for (const source of listSources()) {
        if (only.length && !only.includes(source.number)) continue;
        const nodes = nodesFor(flows, source);
        if (!nodes.length) {
            console.error('NO NODE   ' + source.file + ' (expected ' + source.type + ' "' + source.name + '")');
            process.exitCode = 1;
            continue;
        }
        for (const node of nodes) {
            if (node[source.prop] === source.text) continue;
            node[source.prop] = source.text;
            changed++;
            console.log('SYNCED    ' + source.file + ' -> ' + node.name + (source.prop === 'func' || source.prop === 'format' ? '' : ' (' + source.prop + ')'));
        }
    }
    if (!changed) {
        console.log('Nothing to sync. ' + versionTab(flows).label);
        return;
    }
    if (!noBump) console.log('Tab -> ' + bump(flows));
    fs.writeFileSync(FLOWS, serialize(flows, eol));
    console.log('DONE - ' + changed + ' node(s) updated.');
}

function cmdBump() {
    const { flows, eol } = readFlows();
    console.log('Tab -> ' + bump(flows));
    fs.writeFileSync(FLOWS, serialize(flows, eol));
}

function compiles(code, what, problems) {
    try {
        // Node-RED wraps function code in an async function.
        new Function('return (async function (msg, node, context, flow, global, env, RED) {\n' + code + '\n})');
    } catch (e) {
        problems.push(what + ': syntax error: ' + e.message);
    }
}

function cmdCheck() {
    const problems = [];
    const { raw, flows, eol } = readFlows();
    const ids = new Set(flows.map((n) => n.id));

    if (serialize(flows, eol) !== raw) problems.push('flows.json is not in canonical form (JSON.stringify, 2 spaces, no trailing newline)');
    if (ids.size !== flows.length) problems.push('duplicate node ids');
    const tabs = flows.filter((n) => n.type === 'tab');
    if (!versionTab(flows)) problems.push('no tab label with d#<n>');

    for (const source of listSources()) {
        const nodes = nodesFor(flows, source);
        if (!nodes.length) problems.push(source.file + ': no ' + source.type + ' node named "' + source.name + '"');
        for (const node of nodes) {
            if (node[source.prop] !== source.text) problems.push(source.file + ': differs from node "' + node.name + '" (' + source.prop + ') - run: node tools/flows.js sync');
        }
    }

    const sourced = new Set(listSources().filter((s) => s.type === 'function').map((s) => s.name));
    for (const n of flows) {
        if (n.z && !ids.has(n.z)) problems.push((n.name || n.id) + ': unknown tab / subflow ' + n.z);
        (n.wires || []).forEach((out) => out.forEach((id) => {
            if (!ids.has(id)) problems.push((n.name || n.id) + ': wire to missing node ' + id);
        }));
        if (n.type === 'function') {
            if (!sourced.has(n.name)) problems.push('function node "' + n.name + '" has no numbered source file');
            if ((n.wires || []).length !== n.outputs) problems.push('function node "' + n.name + '": outputs ' + n.outputs + ' but ' + (n.wires || []).length + ' wire lists');
            compiles(n.func || '', 'function node "' + n.name + '"', problems);
            if (n.initialize) compiles(n.initialize, 'function node "' + n.name + '" (On Start)', problems);
            if (n.finalize) compiles(n.finalize, 'function node "' + n.name + '" (On Stop)', problems);
        }
        if (n.type === 'tuya-smart-device') {
            if (n.deviceId || n.deviceKey) problems.push('Tuya node "' + (n.deviceName || n.name || n.id) + '": deviceId / deviceKey must stay empty in the repository');
            if (n.storeAsCreds !== true) problems.push('Tuya node "' + (n.deviceName || n.name || n.id) + '": storeAsCreds must be true');
        }
    }

    if (problems.length) {
        problems.forEach((p) => console.error('FAIL  ' + p));
        console.error(problems.length + ' problem(s).');
        process.exit(1);
    }
    console.log('OK  ' + tabs.map((t) => t.label).join(', ') + ' - ' + flows.length + ' nodes, ' + listSources().length + ' sources in sync.');
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
case 'sync': cmdSync(args); break;
case 'bump': cmdBump(); break;
case 'check': cmdCheck(); break;
case 'version': console.log(versionTab(readFlows().flows).label); break;
default:
    console.error('usage: node tools/flows.js sync [NN ...] [--no-bump] | bump | check | version');
    process.exit(2);
}
