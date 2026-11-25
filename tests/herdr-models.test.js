'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Herdr model configuration has a default tier and supported models and efforts', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'herdr', 'models.json'), 'utf8'));
    const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(Array.isArray(config.available), 'available must list the supported models');
    assert.ok(typeof config.default === 'string' && Object.hasOwn(config.tiers, config.default), 'default must name a configured tier');
    for (const [name, { model, effort }] of Object.entries(config.tiers)) {
        assert.ok(typeof model === 'string' && model && config.available.includes(model), `${name}: unsupported model ${model}`);
        assert.ok(efforts.has(effort), `${name}: unsupported effort ${effort}`);
    }
});
