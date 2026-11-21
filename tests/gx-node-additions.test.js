'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { additionPlan } = require('../tools/gx/node-additions');

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
