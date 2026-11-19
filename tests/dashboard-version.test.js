'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stampDeployment } = require('../tools/deploy-version');
const flows = require('../flows.json');

const source = fs.readFileSync(path.join(__dirname, '..', '60 Read dashboard version.js'), 'utf8');
const readVersion = new Function('msg', 'env', source);
const dashboardSha = '0123456789abcdef0123456789abcdef01234567';
const automationSha = 'a'.repeat(40);

function badge(label) {
    return readVersion({}, { get: (name) => {
        assert.equal(name, 'NR_FLOW_NAME');
        return label;
    } }).payload.text;
}

test('badge displays the d# and the dashboard Git SHA from real deployment labels', () => {
    for (const automations of [dashboardSha, automationSha]) {
        const stamped = stampDeployment(flows, { dashboard: dashboardSha, automations });
        const tab = stamped.find((node) => node.type === 'tab' && /d#\d+/.test(node.label));
        assert.equal(badge(tab.label), tab.label.match(/d#\d+/)[0] + ' \u00b7 0123456');
    }
});

test('badge displays only the d# when the dashboard Git SHA is not recorded', () => {
    assert.equal(badge('d#187 Day / Night Grid Control'), 'd#187');
    assert.equal(badge('d#187 Day / Night Grid Control [UI unrecorded; Auto aaaaaaaaaaaa]'), 'd#187');
    assert.equal(badge('d#187 Day / Night Grid Control [local bbbbbbbbbbbb]'), 'd#187');
});

test('badge is empty without a flow version, even if a SHA is present', () => {
    for (const label of ['Day / Night Grid Control [git 0123456789ab]', '', null, undefined]) {
        assert.equal(badge(label), '');
    }
});

test('dashboard tab names have no flow version or Git suffix', () => {
    for (const node of flows.filter((item) => item.type === 'ui_tab')) {
        assert.doesNotMatch(node.name, /d#\d+| \[(?:git |local |UI )/, node.id);
    }
});
