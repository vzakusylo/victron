#!/usr/bin/env node
// Read-only: is this a safe moment to redeploy the automations or to stop Node-RED? Runs ON THE GX.
//
// Usage (PowerShell 7 on the PC; the runners in scripts/ call it):
//   Get-Content -Raw tools\gx\window.js,tools\gx\admin-api.js | ssh <gx> "tr -d '\r' | node -"
//   ssh <gx> "node /data/home/nodered/tools/gx/window.js --for stop --margin 8"
//   ... --json                                   the values and the verdict as JSON
//
// --for deploy (default)  a redeploy of nodes: the automations node may lose its context
// --for stop              Node-RED will be down for some minutes: also no defrost may be due,
//                         because the "DF exchange" rules that switch the bypass do not run then
// --margin <min>          with --for stop: minutes that must be free before the next expected defrost (default 8)
//
// Prints `SAFE` or `WAIT` with every reason, exit code 0 = safe, 1 = wait, 3 = the GX could not be read.
// This is the check made by hand before the d#180 / d#181 deploys and the secret install of 15 Nov 2026.
'use strict';

const MIN = 60 * 1000;

// Median distance between the recorded defrost starts of the last hours (the automations keep them in settings).
function defrostIntervalMin(starts) {
    const sorted = (starts || []).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i] - sorted[i - 1]) / MIN;
        if (gap >= 15 && gap <= 180) gaps.push(gap);
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

function judge(input, options) {
    const opt = Object.assign({ purpose: 'deploy', marginMin: 8, overdueMin: 20, staleMin: 2 }, options || {});
    const now = input.now;
    const wait = [];
    const dhw = input.dhw;
    if (!input.view || !(now - input.view.at <= opt.staleMin * MIN)) wait.push('the automations are not ticking (no fresh view): their state is unknown');
    if (!dhw || typeof dhw.state !== 'string') wait.push('no DHW state');
    else if (dhw.state !== 'HEATING' || dhw.run) wait.push('a DHW cycle is running (' + dhw.state + ')');
    const running = Object.keys(input.sequences || {});
    if (running.length) wait.push('a rule sequence is running: ' + running.join(', '));
    if ((input.queue || []).length) wait.push(input.queue.length + ' device write(s) still queued');
    if (input.flag && input.flag.on) wait.push('the defrost flag is ON');
    const hp = input.hp || {};
    const defrostNow = Number(hp.fan) === 0 && Number(hp.hz) > 30;
    if (defrostNow) wait.push('a defrost is running (fan 0, compressor ' + hp.hz + ' Hz)');
    if (input.valve !== false) wait.push('the 3-way valve is not on heating (' + input.valve + ')');
    if (input.bypass !== false) wait.push('the bypass is not OFF (' + input.bypass + ')');
    if (Number(hp.fault) !== 0) wait.push('the heat pump reports fault code ' + hp.fault);

    const interval = defrostIntervalMin(input.defrostStarts);
    const lastStart = Math.max(0, ...(input.defrostStarts || []).filter(Number.isFinite));
    const sinceLast = lastStart ? Math.round((now - lastStart) / MIN) : null;
    const nextIn = interval !== null && sinceLast !== null ? interval - sinceLast : null;
    // Overdue by more than overdueMin: the estimate no longer holds (it got warmer), so it stops blocking.
    if (opt.purpose === 'stop' && nextIn !== null && nextIn < opt.marginMin && nextIn > -opt.overdueMin) {
        wait.push('the next defrost is ' + (nextIn >= 0 ? 'expected in ' + nextIn + ' min' : 'overdue by ' + -nextIn + ' min')
            + ' (every ~' + interval + ' min, last start ' + sinceLast + ' min ago); needs ' + opt.marginMin + ' free minutes');
    }
    return { safe: wait.length === 0, purpose: opt.purpose, wait, defrost: { intervalMin: interval, lastStartMinAgo: sinceLast, nextInMin: nextIn } };
}

function format(result) {
    const d = result.defrost;
    const defrost = d.intervalMin === null ? 'no defrost recorded in the last hours'
        : 'defrost every ~' + d.intervalMin + ' min, last start ' + d.lastStartMinAgo + ' min ago, next ' + (d.nextInMin >= 0 ? 'in ~' + d.nextInMin + ' min' : 'overdue by ' + -d.nextInMin + ' min');
    return (result.safe ? 'SAFE' : 'WAIT') + ' for ' + result.purpose + ' (' + defrost + ')'
        + result.wait.map((reason) => '\n  - ' + reason).join('');
}

module.exports = { judge, format, defrostIntervalMin };

async function collect(options) {
    const opt = options || {};
    const api = (typeof createAdminApi === 'function' ? createAdminApi : require('./admin-api.js'))({ port: opt.port });
    const get = (urlPath) => api('GET', urlPath);
    const value = (reply) => { try { return JSON.parse(JSON.parse(reply).msg); } catch { return null; } };
    const live = JSON.parse(await get('/flows'));
    const tab = live.flows.find((node) => node.type === 'tab' && /d#\d+/.test(node.label || ''));
    if (!tab) throw new Error('No d# tab in the live flow.');
    const node = (key) => get('/context/node/hpa-fn-01/' + key).then(value);
    const pump = value(await get('/context/flow/' + tab.id + '/heatPump')) || {};
    const dps = (role) => (pump[role] && pump[role].dps) || {};
    const settings = (await node('settings')) || {};
    const view = value(await get('/context/flow/' + tab.id + '/dhwView'));
    const dhw = await node('dhw');
    return {
        now: opt.now || Date.now(),
        view: view && { at: view.at },
        dhw: dhw && { state: dhw.state, run: !!dhw.run },
        sequences: (await node('seqs')) || {},
        queue: (await node('queue')) || [],
        flag: (await node('flag')) || {},
        hp: { fan: dps('hp')['116'], hz: dps('hp')['115'], fault: dps('hp')['15'] },
        valve: dps('valve')['1'],
        bypass: dps('bypass')['1'],
        defrostStarts: settings.defrostStarts || []
    };
}
module.exports.collect = collect;

// Piped to `node -` there is no main module.
if (!require.main || require.main === module) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
    collect().then((input) => {
        const result = judge(input, { purpose: option('--for', 'deploy'), marginMin: Number(option('--margin', 8)) });
        console.log(args.includes('--json') ? JSON.stringify({ input, result }) : format(result));
        process.exitCode = result.safe ? 0 : 1;
    }).catch((error) => { console.error('WINDOW ERROR: ' + error.message); process.exitCode = 3; });
}
