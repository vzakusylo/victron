#!/usr/bin/env node
// Read-only health monitor of the heat pump automations on the GX. Runs ON THE GX.
//
// Usage (PowerShell 7 on the PC, see docs/gx-deploy.md; scripts/gx-monitor.ps1 wraps it):
//   Get-Content -Raw tools\gx\monitor.js | ssh <gx> "tr -d '\r' | node -"
//   ssh <gx> "node /data/home/nodered/tools/gx/monitor.js"          once a deploy has placed it there
//   ... "node - --json"                                              the collected data and the findings as JSON
//
// Prints one line per check (OK / INFO / WARN / FAIL) and `STATUS: OK | WARN | FAIL`.
// Exit code 0 = OK, 1 = WARN, 2 = FAIL, 3 = the monitor itself could not read the GX.
// WARN is something to look at; FAIL needs action (a device is gone, the pump reports a fault,
// DHW is blocked, the automations do not tick). It changes nothing and prints no secrets.
'use strict';

const MIN = 60 * 1000;
const LIMITS = {
    deviceStaleMin: 5,      // no data from the heat pump / valve / bypass for this long
    viewStaleMin: 2,        // the automations publish their view on every tick
    dhwCycleMaxMin: 150,    // a DHW cycle longer than this is stuck
    tankLowC: 38,           // hot water is running out
    logWindowMin: 30,       // Node-RED log errors newer than this
    eventWindowH: 24        // automation log events newer than this
};
const REQUIRED = ['hp', 'valve', 'bypass'];
// The SA1 power meter is on another network and has never connected (see the work log).
const KNOWN_NOISE = /SA1 power meter/;

