'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness.js');
const flows = require('../flows.json');

test('a grid feedback alarm reaches the Victron custom output with a configured string path', () => {
    const format = loadNode('03 Format GX notification.js');
    const formatter = flows.find(node => node.name === 'Format GX notification');
    const output = flows.find(node => node.id === formatter.wires[0][0]);
    const message = 'grid not following setpoint: ESS read-back did not match';
    const { result } = format.run({ notification: { title: 'Grid control', type: 'alarm', message }, payload: message });

    assert.equal(output.type, 'victron-output-custom');
    assert.equal(output.service, 'com.victronenergy.system/0');
    assert.equal(output.path, '/Notifications/Inject');
    assert.equal(output.pathObj?.path, output.path, 'the palette reads node configuration, not msg.pathObj');
    assert.equal(output.pathObj.disabled, false);
    assert.equal(typeof result.payload, output.pathObj.type);
    assert.equal(result.payload, `1\tGrid control\t${message}`);
});

test('the notification formatter cannot forward an inherited D-Bus path override', () => {
    const format = loadNode('03 Format GX notification.js');
    const { result } = format.run({ path: '/OtherItem', payload: 'Battery disconnected', type: 'warning' });
    assert.equal(result.path, undefined);
    assert.equal(result.payload, '0\tDay / Night Grid Control\tBattery disconnected');
});
