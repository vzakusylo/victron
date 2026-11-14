#!/usr/bin/env node
// Read-only health check of the live flow after a deploy. Runs ON THE GX (piped over SSH).
//
// Usage (PowerShell 7 on the PC, see docs/gx-deploy.md):
//   Get-Content -Raw tools\gx\verify.js | ssh <gx> "tr -d '\r' | node -"
//
// Prints: the d# tab label and the recorded source commits, the DHW state of the heat pump
// automations with the reason it is waiting, the master switch, the shower option, and the
// Node-RED log lines with "error" since the last deploy. No secrets are printed.
// After a deploy the automations wait until they have an outdoor average again: no samples are
// taken during a defrost and 15 minutes after it, so "no outdoor value yet" is normal for a while.
'use strict';
const fs = require('fs');
const http = require('http');

const LOG = '/var/log/node-red-venus/current';
const get = (urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 1880, path: urlPath, headers: { 'Node-RED-API-Version': 'v2' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
    }).on('error', reject);
});
const value = (reply) => { try { return JSON.parse(JSON.parse(reply).msg); } catch { return null; } };

(async () => {
    const live = JSON.parse(await get('/flows'));
    const tab = live.flows.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    const source = /<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/.exec(tab.info || '');
    console.log('label   : ' + tab.label);
    console.log('source  : ' + (source ? source[1] : 'not recorded'));
    console.log('rev     : ' + live.rev.slice(0, 12) + ', ' + live.flows.length + ' nodes');

    const dhw = value(await get('/context/node/hpa-fn-01/dhw'));
    console.log('dhw     : ' + (dhw ? JSON.stringify({ state: dhw.state, running: !!dhw.run, why: dhw.why, waitNote: dhw.waitNote, outdoorAvg: dhw.outAvg }) : 'no context'));
    const view = value(await get('/context/flow/' + tab.id + '/dhwView'));
    if (view) {
        console.log('view    : updated ' + Math.round((Date.now() - view.at) / 1000) + ' s ago, master ' + view.master + ', state ' + view.state);
        if (view.shower) console.log('shower  : ' + JSON.stringify({ enabled: view.shower.enabled, state: view.shower.state, motion: view.shower.motionValue }));
    } else console.log('view    : no dhwView in the flow context');

    const text = fs.readFileSync(LOG, 'utf8').split('\n');
    const lastDeploy = text.map((line, index) => (line.includes('Started modified nodes') || line.includes('Started flows') ? index : -1)).filter((index) => index >= 0).pop();
    const since = text.slice(lastDeploy === undefined ? 0 : lastDeploy).filter((line) => /\[error\]/.test(line));
    const groups = {};
    for (const line of since) {
        const key = (/\[error\] (\[[^\]]+\])/.exec(line) || [0, 'other'])[1];
        groups[key] = (groups[key] || 0) + 1;
    }
    console.log('log     : last deploy line ' + (lastDeploy === undefined ? 'not in the current log file' : '"' + text[lastDeploy].replace(/^\S+ /, '').slice(0, 60) + '"'));
    console.log('errors since then: ' + (since.length ? JSON.stringify(groups) : 'none'));
})().catch((error) => { console.error(error.message); process.exit(1); });
