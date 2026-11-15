const test = require('node:test');
const assert = require('node:assert');
const { inventory, problems } = require('../tools/test-gx/inventory.js');

test('listed D-Bus inputs/outputs exist in the emulator (exec nodes are not inventoried yet)', () => {
  const rows = inventory();
  assert.ok(rows.some((r) => r.kind === 'victron-input'));
  assert.deepStrictEqual(problems(rows), []);
});
