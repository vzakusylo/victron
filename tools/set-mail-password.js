#!/usr/bin/env node
// Asks for the SMTP (Gmail app) password and stores it in grid-control-config/email.json on the GX
// (mode 600, owner nodered). Run it interactively, the password is not shown:
//   ssh -t root@<gx> node /data/home/nodered/tools/set-mail-password.js
// Then test: node /data/home/nodered/tools/send-mail.js --check
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const F = '/data/home/nodered/grid-control-config/email.json';

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) { cfg = { host: 'smtp.gmail.com', port: 465 }; }
process.stdout.write('Mail account: ' + (cfg.user || '?') + ' → ' + (cfg.to || '?') + '\nApp password (16 letters, spaces are ignored): ');
const stdin = process.stdin;
if (stdin.isTTY) stdin.setRawMode(true);
let pw = '';
stdin.setEncoding('utf8');
stdin.on('data', (ch) => {
    for (const c of ch) {
        if (c === '\r' || c === '\n') {
            if (stdin.isTTY) stdin.setRawMode(false);
            process.stdout.write('\n');
            cfg.pass = pw.replace(/\s+/g, '');
            if (!cfg.pass) { console.log('nothing stored'); process.exit(1); }
            fs.writeFileSync(F, JSON.stringify(cfg, null, 1) + '\n', { mode: 0o600 });
            try { execSync('chown nodered:nodered ' + F + ' && chmod 600 ' + F); } catch (e) { /* not root */ }
            console.log('stored in ' + F + ' (' + cfg.pass.length + ' characters)');
            process.exit(0);
        } else if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        else if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);
        else pw += c;
    }
});
