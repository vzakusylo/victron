#!/usr/bin/env node
// Sends one plain-text email through an SMTP server with implicit TLS (port 465), using only Node's
// built-in modules (no nodemailer on the GX). Used by "Heat pump alerts" (47) through an exec node.
//
// Usage: echo '{"subject":"…","text":"…"}' | node /data/home/nodered/tools/send-mail.js
//        node /data/home/nodered/tools/send-mail.js --file /tmp/hp-alert-mail.json
//        node /data/home/nodered/tools/send-mail.js --check      (connect + login only, no mail)
// Settings: /data/home/nodered/grid-control-config/email.json (not in the repo, mode 600):
//   { "host": "smtp.gmail.com", "port": 465, "user": "<account>", "pass": "<app password>",
//     "from": "<account>", "to": "<recipient>" }
//   Gmail: "pass" is an App Password (Google account → Security → 2-Step Verification → App
//   passwords), not the account password.
// Output: one JSON line { ok: true } or { ok: false, error } — never the password.
'use strict';
const fs = require('fs');
const tls = require('tls');
const os = require('os');

const CFG = process.env.MAIL_CFG || '/data/home/nodered/grid-control-config/email.json';
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const check = process.argv.includes('--check');

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { out({ ok: false, error: 'no mail settings: ' + CFG }); process.exit(1); }
for (const k of ['host', 'user', 'pass', 'to']) if (!cfg[k]) { out({ ok: false, error: 'mail settings: "' + k + '" missing' }); process.exit(1); }

function readStdin() {
    return new Promise((resolve) => {
        if (check) return resolve('{}');
        const fi = process.argv.indexOf('--file');
        if (fi > 0 && process.argv[fi + 1]) { try { return resolve(fs.readFileSync(process.argv[fi + 1], 'utf8')); } catch (e) { return resolve('{}'); } }
        let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s));
    });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');

(async () => {
    const m = JSON.parse((await readStdin()) || '{}');
    const subject = String(m.subject || 'Heat pump alert');
    const text = String(m.text || '');
    const from = cfg.from || cfg.user;
    const to = String(m.to || cfg.to);

    const sock = tls.connect({ host: cfg.host, port: cfg.port || 465, servername: cfg.host });
    sock.setEncoding('utf8');
    sock.setTimeout(30000, () => { out({ ok: false, error: 'timeout' }); sock.destroy(); process.exit(1); });
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
        const body = [
            'From: Cerbo GX <' + from + '>',
            'To: ' + to,
            'Subject: ' + encHeader(subject),
            'Date: ' + new Date().toUTCString(),
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            b64(text).replace(/.{1,76}/g, '$&\r\n')
        ].join('\r\n');
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
