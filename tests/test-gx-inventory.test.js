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

test('an exec node that calls the network is not classified', () => {
  const flows = [...realFlows, { id: 'x4', type: 'exec', command: 'curl https://example.com/api', wires: [[]] }];
  inv.useFixtures(flows);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('exec x4') && m.includes('not classified')));
  } finally { restore(); }
});

test('an exec node with an unknown script is not classified', () => {
  inv.useFixtures([...realFlows, { id: 'x5', type: 'exec', command: 'node /data/home/nodered/tools/new-thing.js', wires: [[]] }]);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('exec x5')));
  } finally { restore(); }
});

test('settings paths are checked: unknown path fails, the known localsettings paths pass', () => {
  inv.useFixtures([...realFlows, { id: 'x6', type: 'victron-output-ess', service: 'com.victronenergy.settings', path: '/Settings/Nothing/Here' }]);
  try {
    const p = inv.problems(inv.inventory());
    assert.ok(p.some((m) => m.includes('settings /Settings/Nothing/Here')));
    assert.strictEqual(p.filter((m) => m.includes('AcPowerSetPoint') || m.includes('MaxChargeCurrent')).length, 0);
  } finally { restore(); }
});

test('a Victron node without a path is reported', () => {
  inv.useFixtures([...realFlows, { id: 'x7', type: 'victron-input-system', service: 'com.victronenergy.system/0' }]);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('x7') && m.includes('no D-Bus path')));
  } finally { restore(); }
});

test('network commands built by a function with a harmless .find( call are not local', () => {
  const feed = (id, cmd) => ({ id: id + 'f', type: 'function', func: `const a = [1].find((x) => x); msg.payload = '${cmd}'; return msg;`, wires: [[id]] });
  const cases = [
    ['x8', "mosquitto_pub -h broker -t t -m 1"],
    ['x9', "python3 -c \"import urllib.request as u; u.urlopen('http://x')\""],
  ];
  const flows = [...realFlows];
  for (const [id, cmd] of cases) flows.push(feed(id, cmd), { id, type: 'exec', command: 'sh -c', wires: [[]] });
  inv.useFixtures(flows);
  try {
    const p = inv.problems(inv.inventory());
    for (const [id] of cases) assert.ok(p.some((m) => m.includes(`exec ${id} `) && m.includes('not classified')), id);
  } finally { restore(); }
});

test('a tolerant reader checks the paths it reads: a new unpublished path is a warning, not an error', () => {
  const flows = realFlows.map((n) => (n.id === 'dv-fn-01' ? { ...n, func: n.func.replace("battery: ['/Dc/0/Voltage'", "battery: ['/Dc/0/NewThing', '/Dc/0/Voltage'") } : n));
  inv.useFixtures(flows);
  try {
    assert.ok(inv.warnings(inv.inventory()).some((m) => m.includes('battery /Dc/0/NewThing')));
    assert.deepEqual(inv.problems(inv.inventory()), []);
  } finally { restore(); }
});

test('a network command is an error even when the node is also dbus, sensor or mail', () => {
  const cases = [
    ['m1', "dbus -y com.victronenergy.system /Dc/Battery/Soc GetValue; mosquitto_pub -h broker -t t -m 1"],
    ['m2', "node /data/home/nodered/tools/tuya-cloud-sensors.js; curl http://example.com/x"],
    ['m3', "node /data/home/nodered/tools/send-mail.js; wget https://example.com/x"],
  ];
  inv.useFixtures([...realFlows, ...cases.map(([id, command]) => ({ id, type: 'exec', command, wires: [[]] }))]);
  try {
    const p = inv.problems(inv.inventory());
    for (const [id] of cases) assert.ok(p.some((m) => m.includes(`exec ${id} `) && m.includes('not classified')), id);
  } finally { restore(); }
});

test('an exec marked dbus without any service + path pair is an error unless it is a listed tolerant reader', () => {
  inv.useFixtures([...realFlows, { id: 'x10', type: 'exec', command: 'dbus -y', wires: [[]] }]);
  try {
    assert.ok(inv.problems(inv.inventory()).some((m) => m.includes('exec x10') && m.includes('no service + path pair')));
    const dv = inv.inventory().find((r) => r.id === 'dv-exec-01' && r.kind === 'exec:dbus');
    assert.ok(dv && !dv.dbus.length && dv.tolerant.includes('battery /Soc') && dv.tolerant.includes('vebus /State'));
  } finally { restore(); }
});
