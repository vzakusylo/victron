const test = require('node:test');
const assert = require('node:assert');
const { inventory, problems } = require('../tools/test-gx/inventory.js');

test('every flow input/output is covered by the test GX emulation', () => {
  const rows = inventory();
  assert.ok(rows.some((r) => r.kind === 'victron-input'));
  assert.deepStrictEqual(problems(rows), []);
});
