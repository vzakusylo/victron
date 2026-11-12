// Runs the source of a Node-RED function node outside Node-RED:
// fake `context` / `flow` stores, a fixed clock, captured node.status / node.send / warnings.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function store(initial) {
    const data = Object.assign({}, initial);
    return {
        data,
        get: (key) => data[key],
        set: (key, value) => { data[key] = value; }
    };
}

// `Date` whose "now" is fixed; explicit dates work as usual.
function fixedDate(nowMs) {
    return class FixedDate extends Date {
        constructor(...args) { if (args.length) super(...args); else super(nowMs); }
        static now() { return nowMs; }
    };
}

function loadNode(file, sourceText) {
    const source = sourceText === undefined ? fs.readFileSync(path.join(ROOT, file), 'utf8') : sourceText;
    const fn = new Function('msg', 'node', 'context', 'flow', 'global', 'env', 'Date', 'Buffer', 'setTimeout', source);
    const context = store();
    const flow = store();

    // opts.now: Date or ms (default: real time). Returns what the node returned.
    function run(msg, opts) {
        const now = opts && opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();
        const call = { status: null, sent: [], warnings: [], logs: [], timers: [] };
        const node = {
            status: (s) => { call.status = s; },
            send: (m) => { call.sent.push(m); },
            warn: (t) => { call.warnings.push(String(t)); },
            error: (t) => { call.warnings.push(String(t)); },
            log: (t) => { call.logs.push(String(t)); }
        };
        const timer = (cb, ms) => { call.timers.push({ cb, ms }); return call.timers.length; };
        call.result = fn(msg, node, context, flow, store(), store(), fixedDate(now), Buffer, timer);
        return call;
    }

    return { run, context, flow };
}

module.exports = { loadNode, ROOT };
