'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadNode } = require('./harness');

test('air history keeps the last duplicate sample and reports day, bins, and statistics', async () => {
    const now = new Date(2026, 10, 22, 12);
    const day = '2026-11-21';
    const history = loadNode('54 Air quality history.js', undefined, undefined, { fs: { promises: {
        readdir: async () => [`${day}.csv`, 'invalid.csv'],
        readFile: async () => '01:00:00,400\n01:00:00,450\n01:04:59,550\n01:05:00,700\n'
    } } });
    const call = history.run({ topic: 'ui', payload: { action: 'day', day } }, { now });
    const { topic, payload: model } = await call.result;
    assert.equal(topic, 'airHistory');
    assert.deepEqual([model.day, model.today, model.days, model.count, model.first, model.last, model.bucketMin],
        [day, '2026-11-22', ['2026-11-22', day], 3, '01:00', '01:05', 5]);
    assert.deepEqual(model.stats.co2, { min: 450, avg: 566.7, max: 700, last: 700 });
    assert.deepEqual(model.series.co2.slice(11, 15), [null, 500, 700, null]);
    assert.deepEqual(call.status, { fill: 'green', shape: 'dot', text: `${day}: 3 readings` });
});
