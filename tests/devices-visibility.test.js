'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, readSource } = require('./harness');

const now = Date.UTC(2026, 10, 23);
function read(node, hidden, policy = '[]') {
    return node.run({ topic: 'read', payload: '@@VISIBILITY\n' + JSON.stringify({ hidden }) +
        '\n@@ROOM_EXCLUSIONS\n' + policy + '\n@@DBUSJSON {"services":[]}' }, { now }).result[0].payload;
}
const ui = (node, action, id) => node.run({ topic: 'ui', payload: { action, id } }, { now }).result;
const ack = (node, output, payload = 'saved') => node.run({ ...output, payload }, { now }).result[0].payload;

test('hide writes only dashboard settings and survives a restart; restore works for missing devices', () => {
    const node = loadNode('50 Devices model.js');
    const before = read(node, []);
    const [busy, request] = ui(node, 'hide', 'hp');
    assert.equal(request.topic, 'visibilitySaved');
    assert.match(request.payload, /mktemp .*devices-page-settings\.json.*mv -f/);
    assert.equal(busy.payload.visibilityBusy, true);
    assert.equal(ui(node, 'hide', 'valve'), null);
    const hidden = ack(node, request);
    assert.deepEqual(hidden.hiddenDevices.map(d => d.id), ['hp']);
    assert.deepEqual(hidden.devices, before.devices);
    assert.equal(hidden.temperatureSensors, undefined, 'preferences do not update history');
    assert.ok(node.flow.get('devicesReport').devices.some(d => d.id === 'hp'));

    const restarted = loadNode('50 Devices model.js');
    const persisted = read(restarted, [...hidden.hiddenDevices, { id: 'missing', name: 'Old sensor' }]);
    assert.deepEqual(persisted.hiddenDevices.map(d => d.id), ['hp', 'missing']);
    const restore = ui(restarted, 'restore', 'missing')[1];
    assert.deepEqual(ack(restarted, restore).hiddenDevices.map(d => d.id), ['hp']);
    assert.deepEqual(read(restarted, []).hiddenDevices.map(d => d.id), ['hp'], 'an in-flight read cannot undo a saved preference');
});

test('failed save keeps the old list and leaves the UI ready to retry', () => {
    const node = loadNode('50 Devices model.js');
    read(node, []);
    assert.equal(ui(node, 'hide', 'unknown'), null);
    const request = ui(node, 'hide', 'hp')[1];
    const model = ack(node, request, 'failed');
    assert.deepEqual(model.hiddenDevices, []);
    assert.equal(model.visibilityBusy, false);
    assert.match(model.visibilityError, /Could not save/);
    assert.equal(ui(node, 'hide', 'hp')[1].topic, 'visibilitySaved');
});

test('a lost save reply requires a fresh disk read before accepting another change', () => {
    const node = loadNode('50 Devices model.js');
    read(node, []);
    const request = ui(node, 'hide', 'hp')[1];
    const [status, reload] = node.run({ topic: 'tick' }, { now: now + 36000 }).result;
    assert.equal(status.payload.visibilityReady, false);
    assert.equal(node.run({ ...request, payload: 'saved' }, { now: now + 36001 }).result, null);
    assert.equal(read(node, []).visibilityReady, false);
    const recovered = node.run({ ...reload, payload: '@@VISIBILITY\n{"hidden":[{"id":"hp","name":"Heat pump"}]}' },
        { now: now + 36002 }).result[0].payload;
    assert.equal(recovered.visibilityReady, true);
    assert.deepEqual(recovered.hiddenDevices.map(d => d.id), ['hp']);
});

test('Devices template filters hidden IDs and sends hide and restore actions', () => {
    const html = readSource('51 Devices page.html');
    const messages = [];
    const scope = { send: msg => messages.push(msg), $watch: (_, fn) => fn({ topic: 'model', payload: {
        hiddenDevices: [{ id: 'hp', name: 'Heat pump' }]
    } }) };
    new Function('scope', html.match(/<script>([\s\S]+?)<\/script>/)[1])(scope);
    assert.match(html, /filter:dvVisible/);
    assert.match(html, /Hidden devices/);
    assert.equal(scope.dvVisible({ id: 'hp' }), false);
    assert.equal(scope.dvVisible({ id: 'hp-other' }), true);
    scope.dvSend('hide', 'valve');
    scope.dvSend('restore', 'hp');
    assert.deepEqual(messages.map(m => m.payload), [{ action: 'hide', id: 'valve' }, { action: 'restore', id: 'hp' }]);
});
