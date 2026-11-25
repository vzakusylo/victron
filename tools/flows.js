#!/usr/bin/env node
// Sync the numbered sources into flows.json and check the flow file.
//
//   node tools/flows.js sync            sync every source, bump d#<n> once if anything changed
//   node tools/flows.js sync 01 40      sync only the sources with these numbers
//   node tools/flows.js sync --no-bump  sync without touching the tab version
//   node tools/flows.js bump            bump d#<n> (after a manual edit of flows.json)
//   node tools/flows.js check           verify sync, syntax, wiring, secrets (exit 1 on a problem)
//   node tools/flows.js version         print both repository versions
//
// Source -> node mapping (no table to maintain):
//   "NN Name.js"       -> function node "Name", property `func`
//   "NN Name.init.js"  -> function node "Name", property `initialize` (On Start)
//   "NN Name.html"     -> ui_template "Name" (or "Name" without a trailing " page"), property `format`
// A leading `// #libs <JSON array>` in "NN Name.js" sets `libs` on every Function
// node matched by that source name, just like `func`, without changing its code.
// `// #no-template-replay <JSON array of names>` opts directly wired templates out of replay.
// `// #bypass-exec ["name"]` removes an obsolete read-only exec feeding this function.
// `// #replace-exec true` converts a same-named exec with only stdout wired to a Function.
// Sources are embedded with LF line endings and without trailing blank lines, whatever the
// checkout uses, so the same source always gives the same flows.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { expand, includesOf } = require('./includes');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = path.join(ROOT, 'flows.json');
const SOURCE_RE = /^(\d\d) (.+?)(\.init\.js|\.js|\.html)$/;
// Disabled inputs count too: enabling them would still leave them unwired.
const INPUT_TYPE = /^(?:inject|.+ in|victron-input-.+)$/;
const UNWIRED_INPUTS = new Map([
    ['2f42837904c91d73', {
        type: 'link in',
        reason: 'Retain the unused branch of the exported Solar forecast subflow; NR6 does not change that subflow.'
    }]
]);