function evaluate(input, limits) {
    const L = Object.assign({}, LIMITS, limits || {});
    const now = input.now;
    const out = [];
    const add = (level, check, text) => out.push({ level, check, text });
    const age = (t) => (t ? Math.round((now - t) / MIN) : null);
    // An SSH shell on the GX runs in UTC while Node-RED logs local time: say which clock this is.
    const clock = (t) => new Date(t).toISOString().slice(11, 16) + ' UTC';

    if (!input.service || !input.service.up) add('FAIL', 'service', 'Node-RED is not running');
    else add(input.service.seconds < 600 ? 'INFO' : 'OK', 'service', 'Node-RED up for ' + Math.round(input.service.seconds / 60) + ' min');

    const flow = input.flow || {};
    if (!flow.label) add('FAIL', 'version', 'no d# tab in the live flow');
    else add(flow.source ? 'OK' : 'WARN', 'version', flow.label + (flow.source ? '' : ' (source commit not recorded)'));

    const devices = input.devices || {};
    for (const role of REQUIRED) {
        const d = devices[role];
        if (!d) add('FAIL', 'device ' + role, 'no state');
        else if (d.state !== 'CONNECTED') add('FAIL', 'device ' + role, d.state);
        else if (!(age(d.lastData) <= L.deviceStaleMin)) add('FAIL', 'device ' + role, 'no data for ' + age(d.lastData) + ' min');
        else add('OK', 'device ' + role, 'connected, data ' + age(d.lastData) + ' min ago');
    }

    const hp = input.hp || {};
    if (hp.on !== true) add('WARN', 'heat pump', 'switched off');
    if (Number(hp.fault) !== 0 && hp.fault !== undefined && hp.fault !== null) add('FAIL', 'heat pump', 'fault code ' + hp.fault + ((Number(hp.fault) & 1) ? ' (Er03 water flow)' : ''));
    else if (hp.on === true) add('OK', 'heat pump', 'no fault, supply ' + hp.supply + ' / return ' + hp.ret + ' °C, ' + hp.hz + ' Hz, mode ' + hp.mode);
    if (Number.isFinite(hp.tank)) add(hp.tank < L.tankLowC ? 'WARN' : 'OK', 'tank', hp.tank + ' °C' + (hp.tank < L.tankLowC ? ' (below ' + L.tankLowC + ')' : ''));
    else add('WARN', 'tank', 'no temperature');

    const settings = input.settings || {};
    const modes = settings.modes || {};
    if (settings.master !== true) add('WARN', 'local control', 'master switch OFF: no rule writes to a device');
    else add('OK', 'local control', 'on');

    const view = input.view;
    if (!view || !(now - view.at <= L.viewStaleMin * MIN)) {
        add('FAIL', 'automations', view ? 'no tick for ' + age(view.at) + ' min' : 'no view in the flow context');
    } else add('OK', 'automations', 'ticking');

    const dhw = input.dhw;
    if (modes.dhw !== 'live') add('WARN', 'DHW', 'controller ' + (modes.dhw || 'not set') + ' (not On)');
    if (settings.dhwBlock) add('FAIL', 'DHW', 'blocked since ' + clock(settings.dhwBlock.at) + ': ' + settings.dhwBlock.why + ' - allow DHW again on the Heat Pump page');
    if (!dhw) add('WARN', 'DHW', 'no context (node just deployed?)');
    else if (dhw.state !== 'HEATING' && age(dhw.startAt || dhw.since) > L.dhwCycleMaxMin) add('FAIL', 'DHW', 'state ' + dhw.state + ' for ' + age(dhw.startAt || dhw.since) + ' min');
    else if (dhw.state !== 'HEATING') add('INFO', 'DHW', 'cycle running: ' + dhw.state + ', ' + (dhw.why || ''));
    else if (!settings.dhwBlock) add(dhw.outAvg === null || dhw.outAvg === undefined ? 'INFO' : 'OK', 'DHW', 'idle: ' + (dhw.why || 'no reason given'));

    const heat = view && view.heat;
    if (modes.heat !== 'live') add('WARN', 'heating', 'controller ' + (modes.heat || 'not set') + ' (not On)');
    else if (heat) add('OK', 'heating', (heat.pumpMode || '?') + (heat.boost ? ', curve +' + heat.boost + ' °C' : '') + ', target ' + heat.target + ' °C, lag ' + heat.lag + ': ' + (heat.why || ''));
    else add('WARN', 'heating', 'no heating model in the view');

    const noisy = (input.logErrors || []).filter((e) => !KNOWN_NOISE.test(e.source));
    const known = (input.logErrors || []).filter((e) => KNOWN_NOISE.test(e.source));
    if (noisy.length) add('WARN', 'Node-RED log', noisy.map((e) => e.count + ' x ' + e.source).join(', ') + ' in the last ' + L.logWindowMin + ' min');
    else add('OK', 'Node-RED log', 'no errors in the last ' + L.logWindowMin + ' min' + (known.length ? ' (known: ' + known.map((e) => e.count + ' x ' + e.source).join(', ') + ')' : ''));

    const events = input.events || [];
    const bad = events.filter((e) => e.kind === 'error' || e.kind === 'fail');
    const aborted = events.filter((e) => e.kind === 'stop' && e.rule === 'dhw');
    if (bad.length || aborted.length) {
        const last = bad.concat(aborted).sort((a, b) => a.t - b.t).pop();
        add('WARN', 'automation log', bad.length + ' error(s), ' + aborted.length + ' aborted DHW cycle(s) in ' + L.eventWindowH + ' h; last ' + clock(last.t) + ': ' + String(last.text).slice(0, 110));
    } else add('OK', 'automation log', 'no errors or aborted cycles in ' + L.eventWindowH + ' h');

    const rank = { OK: 0, INFO: 0, WARN: 1, FAIL: 2 };
    const worst = out.reduce((max, item) => Math.max(max, rank[item.level]), 0);
    return { status: ['OK', 'WARN', 'FAIL'][worst], exitCode: worst, checks: out };
}

function format(result) {
    return result.checks.map((c) => c.level.padEnd(5) + c.check.padEnd(16) + c.text).join('\n') + '\nSTATUS: ' + result.status;
}

module.exports = { evaluate, format, LIMITS };

