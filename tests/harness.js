// Runs the source of a Node-RED function node outside Node-RED:
// fake `context` / `flow` stores, a fixed clock, captured node.status / node.send / warnings.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { expand } = require('../tools/includes');
// a numbered source with its `// #include lib/…js` lines expanded, as it is embedded in flows.json
function readSource(file) { return expand(fs.readFileSync(path.join(ROOT, file), 'utf8'), ROOT); }

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

function loadNode(file, sourceText, flow = store(), modules = {}) {
    const source = sourceText === undefined ? readSource(file) : sourceText;
    const fn = new Function('msg', 'node', 'context', 'flow', 'global', 'env', 'Date', 'Buffer', 'setTimeout', 'clearTimeout', 'gridClock', ...Object.keys(modules), source);
    const context = store();

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
        call.result = fn(msg, node, context, flow, store(), store(opts?.env), fixedDate(now), Buffer, timer, () => {},
            { hrtime: { bigint: () => BigInt(now) * 1000000n } }, ...Object.values(modules));
        return call;
    }

    return { run, context, flow };
}

function loadGrid({ captureTrace = false } = {}) {
    const control = loadNode('01 Battery + Grid Controller.js');
    const bookkeeping = loadNode('63 Grid bookkeeping.js', undefined, control.flow);
    const cadence = { topic: 'grid-control-tick' };
    function runRaw(msg, opts) {
        const call = control.run(msg, opts);
        if (!call.result) return call;
        if (captureTrace) bookkeeping.context.set('lastTraceTs', 0);
        const accounting = bookkeeping.run(structuredClone(call.result[7]), opts);
        // Historical replays compare decisions, not the physical writer cadence.
        const { decision, sendGridCurrentLimit } = call.result[7].tick;
        const result = decision ? [
            { topic: 'charge-current-limit', payload: decision.finalChargeCurrent },
            { topic: 'grid-setpoint', payload: decision.finalGridSetpoint },
            sendGridCurrentLimit ? { topic: 'ac-input-current-limit', payload: decision.gridCurrentLimitA } : null,
            ...accounting.result
        ] : null;
        return { ...call, result, status: accounting.status };
    }
    return {
        control, bookkeeping, context: control.context, flow: control.flow, runRaw,
        run(msg, opts) {
            const call = runRaw(msg, opts);
            return call.result || call.status ? call : runRaw(cadence, opts);
        }
    };
}

module.exports = { loadNode, loadGrid, readSource, ROOT };
