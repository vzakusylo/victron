'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DIR = '/data/home/root/.ssh';
const TAG = 'camera-ai@omarchy';
const FORCE = 'restrict,command="/data/home/nodered/tools/camera-mail-gate.js"';
const ED25519_PREFIX = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');

function publicKey(blob) {
    if (typeof blob !== 'string' || !/^[A-Za-z0-9+/]{68}$/.test(blob)) throw new Error('Invalid public-key encoding.');
    const raw = Buffer.from(blob, 'base64');
    if (!raw.subarray(0, ED25519_PREFIX.length).equals(ED25519_PREFIX)) throw new Error('Invalid OpenSSH Ed25519 public-key blob.');
    const fingerprint = 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
    return { blob, fingerprint, line: `${FORCE} ssh-ed25519 ${blob} ${TAG}` };
}

function entries(contents, key) {
    return contents.match(/[^\n]*\n|[^\n]+$/g)?.map(raw => {
        const line = raw.replace(/\r?\n$/, '');
        // The key may follow one options field containing quoted spaces and escaped quotes.
        if (/^[ \t]*#/.test(line)) return { raw };
        const parsed = /^[ \t]*(?:(?:[^ \t"\\]|\\.|"(?:[^"\\]|\\.)*")+[ \t]+)?ssh-ed25519[ \t]+([A-Za-z0-9+/=]+)(?:[ \t]+(.*))?$/.exec(line);
        const tagged = /(?:^|[ \t])camera-ai@omarchy[ \t]*$/.test(line);
        const sameKey = parsed?.[1] === key.blob ||
            (!parsed && line.split(/[ \t]+/).includes(key.blob));
        const target = parsed?.[1] === key.blob && parsed?.[2]?.trim() === TAG;
        return { raw, tagged, sameKey, target, exact: line === key.line };
    }) || [];
}

function inspect(contents, key) {
    const relevant = entries(contents, key).filter(e => e.tagged || e.sameKey);
    return { relevant, nonAscii: /[^\x00-\x7f]/.test(contents) };
}

function edit(contents, key, mode) {
    const state = inspect(contents, key);
    if (mode === 'add') {
        if (state.relevant.length === 1 && state.relevant[0].exact) return contents;
        if (state.relevant.length) throw new Error('Camera key or label already present with different options, identity, or duplicates; inspect before adding.');
        if (state.nonAscii) throw new Error('authorized_keys contains non-ASCII bytes; inspect before adding.');
        return contents + (contents && !contents.endsWith('\n') ? '\n' : '') + key.line + '\n';
    }
    if (mode === 'remove') {
        if (state.relevant.some(e => !e.target)) throw new Error('An ambiguous camera key or label remains; inspect before removing.');
        return entries(contents, key).filter(e => !e.target).map(e => e.raw).join('');
    }
    throw new Error('Unknown edit mode.');
}

function plain(file, type) {
    const stat = fs.lstatSync(file);
    if (!stat[type]() || stat.uid !== process.getuid()) throw new Error(`Not an administrator-owned ${type === 'isFile' ? 'file' : 'directory'}: ${file}`);
    return stat;
}

function read(dir, file) {
    const dirMode = plain(dir, 'isDirectory').mode & 0o7777;
    plain(file, 'isFile');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid() || st.size > 1024 * 1024) throw new Error('Unexpected authorized_keys file type, owner, or size.');
        return { contents: fs.readFileSync(fd, 'latin1'), dirMode, fileMode: st.mode & 0o7777 };
    } finally { fs.closeSync(fd); }
}

function report(file, state, key, absent) {
    const { relevant, nonAscii } = inspect(state.contents, key);
    const check = (ok, text) => { console.log(`${ok ? 'OK' : 'FAIL'} ${text}`); return ok; };
    console.log(`OK authorized_keys path: ${file}`);
    console.log(`OK expected public-key fingerprint: ${key.fingerprint}`);
    return [
        check(state.dirMode === 0o700, `.ssh permissions: ${state.dirMode.toString(8)} (expected 700)`),
        check(state.fileMode === 0o600, `authorized_keys permissions: ${state.fileMode.toString(8)} (expected 600)`),
        check(!nonAscii, nonAscii ? 'non-ASCII bytes present in authorized_keys' : 'authorized_keys is ASCII'),
        check(relevant.length < 2, `camera key/label matches: ${relevant.length} (duplicates: ${Math.max(0, relevant.length - 1)})`),
        check(absent ? relevant.length === 0 : relevant.length === 1 && relevant[0].exact,
            absent ? `camera key ${relevant.length ? 'still present' : 'absent'}` :
                `camera restricted line ${relevant.some(e => e.exact) ? 'present' : 'missing or not exact'}`)
    ].every(Boolean);
}

function run(mode, blob, dir = DIR) {
    if (!['check', 'add', 'remove'].includes(mode)) throw new Error('Unknown camera key action.');
    const key = publicKey(blob);
    const file = path.join(dir, 'authorized_keys');
    if (mode === 'check') return report(file, read(dir, file), key, false);

    plain(dir, 'isDirectory');
    const lock = path.join(dir, '.camera-key.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    const tmp = path.join(lock, 'authorized_keys');
    try {
        const before = read(dir, file);
        const next = edit(before.contents, key, mode);
        if (next !== before.contents) {
            if (before.dirMode !== 0o700) throw new Error('.ssh mode must be 700 before editing.');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backup = `${file}.camera-${stamp}-${randomUUID()}.bak`;
            fs.writeFileSync(backup, before.contents, { encoding: 'latin1', mode: 0o600, flag: 'wx' });
            console.log(`OK backup: ${backup}`);
            fs.writeFileSync(tmp, next, { encoding: 'latin1', mode: 0o600, flag: 'wx' });
            fs.chmodSync(tmp, 0o600);
            if (read(dir, file).contents !== before.contents) throw new Error('authorized_keys changed during the operation; retry after checking.');
            fs.renameSync(tmp, file);
            console.log(`OK camera key ${mode === 'add' ? 'added' : 'removed'}`);
        } else {
            console.log('OK no change; no backup needed');
        }
        return report(file, read(dir, file), key, mode === 'remove');
    } finally {
        fs.rmSync(tmp, { force: true });
        fs.rmdirSync(lock);
    }
}

module.exports = { publicKey, inspect, edit, run };

if (require.main === module || process.argv[1] === '-') {
    try {
        if (process.getuid() !== 0) throw new Error('Run over the GX root administrator SSH connection.');
        process.exitCode = run(process.argv[2], process.argv[3]) ? 0 : 1;
    } catch (error) {
        console.log('FAIL ' + error.message);
        process.exitCode = 1;
    }
}
