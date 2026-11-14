'use strict';
// The backup must carry everything a restored GX needs to start and to be checked / deployed again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadNode, ROOT } = require('./harness');

const TOOLS = 'data/home/nodered/tools';
const texts = (call) => JSON.stringify([call.result, call.sent]);

test('26: the backup includes the tool scripts folder, and a restore accepts it', () => {
    const node = loadNode('26 Manage backup dashboard.js');
    const create = texts(node.run({ topic: 'backup-command', payload: { action: 'create' } }, {}));
    assert.ok(create.includes(TOOLS), 'the create script archives the tools folder');
    assert.ok(create.includes('Tool scripts'), 'the page lists it');

    const restore = loadNode('26 Manage backup dashboard.js');
    restore.flow.set('backupDashboardState', { backups: [{ name: 'grid-backup-1.tar.gz' }] });
    const script = texts(restore.run({ topic: 'backup-command',
        payload: { action: 'restore', name: 'grid-backup-1.tar.gz', confirm: 'RESTORE' } }, {}));
    assert.ok(script.includes(TOOLS), 'the restore allow-list and copy loop include the tools folder');
});

test('every script the flow or the secret loader runs on the GX is a tracked tool', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json'), 'utf8'));
    const used = new Set();
    for (const node of flows) {
        for (const field of ['command', 'func', 'append']) {
            for (const m of String(node[field] || '').matchAll(/\/data\/home\/nodered\/tools\/([\w.-]+\.js)/g)) used.add(m[1]);
        }
    }
    assert.ok(used.size >= 3, 'found: ' + [...used].join(', '));
    for (const file of used) assert.ok(fs.existsSync(path.join(ROOT, 'tools', file)), 'tools/' + file + ' is used by the flow but not in the repository');
    for (const file of ['victron-secrets.js', 'reload-victron-secrets.js']) assert.ok(fs.existsSync(path.join(ROOT, 'tools', file)));
    for (const file of ['live-snapshot.js', 'compare.js', 'deploy.js', 'verify.js']) assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'gx', file)));
});
