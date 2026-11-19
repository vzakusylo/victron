'use strict';
// The backup must carry everything a restored GX needs to start and to be checked / deployed again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
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

const LOGS = 'grid-control-logs/';
const MIB = 1024 * 1024;
const NOW = '2026-07-12T22:30:00Z'; // Monday 00:30 in Oslo
const backupNode = '26 Manage backup dashboard.js';
const action = (action, days) => ({ topic: 'backup-command', payload: { action, days } });

function runArchive(t, entries, command, now = NOW) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mail-test-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    for (const [file, content] of Object.entries(entries)) {
        const target = path.join(root, 'data', 'home', 'nodered', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof content === 'number' ? randomBytes(content * MIB) : content);
    }
    const home = path.join(root, 'data', 'home', 'nodered');
    const mailing = command.topic === 'backup-mail-tick' || command.payload?.action === 'mail';
    if (mailing) {
        const orphan = path.join(home, 'grid-data-mail.orphan');
        fs.mkdirSync(orphan, { recursive: true });
        fs.writeFileSync(path.join(orphan, 'mail.json'), '{}');
        fs.writeFileSync(path.join(home, 'grid-data-old.tar.gz'), 'stale');
    }
    fs.writeFileSync(path.join(home, 'fake-mail.js'), `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [, , , mail, , archive] = process.argv;
fs.writeFileSync('sent.json', JSON.stringify({
    mail: JSON.parse(fs.readFileSync(mail, 'utf8')),
    size: fs.statSync(archive).size,
    entries: execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\\r?\\n/)
}));
console.log('{"ok":true}');
`);
    const node = loadNode(backupNode);
    if (command.topic === 'backup-mail-tick') {
        node.run(command, { now: '2026-07-12T22:00:00Z' });
    }
    const message = node.run(command, { now }).result[1];
    assert.ok(message);
    const script = message.payload.slice(1, -1).replaceAll("'\\''", "'")
        .replace('R=""', 'R="$PWD"')
        .replace('cd "/data/home/nodered"', 'cd "./data/home/nodered"')
        .replaceAll('/tmp/grid-data-', './grid-data-')
        .replace('/data/home/nodered/tools/send-mail.js', './fake-mail.js');
    assert.ok(!script.includes('/tmp/grid-data-') && !script.includes('node /data/home/nodered/'));
    if (mailing) assert.match(script, /trap 'exit 1' HUP INT TERM/);
    const windows = process.platform === 'win32';
    const shell = spawnSync(windows ? 'wsl.exe' : 'sh', windows ? ['-e', 'sh', '-s'] : ['-s'], {
        cwd: root, input: (windows ? 'node() { node.exe "$@"; }\n' : '') +
            'tar() { if [ "$1" = -czf ]; then echo "@@TEST_PACK"; fi; command tar "$@"; }\n' + script,
        encoding: 'utf8', timeout: 60000
    });
    assert.ifError(shell.error);
    assert.equal(shell.status, 0, shell.stderr);
    const sentFile = path.join(home, 'sent.json');
    const sent = fs.existsSync(sentFile) ? JSON.parse(fs.readFileSync(sentFile, 'utf8')) : null;
    assert.ok(!fs.readdirSync(home).some(file => file.startsWith('grid-data-')), 'staged archives and mail are cleaned up');
    return { sent, stdout: shell.stdout, packs: (shell.stdout.match(/@@TEST_PACK/g) || []).length, message, root };
}

for (const mode of [7, 31, 'weekly']) {
    test('26: ' + mode + ' mail takes core, air and events from UTC dates, temperatures from Oslo dates', t => {
        const weekly = mode === 'weekly';
        const now = weekly ? '2026-07-13T05:00:00Z' : '2026-07-12T23:30:00Z';
        const utc = weekly ? '2026-07-13' : '2026-07-12';
        const oslo = '2026-07-13';
        const firstUtc = mode === 31 ? '2026-06-11' : weekly ? '2026-07-06' : '2026-07-05';
        const firstOslo = mode === 31 ? '2026-06-12' : '2026-07-06';
        const expected = [...new Set([
            'heatpump/' + utc + '/00.csv', 'automations/' + utc + '.jsonl', 'energy-2026-07.csv',
            'energy-' + firstUtc + '.log', 'air/' + firstUtc + '.csv', 'air/' + utc + '.csv',
            'temperatures/' + firstOslo + '.jsonl', 'temperatures/' + oslo + '.jsonl', 'temperatures/catalog.json',
            'sensor-events/' + firstUtc + '.jsonl', 'sensor-events/' + utc + '.jsonl'
        ])];
        if (mode === 31) expected.push('energy-2026-06.csv');
        const outOfRange = [
            'air/2026-07-14.csv', 'grid-control-2026-07-14.log', 'sensor-events/2026-07-14.jsonl',
            'air/2026-06-10.csv', 'temperatures/2026-06-11.jsonl', 'sensor-events/2026-06-10.jsonl'
        ];
        if (!weekly) outOfRange.push('air/' + oslo + '.csv', 'energy-' + oslo + '.log',
            'temperatures/' + firstUtc + '.jsonl', 'sensor-events/' + oslo + '.jsonl');
        const files = Object.fromEntries([...expected, ...outOfRange].map(file => [LOGS + file, 'synthetic']));
        files['grid-control-config/email.json'] = 'synthetic config';
        const { sent, stdout, message } = runArchive(t, files,
            weekly ? { topic: 'backup-mail-tick' } : action('mail', mode), now);
        assert.equal(message.mailAuto, weekly);
        assert.equal(message.mailDays, weekly ? 7 : mode);
        assert.match(stdout, /@@MAIL \{"ok":true\}/);
        assert.deepEqual(sent.entries.filter(file => !file.endsWith('/')).sort(), expected.map(file => LOGS + file).sort());
        assert.doesNotMatch(sent.mail.text, /Left out/);
    });
}

