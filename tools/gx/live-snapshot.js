#!/usr/bin/env node
// Read-only snapshot of the LIVE Node-RED flow on the Cerbo GX, small enough to send to the PC.
// Runs ON THE GX (piped over SSH); tools/gx/compare.js on the PC compares it with the repository.
//
// Usage (PowerShell 7 on the PC, see docs/gx-deploy.md):
//   Get-Content -Raw tools\gx\live-snapshot.js | ssh <gx> "tr -d '\r' | node -" > live.b64
//
// Output: one line, base64 of gzip of
//   { rev, at, nodes: [{ id, type, name, code: { func, initialize, finalize, format, command }, rest,
//                        label, info, site }] }
// `rest` is a hash of every other property (wires, outputs, settings ...) without the editor position.
// No credentials leave the GX: `GET /flows` does not return them, and the Tuya node settings are only hashed.
'use strict';
const crypto = require('crypto');

const CODE_FIELDS = ['func', 'initialize', 'finalize', 'format', 'command'];
const LAYOUT_FIELDS = ['x', 'y', 'g'];
const SOURCE_LABEL = / \[(?:git [a-f0-9]{12}|local [a-f0-9]{12}|UI (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))\]$/;

// Stable JSON: the key order of a node differs between the editor export and the repository file.
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

function snapshot(flows, rev) {
    const nodes = flows.map((node) => {
        const rest = Object.assign({}, node);
        for (const key of CODE_FIELDS.concat(LAYOUT_FIELDS, ['info', 'credentials'])) delete rest[key];
        if (node.type === 'group') delete rest.nodes;
        // The source label of tools/deploy-version.js is deployment state, not a difference.
        for (const key of ['label', 'name']) if (typeof rest[key] === 'string') rest[key] = rest[key].replace(SOURCE_LABEL, '');
        if (rest.site && typeof rest.site.name === 'string') rest.site = Object.assign({}, rest.site, { name: rest.site.name.replace(SOURCE_LABEL, '') });
        const code = {};
        for (const field of CODE_FIELDS) if (typeof node[field] === 'string') code[field] = node[field];
        const entry = { id: node.id, type: node.type, name: node.name || node.label || '', code,
            rest: crypto.createHash('sha1').update(stable(rest)).digest('hex').slice(0, 12) };
        if (node.type === 'tab') { entry.label = node.label; entry.info = node.info || ''; }
        if (node.type === 'ui_base') entry.site = node.site && node.site.name;
        return entry;
    });
    return { rev: rev || null, at: Date.now(), nodes };
}

module.exports = { snapshot, stable, CODE_FIELDS, LAYOUT_FIELDS };

// Piped to `node -` there is no main module.
if (!require.main || require.main === module) {
    require('http').get({ host: '127.0.0.1', port: Number(process.env.VICTRON_API_PORT) || 1880, path: '/flows', headers: { 'Node-RED-API-Version': 'v2' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
            if (res.statusCode !== 200) { console.error('GET /flows -> ' + res.statusCode); process.exit(1); }
            const live = JSON.parse(body);
            console.log(require('zlib').gzipSync(JSON.stringify(snapshot(live.flows, live.rev))).toString('base64'));
        });
    }).on('error', (error) => { console.error(error.message); process.exit(1); });
}