function normalize(text) {
    return String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function listSources() {
    return fs.readdirSync(ROOT).map((file) => {
        const m = file.match(SOURCE_RE);
        if (!m) return null;
        const kind = m[3];
        let text = normalize(fs.readFileSync(path.join(ROOT, file), 'utf8'));
        let libs;
        let noReplay = [];
        let bypassExec = [];
        let replaceExec = false;
        let declaration;
        const seen = new Set();
        while (kind === '.js' && (declaration = /^\/\/ #(libs|no-template-replay|bypass-exec|replace-exec)\b([^\n]*)\n?/.exec(text))) {
            const [, key, json] = declaration;
            if (seen.has(key)) throw new Error(file + ': repeated #' + key + ' declaration.');
            seen.add(key);
            let value;
            try { value = JSON.parse(json); }
            catch (error) { throw new Error(file + ': invalid #' + key + ' JSON: ' + error.message, { cause: error }); }
            if (key === 'replace-exec' ? value !== true : !Array.isArray(value)) {
                throw new Error(file + ': #' + key + (key === 'replace-exec' ? ' must be true.' : ' must be a JSON array.'));
            }
            if (key === 'libs') libs = value;
            else if (key === 'no-template-replay') noReplay = value;
            else if (key === 'bypass-exec') bypassExec = value;
            else replaceExec = true;
            text = text.slice(declaration[0].length);
        }
        return {
            file,
            number: m[1],
            name: m[2],
            type: kind === '.html' ? 'ui_template' : 'function',
            prop: kind === '.html' ? 'format' : (kind === '.init.js' ? 'initialize' : 'func'),
            // `// #include lib/…js` lines are replaced by the file's text (tools/includes.js)
            text: normalize(expand(text, ROOT)),
            libs,
            noReplay,
            bypassExec,
            replaceExec
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

function replayTemplates(flows, node, source) {
    const destinations = new Set((node.wires || []).flat());
    return source.noReplay.map(name => {
        const matches = flows.filter(n => n.type === 'ui_template' && n.name === name && destinations.has(n.id));
        if (matches.length !== 1) throw new Error(source.file + ': expected one directly wired template named ' + JSON.stringify(name));
        return matches[0];
    });
}

function bypassExecs(flows, node, source, checkOnly = false) {
    let removed = 0;
    for (const name of source.bypassExec) {
        const index = flows.findIndex(n => n.type === 'exec' && n.name === name);
        if (index < 0) continue;
        if (checkOnly) return true;
        const exec = flows[index];
        if (exec.wires.flat().some(id => id !== node.id) || !exec.wires[0].includes(node.id)) {
            throw new Error(source.file + ': cannot bypass ' + name + ' with other destinations');
        }
        for (const n of flows) {
            n.wires?.forEach((out, i) => {
                if (out.includes(exec.id)) n.wires[i] = [...new Set(out.flatMap(id => id !== exec.id ? [id] : n.id === node.id ? [] : [node.id]))];
            });
            if (n.nodes?.includes(exec.id)) n.nodes = n.nodes.filter(id => id !== exec.id);
        }
        flows.splice(index, 1);
        removed++;
        console.log('SYNCED    ' + source.file + ' -> bypass ' + name);
    }
    return removed;
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
        if (source.replaceExec && !nodes.length) {
            const matches = flows.filter(n => n.type === 'exec' && n.name === source.name);
            if (matches.length !== 1 || matches[0].wires.slice(1).some(out => out.length)) {
                throw new Error(source.file + ': expected one same-named exec with only stdout wired');
            }
            const old = matches[0];
            const { command, addpay, append, useSpawn, timer, oldrc, ...layout } = old;
            const replacement = { ...layout, type: 'function', outputs: 1, wires: [old.wires[0]] };
            flows[flows.indexOf(old)] = replacement;
            nodes.push(replacement);
        }
        if (!nodes.length) {
            console.error('NO NODE   ' + source.file + ' (expected ' + source.type + ' "' + source.name + '")');
            process.exitCode = 1;
            continue;
        }
        for (const node of nodes) {
            changed += bypassExecs(flows, node, source);
            for (const template of replayTemplates(flows, node, source)) {
                if (template.storeOutMessages === false && template.resendOnRefresh === false) continue;
                template.storeOutMessages = false;
                template.resendOnRefresh = false;
                changed++;
                console.log('SYNCED    ' + source.file + ' -> ' + template.name + ' (dashboard replay)');
            }
            const codeChanged = node[source.prop] !== source.text;
            const libsChanged = source.libs !== undefined && !isDeepStrictEqual(node.libs, source.libs);
            if (!codeChanged && !libsChanged) continue;
            if (codeChanged) node[source.prop] = source.text;
            if (libsChanged) node.libs = source.libs;
            changed++;
            const fields = [codeChanged && source.prop, libsChanged && 'libs'].filter(Boolean).join(', ');
            console.log('SYNCED    ' + source.file + ' -> ' + node.name + ' (' + fields + ')');
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
            if (bypassExecs(flows, node, source, true)) problems.push(source.file + ': obsolete read exec still present - run: node tools/flows.js sync');
            for (const template of replayTemplates(flows, node, source)) {
                if (template.storeOutMessages !== false || template.resendOnRefresh !== false) {
                    problems.push(source.file + ': dashboard replay enabled on "' + template.name + '" - run: node tools/flows.js sync');
                }
            }
            if (node[source.prop] !== source.text) problems.push(source.file + ': differs from node "' + node.name + '" (' + source.prop + ') - run: node tools/flows.js sync');
            if (source.libs !== undefined && !isDeepStrictEqual(node.libs, source.libs)) {
                problems.push(source.file + ': differs from node "' + node.name + '" (libs) - run: node tools/flows.js sync');
            }
        }
    }

    // Shared libraries must opt in explicitly; all libraries must be included.
    const libDir = path.join(ROOT, 'lib');
    const libFiles = [];
    (function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.js')) libFiles.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
    })(libDir);
    const users = {};
    for (const f of fs.readdirSync(ROOT).filter((x) => SOURCE_RE.test(x))) {
        for (const inc of includesOf(fs.readFileSync(path.join(ROOT, f), 'utf8'))) (users[inc] = users[inc] || []).push(f);
    }
    for (const lib of libFiles) {
        const u = users[lib] || [];
        const shared = u.length > 1 && /^\uFEFF?\/\/! @shared\r?$/m.test(fs.readFileSync(path.join(ROOT, lib), 'utf8').split('\n', 1)[0]);
        if (u.length !== 1 && !shared) problems.push(lib + ': included by ' + (u.length ? u.join(', ') : 'no numbered source') + ' (must be exactly one unless marked @shared)');
    }

    const sourced = new Set(listSources().filter((s) => s.type === 'function').map((s) => s.name));
    for (const n of flows) {
        if (n.z && !ids.has(n.z)) problems.push((n.name || n.id) + ': unknown tab / subflow ' + n.z);
        const exception = UNWIRED_INPUTS.get(n.id);
        if (INPUT_TYPE.test(n.type) && !n.wires?.some(out => out.length > 0) &&
            !(exception?.type === n.type && exception.reason.trim())) {
            problems.push(`${n.id} (${n.type}${n.name ? ': ' + n.name : ''}): unwired input; connect it, remove it, or document an exception.`);
        }
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
case 'version': {
    const { d, i } = require('./infra-version').versions(ROOT);
    console.log(`${d} · ${i}`);
    break;
}
default:
    console.error('usage: node tools/flows.js sync [NN ...] [--no-bump] | bump | check | version');
    process.exit(2);
}