test('26: dated mail trims largest files first and goes through events, temperatures, then air', t => {
    const files = {
        'energy-2026-07.csv': 13,
        'sensor-events/2026-07-11.jsonl': 1,
        'sensor-events/2026-07-12.jsonl': 2,
        'temperatures/2026-07-11.jsonl': 1,
        'temperatures/2026-07-12.jsonl': 2,
        'temperatures/catalog.json': '{}',
        'air/2026-07-11.csv': 2,
        'air/2026-07-12.csv': 5
    };
    const { sent, packs } = runArchive(t, Object.fromEntries(Object.entries(files).map(([k, v]) => [LOGS + k, v])), action('mail', 7));
    assert.equal(packs, 5, 'core and full archive, then one repack per trimmed set');
    assert.ok(sent.size <= 18 * MIB);
    assert.deepEqual(sent.entries, [LOGS + 'energy-2026-07.csv', LOGS + 'air/2026-07-11.csv']);
    assert.deepEqual(sent.mail.text.split('\n\nLeft out')[1].split('\n- ').slice(1), [
        'sensor-events/2026-07-12.jsonl', 'sensor-events/2026-07-11.jsonl',
        'temperatures/2026-07-12.jsonl', 'temperatures/2026-07-11.jsonl', 'temperatures/catalog.json',
        'air/2026-07-12.csv'
    ]);
});

test('26: dated mail stops pruning as soon as the archive fits, retaining the shared catalogue', t => {
    const { sent } = runArchive(t, {
        [LOGS + 'energy-2026-07.csv']: 12,
        [LOGS + 'temperatures/2026-07-13.jsonl']: 5,
        [LOGS + 'temperatures/2026-07-12.jsonl']: 1,
        [LOGS + 'temperatures/catalog.json']: '{}',
        [LOGS + 'air/2026-07-12.csv']: 1
    }, action('mail', 31));
    assert.ok(sent.size <= 18 * MIB);
    assert.ok(sent.entries.includes(LOGS + 'temperatures/2026-07-12.jsonl'));
    assert.ok(sent.entries.includes(LOGS + 'temperatures/catalog.json'));
    assert.match(sent.mail.text, /Left out.*\n- temperatures\/2026-07-13\.jsonl$/);
});

test('26: dated mail refuses oversized core, even with optional files', t => {
    const { sent, stdout } = runArchive(t, {
        [LOGS + 'energy-2026-07.csv']: 19, [LOGS + 'air/2026-07-12.csv']: 1
    }, action('mail', 7));
    assert.equal(sent, null);
    assert.match(stdout, /@@ERROR Core data alone is too large.*max 18 MiB/);
});

test('26: all-history mail still refuses an oversized archive without removing optional logs', t => {
    const { sent, stdout } = runArchive(t, { [LOGS + 'sensor-events/1999-01-01.jsonl']: 19 }, action('mail', 0));
    assert.equal(sent, null);
    assert.match(stdout, /@@ERROR Data archive is too large for e-mail/);
});

test('26: all-history mail still packs all logs while full backup includes config', t => {
    const files = {
        [LOGS + 'sensor-events/1999-01-01.jsonl']: 'old log',
        [LOGS + 'other.log']: 'not a dated selection',
        'grid-control-config/settings.json': 'synthetic config'
    };
    const all = runArchive(t, files, action('mail', 0));
    assert.deepEqual(all.sent.entries.filter(file => !file.endsWith('/')).sort(),
        [LOGS + 'other.log', LOGS + 'sensor-events/1999-01-01.jsonl']);
    assert.doesNotMatch(all.sent.mail.text, /Left out/);
    const full = runArchive(t, files, action('create'));
    const dir = path.join(full.root, 'data', 'home', 'nodered', 'grid-control-backups');
    const [backup] = fs.readdirSync(dir).filter(name => name.endsWith('.tar.gz'));
    const listing = spawnSync('tar', ['-tzf', path.join(dir, backup)], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    for (const file of Object.keys(files)) assert.ok(listing.stdout.includes('data/home/nodered/' + file));
    assert.equal(full.sent, null);
});
