'use strict';

const GATED_INJECTS = ['hp-poll-inject-01', 'hp-log-inject-01', 'hpa-tick-01', 'cres-inject-01', 'hpal-tick-01', 'bmswd-inject-01'];
const FAST_REPEAT_S = 0.1;
const GATE_SUFFIX = '-tick-gate';

function gateCode(intervalMs) {
    return `// Test GX only: keep the original period on the faked wall clock.
const interval = ${intervalMs};
const now = Date.now();
const last = context.get('last');
if (last === undefined || now < last) {
    context.set('last', now);
    return msg;
}
const periods = Math.floor((now - last) / interval);
if (periods < 1) return null;
// Keep phase, but do not replay missed ticks as simultaneous samples.
context.set('last', last + periods * interval);
return msg;
`;
}

function gateTickInjects(flows) {
    return flows.flatMap(node => {
        if (node.type !== 'inject' || !GATED_INJECTS.includes(node.id)) return [node];
        const seconds = Number(node.repeat);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Cannot gate inject without a repeat: ' + node.id);
        const gate = {
            id: node.id + GATE_SUFFIX, type: 'function', z: node.z, name: `test tick gate (${seconds} s)`,
            func: gateCode(seconds * 1000), outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
            x: (node.x || 0) + 160, y: node.y || 0, wires: node.wires
        };
        // Node-RED waits real seconds for the first injection; give Tuya polling a head start.
        const onceDelay = Math.min(Number(node.onceDelay), node.id === 'bmswd-inject-01' ? 1 :
            node.id === 'hp-poll-inject-01' ? 5 : 10);
        return [{ ...node, repeat: String(FAST_REPEAT_S), onceDelay, wires: [[gate.id]] }, gate];
    });
}

module.exports = { gateTickInjects, GATED_INJECTS, GATE_SUFFIX };
