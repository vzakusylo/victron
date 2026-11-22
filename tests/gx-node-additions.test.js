'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { additionPlan } = require('../tools/gx/node-additions');
const { recordedCommit, removalPlan, cleanTopology } = require('../tools/gx/node-additions');
const { snapshot } = require('../tools/gx/live-snapshot');

function removalFixture() {
    const old = [
        { id: 'tab', type: 'tab' },
        { id: 'sender', type: 'inject', z: 'tab', g: 'layout', wires: [['gone', 'keep'], ['keep']] },
        { id: 'layout', type: 'group', z: 'tab', nodes: ['sender', 'gone', 'keep'] },
        { id: 'gone', type: 'delay', z: 'tab', g: 'layout', timeout: '500', wires: [['keep']] },
        { id: 'keep', type: 'function', g: 'layout', z: 'tab', wires: [] },
        { id: 'replacement', type: 'function', z: 'tab', wires: [] }
    ];
    const live = structuredClone(old), target = structuredClone(old).filter(node => node.id !== 'gone');
    target.find(node => node.id === 'sender').wires[0] = ['replacement', 'keep'];
    target.find(node => node.id === 'layout').nodes.splice(1, 1);
    const nodes = flow => snapshot(flow, null, { topology: true }).nodes;
    const plan = (ids, baseline = old) => removalPlan(nodes(live), nodes(target), ids, nodes(baseline));
    return { old, live, target, plan };
}

test('the exact recorded removal list reroutes verified connections and cleans group membership', () => {
    const { live, target, plan } = removalFixture();
    assert.deepEqual(cleanTopology(live, plan(['gone'])), target);
    assert.ok(live.some(node => node.id === 'gone'), 'planning does not mutate live');
});

test('unlisted, extra, duplicate, or live-only node removals stop', () => {
    const { old, plan, live } = removalFixture();
    assert.throws(() => plan([]), /without listing every removal: gone/);
    assert.throws(() => plan(['gone', 'keep']), /Listed IDs would not be removed: keep/);
    assert.throws(() => plan(['gone', 'gone']), /Invalid or duplicate/);
    assert.throws(() => plan(['gone'], old.filter(node => node.id !== 'gone')), /does not match the recorded commit/);
    live.find(node => node.id === 'gone').timeout = '1000';
    assert.throws(() => plan(['gone']), /does not match the recorded commit/);
});

test('removal will not overwrite local connections or rewire an unrelated surviving output', () => {
    const { live, target, plan } = removalFixture();
    const sender = live.find(node => node.id === 'sender');
    sender.wires[0].push('replacement');
    assert.throws(() => plan(['gone']), /GX connections do not match/);
    sender.wires[0].pop();
    target.find(node => node.id === 'sender').wires[1] = ['replacement'];
    assert.throws(() => plan(['gone']), /unsafe wiring/);
});

test('removals require one unambiguous common Git deployment record', () => {
    const sha = 'a'.repeat(40);
    const stamp = automations => `<!-- victron-deployment-source -->\n${JSON.stringify({ dashboard: sha, automations })}\n<!-- /victron-deployment-source -->`;
    assert.equal(recordedCommit(stamp(sha)), sha);
    assert.throws(() => recordedCommit(stamp('b'.repeat(40))), /identical Git deployment SHA/);
    assert.throws(() => recordedCommit(stamp(sha).repeat(2)), /ambiguous/);
});

function fixture() {
    const node = (id, type, extra = {}) => ({ id, type, z: 'tab', ...extra });
    const live = [{ id: 'tab', type: 'tab' }, node('existing', 'function', { outputs: 1, wires: [['old-target']] }),
        node('old-target', 'file')];
    const repo = structuredClone(live);
    repo[1].wires[0].push('handler');
    repo.push(node('endpoint', 'http in', { method: 'get', url: '/demo/:name', wires: [['handler']] }),
        node('handler', 'function', { outputs: 1, wires: [['response']] }), node('response', 'http response'));
    return { live, repo, node };
}

test('new endpoints are opt-in and add the existing node’s connection in the same plan', () => {
    const { live, repo } = fixture();
    assert.throws(() => additionPlan(live, repo, false), /require --allow-new-nodes/);
    assert.deepEqual(additionPlan(live, repo, true), { add: ['endpoint', 'handler', 'response'], wire: ['existing'] });
});

test('new nodes cannot add config, credentials, missing tabs or broken wires', () => {
    const { live, repo, node } = fixture();
    for (const [addition, error] of [
        [node('missing', 'switch', { wires: [['unknown']] }), /wire to missing node unknown/],
        [node('config', 'ui_group'), /config or unsupported node/],
        [node('secret', 'file', { credentials: {} }), /credentials require a manual deploy/],
        [node('orphan', 'file', { z: 'unseen' }), /tab must already exist/],
        [node('widget', 'ui_text', { group: 'unseen' }), /ui_group must already exist/]
    ]) assert.throws(() => additionPlan(live, [...repo, addition], true), error);
});

test('HTTP collision checks account for route parameters, case, trailing slash and HEAD', () => {
    const { live, repo, node } = fixture();
    for (const [method, url, fails] of [
        ['get', '/DEMO/example/', true], ['head', '/demo/:other', true],
        ['get', '/demo/*', true], ['post', '/demo/example', false], ['get', '/other/example', false]
    ]) {
        const existing = node('existing-route', 'http in', { method, url });
        const plan = () => additionPlan([...live, existing], [...repo, existing], true);
        if (fails) assert.throws(plan, /HTTP route collision/);
        else assert.equal(plan().add.length, 3);
    }
});

test('removals and rewiring old destinations stop even when additions are enabled', () => {
    const { live, repo } = fixture();
    for (const optIn of [false, true]) assert.throws(() => additionPlan(live, repo.filter((n) => n.id !== 'old-target'), optIn), /Removing GX nodes/);
    repo[1].wires = [['handler']];
    assert.throws(() => additionPlan(live, repo, true), /may only add connections/);
});

test('layout group is allowed only with matching new members', () => {
    const { live, repo, node } = fixture();
    const group = node('layout', 'group', { nodes: ['handler'] });
    repo.find((n) => n.id === 'handler').g = group.id;
    assert.ok(additionPlan(live, [...repo, group], true).add.includes(group.id));
    group.nodes.push('existing');
    assert.throws(() => additionPlan(live, [...repo, group], true), /layout group may contain only/);
});
