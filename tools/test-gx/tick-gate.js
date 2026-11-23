'use strict';

const GATED_INJECTS = ['hp-poll-inject-01', 'hp-log-inject-01', 'hpa-tick-01', 'cres-inject-01', 'hpal-tick-01', 'bmswd-inject-01'];
const FAST_REPEAT_S = 0.1;
const GATE_SUFFIX = '-tick-gate';
const DEPLOY_GATE = 'hpa-tick-01' + GATE_SUFFIX;
const DEPLOY_KEY = 'testGxDeployedAt';
const TICK_COUNT_KEY = 'testGxTicksForwarded';

function gateCode(intervalMs) {
    return `// Test GX only: keep the original period on the faked wall clock.
const interval = ${intervalMs};
const now = Date.now();
const last = context.get('last');
const restart = last === undefined || now < last;
const periods = restart ? 1 : Math.floor((now - last) / interval);
if (periods < 1) return null;
// Keep phase, but do not replay missed ticks as simultaneous samples.
context.set('last', restart ? now : last + periods * interval);
context.set('${TICK_COUNT_KEY}', (context.get('${TICK_COUNT_KEY}') || 0) + 1);
return msg;
`;
}

function gateTickInjects(flows) {
    return flows.flatMap(node => {
        if (node.id === 'grid-cadence-inject-01') {
            const id = 'test-gx-grid-pause';
            return [{ ...node, wires: [[id]] }, {
                id, type: 'function', z: node.z, name: 'Test GX grid pause gate',
                func: "return flow.get('testGxGridExercise') === 'pause' ? null : msg;",
                outputs: 1, wires: node.wires
            }];
        }
        if (node.type !== 'inject' || !GATED_INJECTS.includes(node.id)) return [node];
        const seconds = Number(node.repeat);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Cannot gate inject without a repeat: ' + node.id);
        const gate = {
            id: node.id + GATE_SUFFIX, type: 'function', z: node.z, name: `test tick gate (${seconds} s)`,
            func: gateCode(seconds * 1000), outputs: 1, timeout: 0, noerr: 0,
            initialize: node.id + GATE_SUFFIX === DEPLOY_GATE ? `context.set('${DEPLOY_KEY}', Date.now());` : '',
            finalize: '', libs: [],
            x: (node.x || 0) + 160, y: node.y || 0, wires: node.wires
        };
        // Node-RED waits real seconds for the first injection; give Tuya polling a head start.
        const onceDelay = Math.min(Number(node.onceDelay), node.id === 'bmswd-inject-01' ? 1 :
            node.id === 'hp-poll-inject-01' ? 5 : 10);
        return [{ ...node, repeat: String(FAST_REPEAT_S), onceDelay, wires: [[gate.id]] }, gate];
    });
}

module.exports = { gateTickInjects, GATED_INJECTS, GATE_SUFFIX, DEPLOY_GATE, DEPLOY_KEY, TICK_COUNT_KEY };
