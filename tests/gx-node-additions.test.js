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

test('approved Victron input removal changes only the layout group membership', () => {
    const group = { id: 'lay-g-ctrl', type: 'group', z: 'tab', name: 'Control',
        style: { label: true }, nodes: ['keep', 'battery'], x: 10, y: 20, w: 200, h: 80 };
    const live = [
        { id: 'tab', type: 'tab' }, group,
        { id: 'keep', type: 'function', z: 'tab', g: group.id, wires: [] },
        { id: 'battery', type: 'victron-input-battery', z: 'tab', g: group.id, wires: [['keep']] }
    ];
    const baseline = snapshot(live, null, { topology: true }).nodes;
    const target = [live[0], { ...group, nodes: ['keep'] }, live[2]];
    const plan = flows => removalPlan(baseline, snapshot(flows, null, { topology: true }).nodes, ['battery'], baseline);
    const result = plan(target);
    assert.deepEqual(result.remove, ['battery']);
    assert.deepEqual(Object.keys(result.reconnect), [group.id]);
    assert.deepEqual({ ...result.reconnect[group.id] }, { nodes: ['keep'] });
    assert.deepEqual(cleanTopology(live, result), target);
    assert.throws(() => plan([live[0], group, live[2]]), /lay-g-ctrl: target still references a removed node/);
});

function groupRemoval() {
    const group = { id: 'group', type: 'group', z: 'tab', nodes: ['a', 'gone', 'b'] };
    const tab = { id: 'tab', type: 'tab' };
    const member = id => ({ id, type: 'delay', z: 'tab', g: group.id });
    const plan = (live, target, recorded = group.nodes) => {
        const nodes = (members, ids) => snapshot([tab, { ...group, nodes: members }, ...ids.map(member)], null, { topology: true }).nodes;
        const ids = ['a', 'gone', 'b'];
        return removalPlan(nodes(live, ids), nodes(target, ['a', 'b', 'new']), ['gone'], nodes(recorded, ids));
    };
    return plan;
}

test('group removal accepts order drift and writes existing members in target order', () => {
    const { reconnect } = groupRemoval()(['a', 'b', 'gone'], ['b', 'new', 'a']);
    assert.deepEqual(reconnect.group.nodes, ['b', 'a']);
});

test('group removal reports unrecorded GX members and missing commit members', () => {
    const plan = groupRemoval();
    assert.throws(() => plan(['a', 'gone', 'extra'], ['a', 'b']), {
        message: 'group.nodes: GX differs from the recorded commit: only on GX [extra], only in commit [b]'
    });
    assert.throws(() => plan(['a', 'b'], ['a', 'b']), {
        message: 'group.nodes: GX differs from the recorded commit: only on GX [], only in commit [gone]'
    });
    assert.throws(() => plan(['a', 'gone', 'b'], ['a', 'new']), /group\.nodes: unsafe member change alongside removal/);
});

test('group removal rejects duplicates in GX, commit and target membership', () => {
    const plan = groupRemoval();
    for (const [live, target, recorded] of [
        [['a', 'gone', 'b', 'a'], ['a', 'b']],
        [['a', 'gone', 'b'], ['a', 'b'], ['a', 'gone', 'b', 'a']],
        [['a', 'gone', 'b'], ['a', 'new', 'new', 'b']]
    ]) assert.throws(() => plan(live, target, recorded), /group\.nodes: duplicate group members/);
});

test('Victron outputs and subflow instances are not removable even with approval', () => {
    const target = snapshot([{ id: 'tab', type: 'tab' }], null, { topology: true }).nodes;
    for (const type of ['victron-output-ess', 'subflow:template']) {
        const live = snapshot([{ id: 'tab', type: 'tab' }, { id: 'gone', type, z: 'tab' }], null, { topology: true }).nodes;
        assert.throws(() => removalPlan(live, target, ['gone'], live), {
            message: `gone: node type ${type} is not removable by the deploy tool; remove it in the Node-RED editor or extend the list.`
        });
    }
});

test('tab, layout group, config and non-tab parent removals still require a manual deploy', () => {
    const retained = [{ id: 'tab', type: 'tab' }, { id: 'template', type: 'subflow' }];
    const nodes = flow => snapshot(flow, null, { topology: true }).nodes;
    for (const node of [
        { id: 'gone', type: 'tab' },
        { id: 'gone', type: 'group', z: 'tab', nodes: [] },
        { id: 'gone', type: 'ui_group' },
        { id: 'gone', type: 'victron-input-battery', z: 'template' }
    ]) {
        const live = nodes([...retained, node]);
        assert.throws(() => removalPlan(live, nodes(retained), ['gone'], live), {
            message: 'gone: removing tabs, groups or configuration nodes requires a manual deploy.'
        });
    }
});

function outputRemoval(oldWires, newWires, liveOutputs = oldWires.length) {
    const node = (id, type, extra) => ({ id, type, z: 'tab', ...extra });
    const sender = wires => node('sender', 'function', { outputs: wires.length, wires });
    const common = [{ id: 'tab', type: 'tab' }, node('page', 'delay')];
    const gone = node('gone', 'exec');
    const baseline = [...common, sender(oldWires), gone];
    const live = [...common, { ...sender(oldWires), outputs: liveOutputs }, gone];
    const target = [...common, sender(newWires)];
    const nodes = flow => snapshot(flow, null, { topology: true }).nodes;
    return { live, target, plan: () => removalPlan(nodes(live), nodes(target), ['gone'], nodes(baseline)) };
}

