const test = require('node:test');
const assert = require('node:assert');
const inv = require('../tools/test-gx/inventory.js');

const realFlows = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'flows.json'), 'utf8'));
const realEmulator = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'tools', 'test-gx', 'emulator', 'emulator.py'), 'utf8');
const restore = () => inv.useFixtures(realFlows, realEmulator);

test('every D-Bus pair of the flow is emulated or explicitly planned', () => {
  restore();
  const rows = inv.inventory();
  assert.ok(rows.some((r) => r.kind === 'victron-input'));
  assert.ok(rows.some((r) => r.kind === 'exec:dbus'), 'exec nodes with dbus are inventoried');
  assert.ok(rows.some((r) => r.kind === 'exec:mail'));
  assert.deepStrictEqual(inv.problems(rows), []);
});

test('a Victron node on a service+path the emulator lacks is reported, even if the path exists on another service', () => {
  // /Soc exists on vebus and battery in emulator.py but not on system
  const flows = [...realFlows, { id: 'x1', type: 'victron-input-system', service: 'com.victronenergy.system/0', path: '/Soc' }];
  inv.useFixtures(flows);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('system /Soc')));
  } finally { restore(); }
});

test('an unknown node type is reported', () => {
  inv.useFixtures([...realFlows, { id: 'x2', type: 'serial in' }]);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('"serial in"')));
  } finally { restore(); }
});

test('an exec node reading a dbus path the emulator lacks is reported', () => {
  const flows = [...realFlows, { id: 'x3', type: 'exec', command: 'dbus -y com.victronenergy.system /Ac/Nothing GetValue', wires: [[]] }];
  inv.useFixtures(flows);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('system /Ac/Nothing')));
  } finally { restore(); }
});
