'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const NOW = Date.parse('2026-11-22T12:00:00Z');

test('backup exec keeps the dashboard and exec outputs in order and sorts the catalog newest first', () => {
    const gx = loadNode('26 Manage backup dashboard.js');
    const payload = [
        '@@B\t1024\t2026-11-20\tbackup-older.tar.gz',
        '@@B\t2048\t2026-11-22\tuploaded-current.tar.gz',
        '@@B\t512\t2026-11-21\tpre-restore-test.tar.gz',
        '@@USER synthetic', '@@DF device 1000 750 250 75% /data'
    ].join('\r\n');
    const [dashboard, exec] = gx.run({ topic: 'backup-exec', payload }, { now: NOW }).result;
    assert.equal(exec, null);
    assert.equal(dashboard.topic, 'backup-state');
    const { user, backups, disk, busy, updatedAt } = dashboard.payload;
    assert.equal(user, 'synthetic');
    assert.equal(busy, '');
    assert.equal(updatedAt, '2026-11-22T12:00:00.000Z');
    assert.deepEqual(backups, [
        { name: 'uploaded-current.tar.gz', size: 2048, date: '2026-11-22', kind: 'uploaded', sizeText: '2.0 KB' },
        { name: 'pre-restore-test.tar.gz', size: 512, date: '2026-11-21', kind: 'safety', sizeText: '512 B' },
        { name: 'backup-older.tar.gz', size: 1024, date: '2026-11-20', kind: 'backup', sizeText: '1.0 KB' }
    ]);
    assert.deepEqual(disk, { totalText: '1000.0 KB', usedText: '750.0 KB', availableText: '250.0 KB', usePct: 75 });
    assert.deepEqual(gx.flow.get('backupDashboardState').backups, backups.map(({ sizeText, ...item }) => item));
});

test('restore stdout reports partial failures and keeps the existing dashboard disk and user', () => {
    const gx = loadNode('26 Manage backup dashboard.js');
    const initial = gx.run({ topic: 'backup-exec', payload: '@@USER synthetic\n@@DF device 1000 750 250 75% /data' }, { now: NOW }).result[0].payload;
    const [dashboard, exec] = gx.run({
        topic: 'backup-exec', backupAction: 'restore',
        payload: '@@DONE uploaded-test.tar.gz\n@@SAFETY pre-restore-test.tar.gz\n@@RESTORED data/conf/settings.xml\n@@FAILED missing\n@@SKIP optional\n@@LOG diagnostic'
    }, { now: NOW + 1000 }).result;
    assert.equal(exec, null);
    assert.equal(dashboard.payload.user, initial.user);
    assert.deepEqual(dashboard.payload.disk, initial.disk);
    assert.deepEqual(dashboard.payload.result, {
        ok: false, action: 'restore',
        message: 'Restored 1 item(s) from uploaded-test.tar.gz, FAILED: 1. Safety backup: pre-restore-test.tar.gz. Reboot the GX device to apply Venus OS settings.',
        at: '2026-11-22T12:00:01.000Z',
        included: [], restored: ['data/conf/settings.xml'], failed: ['missing'], skipped: ['optional'], log: ['diagnostic']
    });
});
