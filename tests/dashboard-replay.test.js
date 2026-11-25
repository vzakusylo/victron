'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');
const flows = require('../flows.json');

const now = new Date(2026, 10, 25, 12).getTime();

test('only the templates that rebuild opt out of dashboard replay', () => {
    const retained = flows.filter(node => node.type === 'ui_template' && node.storeOutMessages).map(node => node.name);
    assert.deepEqual(retained, ['Root files navigator', 'Selected root file contents',
        'High-voltage settings editor', 'Controller constants editor', 'Backup manager']);
    for (const id of ['hpa-page-01', 'hpl-page-01', 'pb-page-01', 'dv-page-01', 'dv-aq-page-01']) {
        assert.equal(flows.find(node => node.id === id).resendOnRefresh, false, id);
    }
});

test('Automations can rebuild on page open and on the next ten-second tick', () => {
    const automations = loadNode('40 Heat pump automations.js');
    const open = automations.run({ topic: 'ui', payload: { action: 'refresh' } }, { now });
    const tick = automations.run({ topic: 'tick' }, { now: now + 10000 });
    assert.ok(open.result[0].payload.rules.length > 0);
    const ids = call => call.result[0].payload.rules.map(rule => rule.id);
    assert.deepEqual(ids(tick), ids(open));
});

test('Devices sends its cached dashboard model on open, even inside the read throttle', () => {
    const devices = loadNode('50 Devices model.js');
    const first = devices.run({ topic: 'read', payload: '' }, { now });
    const open = devices.run({ topic: 'ui', payload: { action: 'open' } }, { now: now + 1 });
    assert.deepEqual(open.result[0], first.result[0]);
});
