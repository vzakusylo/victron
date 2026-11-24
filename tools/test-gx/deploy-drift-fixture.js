'use strict';
const assert = require('node:assert/strict');

const inputs = [
    ['07c74490cafdc55a', '', '1'],
    ['0ee582b64b26e2e7', 'Battery SmartShunt consumed Ah', '1'],
    ['751d13b6d943e5e5', 'GRID CT import power', '0'],
    ['11e303e775ec959c', 'AC Loads power', '0'],
    ['dc7f2a1c3e8b09c4', 'DC System Power', '0'],
    ['pv-charger-input-01', 'PV Charger Power', '0']
];
const groupOrder = [
    'pv-charger-input-01', '07c74490cafdc55a', '0ee582b64b26e2e7', '751d13b6d943e5e5', '704426f76aa6aa4c',
    '11e303e775ec959c', 'dc7f2a1c3e8b09c4', 'f46ecea6668505f3', '4c8d2e6b19f7a530', '1b39f33beca11607',
    '75f48e33343da04e', 'e4766632305fb432', '66951950bfa6d862', '70b033ccd4654b3e', 'c1803b5fed00bfc2',
    '5545bd538ffe3183', '233d4e08d8a8fe38', '7a3e91c45d2b8f06', 'b85e512d33d6a7cc', '902ee92400d4d4af',
    'grid-override-topic-01', 'grid-cadence-inject-01', 'grid-bookkeeping-01'
];

function adoptInputs(flows) {
    const nodes = new Map(flows.map(node => [node.id, node]));
    for (const [id, name, roundValues] of inputs) {
        const node = nodes.get(id);
        assert.equal(node.roundValues, roundValues, id);
        nodes.set(id, { ...node, name, onlyChanges: false });
    }
    return [...nodes.values()];
}

function incidentLive(base) {
    const flows = adoptInputs(base);
    const index = flows.findIndex(node => node.id === 'lay-g-ctrl');
    assert.deepEqual([...flows[index].nodes].sort(), [...groupOrder].sort());
    assert.notDeepEqual(flows[index].nodes, groupOrder);
    flows[index] = { ...flows[index], nodes: groupOrder };
    return flows.reverse();
}

function assertAdoptedInputsReport(output) {
    const lines = output.split(/\r?\n/);
    const adopted = inputs.flatMap(([id]) => [`${id} name`, `${id} onlyChanges`]).sort();
    assert.deepEqual(lines.filter(line => line.startsWith('adopted drift'))
        .map(line => line.replace(/^adopted drift +: /, '')).sort(), adopted);
    for (const [id] of inputs) assert.ok(!lines.some(line => line.trimStart().startsWith(`${id} (`)), id);
}

module.exports = { adoptInputs, incidentLive, assertAdoptedInputsReport };
