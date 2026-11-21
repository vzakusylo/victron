'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gateTickInjects, GATED_INJECTS, GATE_SUFFIX } = require('../tools/test-gx/tick-gate');
const flows = require('../flows.json');

test('fixture gates only the selected periodic injects and preserves their downstream wires', () => {
    const gated = gateTickInjects(flows);
    assert.equal(gated.length, flows.length + GATED_INJECTS.length);
    assert.ok(flows.every(node => !node.id.endsWith(GATE_SUFFIX)));
    for (const original of flows) {
        const inject = gated.find(node => node.id === original.id);
        if (!GATED_INJECTS.includes(original.id)) {
            assert.deepEqual(inject, original);
            continue;
        }
        const gate = gated.find(node => node.id === original.id + GATE_SUFFIX);
        assert.ok(Number(inject.repeat) < Number(original.repeat) / 60);
        assert.deepEqual(inject.wires, [[gate.id]]);
        assert.deepEqual(gate.wires, original.wires);
        assert.equal(gate.z, original.z);
    }
});

test('ten-second gate keeps phase at x60, drops missed samples and handles a backward clock jump', () => {
    const gate = gateTickInjects(flows).find(node => node.id === 'hpa-tick-01' + GATE_SUFFIX);
    const context = new Map();
    const fn = new Function('msg', 'context', 'Date', gate.func);
    const msg = { payload: 1 };
    const tick = now => fn(msg, context, { now: () => now });
    const times = Array.from({ length: 21 }, (_, i) => 100_000 + i * 6000);
    assert.equal(times.filter(now => tick(now) === msg).length, 13);
    assert.equal(tick(255_000), msg);
    assert.equal(tick(255_001), null);
    assert.equal(tick(50_000), msg);
    assert.equal(tick(59_999), null);
    assert.equal(tick(60_000), msg);
});