test('removal can drop a trailing output wired only to an approved removal', () => {
    const { live, target, plan } = outputRemoval([['page'], ['gone']], [['page']]);
    const result = plan();
    assert.deepEqual({ ...result.reconnect.sender }, { outputs: 1, wires: [['page']] });
    assert.deepEqual(cleanTopology(live, result), target);
});

test('removal rejects dropped outputs with kept destinations or no destinations', () => {
    assert.throws(outputRemoval([['page'], ['gone', 'page']], [['page']]).plan, {
        message: 'sender: output 1 dropped but it still wires to kept node(s) [page].'
    });
    assert.throws(outputRemoval([['gone'], []], [[]]).plan, /output 1 dropped but it has no approved removal destinations/);
});

test('removal cannot drop an earlier output and shift a later one', () => {
    assert.throws(outputRemoval([['gone'], ['page']], [['page']]).plan, /output 1 dropped but it still wires to kept node/);
});

test('removal cannot grow output count or shrink a count that differs from the baseline', () => {
    assert.throws(outputRemoval([['page'], ['gone']], [['page'], [], []]).plan, /output count cannot increase alongside removal/);
    assert.throws(outputRemoval([['page'], ['gone']], [['page']], 3).plan, /GX output count does not match the recorded commit/);
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

test('dashboard-wide nodes can be added without a group, but still need an existing tab', () => {
    const live = [{ id: 'tab', type: 'tab' }];
    const additions = [
        { id: 'viewers', type: 'ui_ui_control', z: 'tab', group: '' },
        { id: 'toast', type: 'ui_toast', z: 'tab' },
        { id: 'audio', type: 'ui_audio', z: 'tab' }
    ];
    assert.deepEqual(additionPlan(live, [...live, ...additions], true), {
        add: ['viewers', 'toast', 'audio'], wire: []
    });
    assert.throws(() => additionPlan(live, [...live, { ...additions[0], z: 'missing' }], true), /tab must already exist/);
});

test('dashboard additions still validate explicit and required groups', () => {
    const live = [{ id: 'tab', type: 'tab' }, { id: 'dashboard-group', type: 'ui_group' }];
    const viewers = { id: 'viewers', type: 'ui_ui_control', z: 'tab', group: 'missing' };
    assert.throws(() => additionPlan(live, [...live, viewers], true), {
        message: 'viewers: ui_group missing does not exist on the GX.'
    });
    assert.deepEqual(additionPlan(live, [...live, { ...viewers, group: 'dashboard-group' }], true).add, ['viewers']);
    assert.throws(() => additionPlan(live, [...live, { ...viewers, type: 'ui_text', group: '' }], true), /ui_group must already exist/);
});

test('new endpoints are opt-in and add the existing node’s connection in the same plan', () => {
    const { live, repo } = fixture();
    assert.throws(() => additionPlan(live, repo, false), /require --allow-new-nodes/);
    assert.deepEqual(additionPlan(live, repo, true), { add: ['endpoint', 'handler', 'response'], wire: ['existing'] });
});

test('approved new nodes still cannot add Victron inputs', () => {
    const { live, repo, node } = fixture();
    assert.throws(() => additionPlan(live, [...repo, node('battery', 'victron-input-battery')], true), {
        message: 'battery: cannot add node type victron-input-battery (config or unsupported node).'
    });
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

test('adding to an existing group uses repository order rather than appending', () => {
    const tab = { id: 'tab', type: 'tab' };
    const member = id => ({ id, type: 'delay', z: 'tab', g: 'layout' });
    const group = { id: 'layout', type: 'group', z: 'tab', nodes: ['a', 'b'] };
    const live = [tab, group, member('a'), member('b')];
    const repo = [tab, { ...group, nodes: ['a', 'new', 'b'] }, member('a'), member('b'), member('new')];
    assert.deepEqual(additionPlan(live, repo, true).groupMembers?.get('layout'), ['a', 'new', 'b']);
});

test('adding to a drifted group keeps live-only memberships and does not move existing nodes into it', () => {
    const tab = { id: 'tab', type: 'tab' };
    const member = (id, g = 'layout') => ({ id, type: 'delay', z: 'tab', g });
    const group = { id: 'layout', type: 'group', z: 'tab', nodes: ['b', 'local-1', 'a', 'local-2'] };
    const live = [tab, group, member('a'), member('b'), member('local-1'), member('local-2'), member('outside', '')];
    const repo = [tab, { ...group, nodes: ['a', 'new', 'outside', 'b'] },
        member('a'), member('b'), member('local-1', ''), member('local-2', ''), member('outside'), member('new')];
    const result = additionPlan(live, repo, true);
    assert.deepEqual(result.groups, ['layout']);
    assert.deepEqual(result.groupMembers?.get('layout'), ['a', 'local-1', 'new', 'local-2', 'b']);
    assert.deepEqual(group.nodes, ['b', 'local-1', 'a', 'local-2']);

    for (const duplicate of [live, repo]) {
        const members = duplicate[1].nodes;
        members.push('a');
        assert.throws(() => additionPlan(live, repo, true), /duplicate layout group members alongside addition/);
        members.pop();
    }
});

test('layout group is allowed only with matching new members', () => {
    const { live, repo, node } = fixture();
    const group = node('layout', 'group', { nodes: ['handler'] });
    repo.find((n) => n.id === 'handler').g = group.id;
    assert.ok(additionPlan(live, [...repo, group], true).add.includes(group.id));
    group.nodes.push('existing');
    assert.throws(() => additionPlan(live, [...repo, group], true), /layout group may contain only/);
});
