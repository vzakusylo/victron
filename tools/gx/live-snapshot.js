#!/usr/bin/env node
// Read-only snapshot of the LIVE Node-RED flow on the Cerbo GX, small enough to send to the PC.
// Runs ON THE GX (piped over SSH); tools/gx/compare.js on the PC compares it with the repository.
//
// Usage (PowerShell 7 on the PC, see docs/gx-deploy.md):
//   Get-Content -Raw tools\gx\live-snapshot.js,tools\gx\admin-api.js | ssh <gx> "tr -d '\r' | node -" > live.b64
//
// Output: one line, base64 of gzip of
//   { rev, at, nodes: [{ id, type, name, code: { func, initialize, finalize, format, command, libs }, rest,
//                        label, info, site }] }
// `rest` is a hash of every other property (wires, outputs, settings ...) without the editor position.
// With `--raw` (node - --raw) each node also carries `restJson`, the stable JSON that was hashed. It contains
// the real device ids and addresses, so keep that file private: it is only for compare-image.js --live --map.
// --topology adds only the wiring, group and route metadata needed by the deploy planner.
// No credentials leave the GX: `GET /flows` does not return them, and the Tuya node settings are only hashed.
'use strict';
const crypto = require('crypto');

const CODE_FIELDS = ['func', 'initialize', 'finalize', 'format', 'command'];
const LAYOUT_FIELDS = ['x', 'y', 'g'];
const SOURCE_LABEL = / \[(?:git [a-f0-9]{12}|local [a-f0-9]{12}|UI (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))\](?: TEST-GX)?$/;
const TOPOLOGY_FIELDS = ['z', 'g', 'nodes', 'group', 'wires', 'outputs', 'links', 'method', 'url'];

// Stable JSON: the key order of a node differs between the editor export and the repository file.
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

function snapshot(flows, rev, options) {
    const raw = Boolean(options && options.raw);
    const nodes = flows.map((node) => {
        const rest = Object.assign({}, node);
        for (const key of CODE_FIELDS.concat(LAYOUT_FIELDS, ['info', 'credentials'])) delete rest[key];
        if (node.type === 'group') delete rest.nodes;
        // The source label of tools/deploy-version.js is deployment state, not a difference.
        for (const key of ['label', 'name']) if (typeof rest[key] === 'string') rest[key] = rest[key].replace(SOURCE_LABEL, '');
        if (rest.site && typeof rest.site.name === 'string') rest.site = Object.assign({}, rest.site, { name: rest.site.name.replace(SOURCE_LABEL, '') });
        const code = {};
        for (const field of CODE_FIELDS) if (typeof node[field] === 'string') code[field] = node[field];
        if (node.type === 'function' && Object.hasOwn(node, 'libs')) {
            code.libs = stable(node.libs);
            delete rest.libs;
        }
        const entry = { id: node.id, type: node.type, name: node.name || node.label || '', code,
            rest: crypto.createHash('sha1').update(stable(rest)).digest('hex').slice(0, 12) };
        if (raw) entry.restJson = stable(rest);
        if (options && options.topology) {
            entry.topology = Object.fromEntries(TOPOLOGY_FIELDS.filter((key) => Object.hasOwn(node, key)).map((key) => [key, node[key]]));
            const { x, y, ...definition } = node;
            entry.definition = crypto.createHash('sha256').update(stable(definition)).digest('hex');
        }
        if (node.type === 'tab') { entry.label = node.label; entry.info = node.info || ''; }
        if (node.type === 'ui_base') entry.site = node.site && node.site.name;
        return entry;
    });
    return { rev: rev || null, at: Date.now(), nodes };
}

module.exports = { snapshot, stable, CODE_FIELDS, LAYOUT_FIELDS };

// Piped to `node -` there is no main module (module.id is "[stdin]"); `node -e` and require() must not start the request.
if (require.main === module || module.id === '[stdin]') {
    const api = (typeof createAdminApi === 'function' ? createAdminApi : require('./admin-api.js'))();
    api('GET', '/flows').then((body) => {
        const live = JSON.parse(body);
        console.log(require('zlib').gzipSync(JSON.stringify(snapshot(live.flows, live.rev, {
            raw: process.argv.includes('--raw'), topology: process.argv.includes('--topology')
        }))).toString('base64'));
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