// ---- collection on the GX (read-only) ----------------------------------------------
async function collect() {
    const fs = require('fs');
    const http = require('http');
    const { execFileSync } = require('child_process');
    const home = process.env.VICTRON_HOME || '/data/home/nodered';
    const get = (urlPath) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: 1880, path: urlPath, headers: { 'Node-RED-API-Version': 'v2' } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve(text));
        }).on('error', reject);
    });
    const value = (reply) => { try { return JSON.parse(JSON.parse(reply).msg); } catch { return null; } };
    const now = Date.now();
    const input = { now, service: { up: false, seconds: 0 } };
    try {
        const state = execFileSync('svstat', ['/service/node-red-venus'], { encoding: 'utf8' });
        const m = /: up \(pid \d+\) (\d+) seconds/.exec(state);
        if (m) input.service = { up: true, seconds: Number(m[1]) };
    } catch { /* reported as not running */ }
    if (!input.service.up) return input;

    const live = JSON.parse(await get('/flows'));
    const tab = live.flows.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    const source = tab && /<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/.exec(tab.info || '');
    input.flow = { label: tab && tab.label, source: source ? source[1] : null, rev: live.rev };
    const pump = value(await get('/context/flow/' + tab.id + '/heatPump')) || {};
    input.devices = {};
    for (const role of Object.keys(pump)) input.devices[role] = { state: pump[role] && pump[role].state, lastData: pump[role] && pump[role].lastData };
    const d = (pump.hp && pump.hp.dps) || {};
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    input.hp = { on: d['1'], mode: d['2'], fault: d['15'], ret: num(d['101']), supply: num(d['102']), outdoor: num(d['103']), tank: num(d['108']), hz: num(d['115']), fan: num(d['116']) };
    const dhw = value(await get('/context/node/hpa-fn-01/dhw'));
    input.dhw = dhw && { state: dhw.state, since: dhw.since, startAt: dhw.startAt, why: dhw.why, outAvg: dhw.outAvg, running: !!dhw.run };
    const settings = value(await get('/context/node/hpa-fn-01/settings')) || {};
    input.settings = { master: settings.master, modes: settings.modes, dhwBlock: settings.dhwBlock || null };
    const view = value(await get('/context/flow/' + tab.id + '/dhwView'));
    input.view = view && { at: view.at, heat: view.heat, shower: view.shower && { enabled: view.shower.enabled, state: view.shower.state } };

    // Node-RED log: multilog lines "@<tai64> 14 Nov 18:56:15 - [error] [type:name] text"
    input.logErrors = [];
    try {
        const groups = {};
        const year = new Date(now).getFullYear();
        for (const line of fs.readFileSync('/var/log/node-red-venus/current', 'utf8').split('\n')) {
            const m = /^\S+ (\d+ \w+ \d\d:\d\d:\d\d) - \[error\] (\[[^\]]+\])?/.exec(line);
            if (!m) continue;
            const at = Date.parse(m[1] + ' ' + year);
            if (Number.isFinite(at) && now - at > LIMITS.logWindowMin * MIN) continue;
            const key = m[2] || 'other';
            groups[key] = (groups[key] || 0) + 1;
        }
        input.logErrors = Object.keys(groups).map((source) => ({ source, count: groups[source] }));
    } catch { /* no log file: nothing to report */ }

    // Automation log: one JSON object per line, one file per day.
    input.events = [];
    for (const offset of [1, 0]) {
        const day = new Date(now - offset * 24 * 60 * MIN);
        const name = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0') + '.jsonl';
        let text;
        try { text = fs.readFileSync(home + '/grid-control-logs/automations/' + name, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (now - row.t > LIMITS.eventWindowH * 60 * MIN) continue;
            if (row.kind === 'error' || row.kind === 'fail' || (row.kind === 'stop' && row.rule === 'dhw')) input.events.push({ t: row.t, kind: row.kind, rule: row.rule, text: row.text });
        }
    }
    return input;
}

// Piped to `node -` there is no main module.
if (!require.main || require.main === module) {
    collect().then((input) => {
        const result = evaluate(input);
        if (process.argv.includes('--json')) console.log(JSON.stringify({ input, result }));
        else console.log(format(result));
        process.exitCode = result.exitCode;
    }).catch((error) => { console.error('MONITOR ERROR: ' + error.message); process.exitCode = 3; });
}
