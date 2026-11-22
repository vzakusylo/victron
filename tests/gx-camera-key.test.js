'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publicKey, inspect, edit, run } = require('../tools/gx/camera-key');

const root = path.join(__dirname, '..');
const pub = fs.readFileSync(path.join(root, 'config', 'camera-ai.pub'), 'utf8').trim();
const blob = pub.split(' ')[1];
const key = publicKey(blob);
const other = Buffer.from(blob, 'base64');
other[50] ^= 1;
const otherBlob = other.toString('base64');

test('builds the exact mail-only line and derives the OpenSSH fingerprint', () => {
    assert.equal(key.line, `restrict,command="/data/home/nodered/tools/camera-mail-gate.js" ${pub}`);
    assert.equal(key.fingerprint, 'SHA256:91Mhj59t2c4XPqr/JElreNI8gCCSUMkU8qatAHJiPis');
    for (const invalid of ['', blob + ';', blob + '\n', 'A'.repeat(68), blob.slice(1)]) {
        assert.throws(() => publicKey(invalid), /Invalid/);
    }
});

test('add and remove are idempotent and preserve unrelated bytes and comments', () => {
    const original = `# ${pub}\r\ncommand="echo unrelated" ssh-ed25519 ${otherBlob} admin\r\n\n`;
    const added = edit(original, key, 'add');
    assert.equal(added, original + key.line + '\n');
    assert.equal(edit(added, key, 'add'), added);
    assert.equal(edit(added, key, 'remove'), original);
    assert.equal(edit(original, key, 'remove'), original);
    assert.equal(edit('# existing', key, 'add'), `# existing\n${key.line}\n`);
});

test('duplicates, unrestricted or relabelled keys, rotation collisions and non-ASCII are detected', () => {
    const duplicates = `${key.line}\n${pub}\n`;
    assert.equal(inspect(duplicates, key).relevant.length, 2);
    assert.throws(() => edit(duplicates, key, 'add'), /already present/);
    assert.equal(edit(duplicates, key, 'remove'), '');
    const otherLabel = `command="echo \\"quoted\\" argument" ssh-ed25519 ${blob} another-label\n`;
    assert.throws(() => edit(otherLabel, key, 'add'), /already present/);
    assert.throws(() => edit(otherLabel, key, 'remove'), /ambiguous/);
    const replacement = `ssh-ed25519 ${otherBlob} camera-ai@omarchy\n`;
    assert.throws(() => edit(replacement, key, 'add'), /already present/);
    assert.throws(() => edit(replacement, key, 'remove'), /ambiguous/);
    assert.throws(() => edit('# non-ASCII: \u201c', key, 'add'), /non-ASCII/);
});

test('filesystem changes back up previous bytes, enforce 600, and skip backups on a no-op',
    { skip: process.platform === 'win32' }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-camera-key-'));
        try {
            const file = path.join(dir, 'authorized_keys');
            const original = `ssh-ed25519 ${otherBlob} another-key\n`;
            fs.writeFileSync(file, original, { mode: 0o644 });
            const backups = () => fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
            assert.equal(run('check', blob, dir), false);
            assert.deepEqual(backups(), []);
            assert.equal(run('add', blob, dir), true);
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            assert.equal(fs.readFileSync(path.join(dir, backups()[0]), 'utf8'), original);
            assert.equal(run('add', blob, dir), true);
            assert.equal(backups().length, 1);
            assert.equal(run('remove', blob, dir), true);
            assert.equal(fs.readFileSync(file, 'utf8'), original);
            assert.equal(run('remove', blob, dir), true);
            assert.equal(backups().length, 2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
