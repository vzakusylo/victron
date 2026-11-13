#!/usr/bin/env node
// Sends one email through an SMTP server with implicit TLS (port 465), using only Node's built-in
// modules (no nodemailer on the GX). Used by "Heat pump alerts" (47) and by the data-archive mail of
// "Manage backup dashboard" (26) through exec nodes.
//
// Usage: echo '{"subject":"…","text":"…"}' | node /data/home/nodered/tools/send-mail.js
//        node /data/home/nodered/tools/send-mail.js --file /tmp/hp-alert-mail.json
//        node /data/home/nodered/tools/send-mail.js --file mail.json --attach /tmp/data.tar.gz [--attach …]
//        node /data/home/nodered/tools/send-mail.js --check      (connect + login only, no mail)
//        node /data/home/nodered/tools/send-mail.js --dry-run …  (print the message, do not connect)
// Settings: /data/home/nodered/grid-control-config/email.json (not in the repo, mode 600):
//   { "host": "smtp.gmail.com", "port": 465, "user": "<account>", "pass": "<app password>",
//     "from": "<account>", "to": "<recipient>" }
//   Gmail: "pass" is an App Password (Google account → Security → 2-Step Verification → App
//   passwords), not the account password.
// Attachments: base64 parts of a multipart/mixed message, at most MAX_ATTACH bytes in total
// (Gmail accepts 25 MB per message after base64 encoding).
// Output: one JSON line { ok: true } or { ok: false, error } — never the password.
'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const os = require('os');

const CFG = process.env.MAIL_CFG || '/data/home/nodered/grid-control-config/email.json';
const MAX_ATTACH = 18 * 1024 * 1024;
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const dry = argv.includes('--dry-run');
const argValues = (name) => argv.reduce((list, a, i) => (a === name && argv[i + 1] ? list.concat(argv[i + 1]) : list), []);

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) {
    if (!dry) { out({ ok: false, error: 'no mail settings: ' + CFG }); process.exit(1); }
    cfg = { host: 'dry-run', user: 'gx@example.invalid', pass: '-', to: 'owner@example.invalid' };
}
for (const k of ['host', 'user', 'pass', 'to']) if (!cfg[k]) { out({ ok: false, error: 'mail settings: "' + k + '" missing' }); process.exit(1); }

function readInput() {
    return new Promise((resolve) => {
        if (check) return resolve('{}');
        const file = argValues('--file')[0];
        if (file) { try { return resolve(fs.readFileSync(file, 'utf8')); } catch (e) { return resolve('{}'); } }
        let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s));
    });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');
const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
const MIME = { '.gz': 'application/gzip', '.tgz': 'application/gzip', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain' };

function buildMessage(m, from, to) {
    const subject = String(m.subject || 'Heat pump alert');
    let text = String(m.text || '');
    const files = argValues('--attach');
    const head = [
        'From: Cerbo GX <' + from + '>',
        'To: ' + to,
        'Subject: ' + encHeader(subject),
        'Date: ' + new Date().toUTCString(),
        'MIME-Version: 1.0'
    ];
    if (!files.length) {
        return head.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(text))]).join('\r\n');
    }
    const parts = files.map((f) => {
        const data = fs.readFileSync(f); // throws for a missing file -> { ok: false }
        return { name: path.basename(f).replace(/[^A-Za-z0-9._-]/g, '_'), data };
    });
    const total = parts.reduce((s, p) => s + p.data.length, 0);
    if (total > MAX_ATTACH) throw new Error('attachments too large: ' + sizeText(total) + ' (max ' + sizeText(MAX_ATTACH) + ')');
    text += '\n\nAttached: ' + parts.map((p) => p.name + ' (' + sizeText(p.data.length) + ')').join(', ') + '\n';
    const boundary = 'gx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const lines = head.concat(['Content-Type: multipart/mixed; boundary="' + boundary + '"', '',
        '--' + boundary, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(text))]);
    for (const p of parts) {
        lines.push('--' + boundary,
            'Content-Type: ' + (MIME[path.extname(p.name).toLowerCase()] || 'application/octet-stream') + '; name="' + p.name + '"',
            'Content-Disposition: attachment; filename="' + p.name + '"',
            'Content-Transfer-Encoding: base64', '', wrap(p.data.toString('base64')));
    }
    lines.push('--' + boundary + '--', '');
    return lines.join('\r\n');
}

(async () => {
    const m = JSON.parse((await readInput()) || '{}');
    const from = cfg.from || cfg.user;
    const to = String(m.to || cfg.to);
    let body;
    if (!check) {
        try { body = buildMessage(m, from, to); } catch (e) { out({ ok: false, error: e.message }); process.exit(1); }
        if (dry) { process.stdout.write(body + '\n'); out({ ok: true, dryRun: true, bytes: body.length }); return; }
    }

    const sock = tls.connect({ host: cfg.host, port: cfg.port || 465, servername: cfg.host });
    sock.setEncoding('utf8');
    sock.setTimeout(120000, () => { out({ ok: false, error: 'timeout' }); sock.destroy(); process.exit(1); });
    sock.on('error', (e) => { out({ ok: false, error: e.message }); process.exit(1); });

    let buf = '';
    const waiters = [];
    sock.on('data', (d) => {
        buf += d;
        // a full reply ends with a line "NNN text" (no dash after the code)
        let m2;
        while ((m2 = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/))) {
            buf = buf.slice(m2[0].length);
            const w = waiters.shift(); if (w) w({ code: Number(m2[1]), text: m2[0].trim() });
        }
    });
    const reply = () => new Promise((resolve) => waiters.push(resolve));
    const cmd = async (line, ok, label) => {
        if (line !== null) sock.write(line + '\r\n');
        const r = await reply();
        if (!ok.includes(r.code)) throw new Error((label || line.split(' ')[0]) + ' → ' + r.text.split('\n').pop());
        return r;
    };
    try {
        await cmd(null, [220], 'greeting');
        await cmd('EHLO ' + (os.hostname() || 'cerbo-gx'), [250]);
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(cfg.user), [334], 'AUTH user');
        await cmd(b64(cfg.pass), [235], 'AUTH password');
        if (check) { await cmd('QUIT', [221]); sock.end(); out({ ok: true, check: true }); return; }
        await cmd('MAIL FROM:<' + from + '>', [250]);
        for (const r of to.split(',').map((x) => x.trim()).filter(Boolean)) await cmd('RCPT TO:<' + r + '>', [250, 251]);
        await cmd('DATA', [354]);
        // no line of the body starts with "." (base64 and headers), so no dot-stuffing is needed
        sock.write(body + '\r\n.\r\n');
        await cmd(null, [250], 'message');
        await cmd('QUIT', [221]);
        sock.end();
        out({ ok: true });
    } catch (e) {
        out({ ok: false, error: e.message });
        sock.destroy();
        process.exit(1);
    }
})();
