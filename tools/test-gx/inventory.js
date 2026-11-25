#!/usr/bin/env node
// Lists every input and output of the flow and checks that the test GX emulation covers it.
//   node tools/test-gx/inventory.js          print the inventory
//   node tools/test-gx/inventory.js --check  exit 1 when an input/output has no emulation entry
const fs = require('fs');
const path = require('path');
const { DEVICES } = require('./transform-tuya.js');
const originalTuyaModel = require('./emulator/tuya-model.json');
let tuyaModel = originalTuyaModel;

const repo = path.join(__dirname, '..', '..');
let flows = JSON.parse(fs.readFileSync(path.join(repo, 'flows.json'), 'utf8'));
let emulator = fs.readFileSync(path.join(__dirname, 'emulator', 'emulator.py'), 'utf8');

// Node types that are inputs/outputs; everything else is internal logic.
// status: emulated = the test GX drives/records it, planned = emulation is a later step-B item.
const COVERAGE = {
  'victron-input': { status: 'emulated', by: 'D-Bus emulator' },
  'victron-output': { status: 'emulated', by: 'D-Bus emulator (/writes)' },
  'tuya-smart-device': { status: 'emulated', by: 'Tuya proxy over MQTT (automations only, not the local protocol)' },
  'mqtt in': { status: 'emulated', by: 'internal mosquitto + emulator POST /mqtt' },
  'mqtt out': { status: 'emulated', by: 'Tuya MQTT commands recorded in /writes' },
  'http request': { status: 'planned', by: 'forecast stub (B-forecast)' },
  'inject': { status: 'emulated', by: 'real Node-RED timers (libfaketime for clock scenarios)' },
  'http in': { status: 'emulated', by: 'real Node-RED HTTP endpoints' },
  'file in': { status: 'emulated', by: 'files inside the image' },
};

Object.assign(COVERAGE, {
  'file': { status: 'emulated', by: 'files inside the image' },
  'exec:sensor': { status: 'planned', by: 'Tuya cloud/local sensor scripts (B-tuya)' },
  'exec:mail': { status: 'stub', by: 'send-mail.js stub (B-mail)' },
  'exec:dbus': { status: 'emulated', by: 'D-Bus emulator (service + path pairs)' },
  'exec:local': { status: 'emulated', by: 'shell/file work inside the image' },
  'exec:unknown': { status: 'planned', by: 'NOT CLASSIFIED: add the script to the lists in inventory.js or emulate it' },
});

// Types that are pure logic, UI or configuration: no external input/output. Any other type must have a COVERAGE entry.
const INTERNAL = new Set(['tab', 'group', 'subflow', 'victron-client', 'ui_base', 'function', 'json', 'link out', 'link in', 'delay',
  'change', 'debug', 'catch', 'comment', 'http response', 'mqtt-broker']);
const isInternal = (t) => INTERNAL.has(t) || /^ui_/.test(t) || /^subflow:/.test(t);

// D-Bus pairs that exec scripts need and the emulator does not provide yet. Each entry must stay explicit; delete it when emulated.
const PLANNED_DBUS = {
  'battery.tty': 'BMS watchdog / driver checks look for com.victronenergy.battery.tty* (serialbattery); the emulator publishes battery.emulator (B-bms)',
  'system /ActiveBmsService': 'BMS watchdog reads it (B-bms)',
  'settings /Settings/SystemSetup/BmsInstance': 'BMS watchdog reads/writes it (localsettings, B-bms)',
};

// exec nodes that read D-Bus with a tolerant script: it enumerates services and reads COMMON + TYPE[kind] path tables with try/except,
// so a missing path gives null instead of an error. Their pairs come from those tables (feeder function) and a gap is a warning, not an error.
const TOLERANT_DBUS_READERS = {
  'dv-exec-01': 'Devices model: python reads COMMON + TYPE[kind] paths, a missing path returns null',
};
const EMULATED_CLASSES = ['system', 'vebus', 'battery'];

function tolerantPairs(n) {
  const src = flows.filter((f) => (f.wires || []).some((w) => w.includes(n.id))).map((f) => f.func || '').join('\n');
  const common = (src.match(/COMMON\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const type = (src.match(/TYPE\s*=\s*['"]?\s*\+\s*JSON\.stringify\(\{([\s\S]*?)\}\)/) || src.match(/TYPE\s*=\s*\{([\s\S]*?)\}/) || [])[1] || '';
  const paths = (s) => [...s.matchAll(/["'](\/[A-Za-z0-9/_]+)["']/g)].map((m) => m[1]);
  const out = new Set();
  for (const c of EMULATED_CLASSES) {
    for (const p of paths(common)) out.add(`${c} ${p}`);
    const m = type.match(new RegExp(`\\b${c}\\s*:\\s*\\[([^\\]]*)\\]`));
    for (const p of paths(m ? m[1] : '')) out.add(`${c} ${p}`);
  }
  return [...out];
}

// Paths com.victronenergy.settings (localsettings in venus) provides itself; the emulator does not publish them.
const LOCALSETTINGS = new Set(['settings /Settings/CGwacs/AcPowerSetPoint', 'settings /Settings/SystemSetup/MaxChargeCurrent']);

const SENSOR_SCRIPT = /tuya-[\w-]+\.js/;
const MAIL_SCRIPT = /send-mail\.js/;
// Scripts and shell tools that only touch files under /data/home/nodered; anything else is not classified and fails the check.
const LOCAL_TOOLS = new Set(['sensor-history', 'heatpump-decode', 'elvenett-statistics', 'victron-secrets', 'reload-victron-secrets']);
const LOCAL_SHELL = /\b(cat|find|mkdir|tar|gzip|zcat|ls)\b|['"]tail -n /;
// dbus-send is a local D-Bus call that bypasses the dbus -y / python pair parsing, so it cannot be checked against the emulator: treated as unclassified.
const NETWORK_CMD = /\b(curl|wget|ssh|scp|nc)\s+(-\S+\s+)*['"]?(https?:\/\/|[\w.-]+:\d+)|\bmosquitto_(pub|sub)\b|\bdbus-send\b|\burlopen\b|\bhttp\.client\b|\bnode\s+-e\b|\bfetch\(/;
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const toolsUsed = (t) => [...t.matchAll(/\/([\w-]+)\.js\b/g)].map((m) => m[1]);

// An exec node's real command is often built by the function node wired into it. Only the string literals of that function are scanned
// (the shell command is a string), not its JS code: a `.find(` call must not make a network command look local.
const STRING_LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
// Classify only the reviewed, offline history predicate call; leave any other inline Node command unclassified.
const ROOM_FILTER_LITERALS = [
  `'const room = require(process.argv[1]).isRoomSensorKey;'`,
  `'const text = require("fs").readFileSync(0, "utf8");'`,
  `'let meta; try { meta = JSON.parse(text || "{}"); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }'`,
  `'const ids = JSON.parse(process.argv[2]).concat(Object.keys(meta || {}));'`,
  `'console.log(JSON.stringify(ids.filter(id => !room(id))));'`,
  String.raw`'printf "%s" "$meta" | node -e '`,
  `'/sensor-history.js '`,
];
function execText(n) {
  const feeders = flows.filter((f) => (f.wires || []).some((w) => w.includes(n.id)));
  const literals = feeders.flatMap((f) => {
    const source = withoutComments(f.func || '');
    const values = source.match(STRING_LITERAL) || [];
    if (f.id !== 'dv-fn-01' || n.id !== 'dv-exec-01') return values;
    const [predicate, input, meta, ids, output, command, tool] = ROOM_FILTER_LITERALS;
    const definition = `const roomFilter = ${predicate} +\n        ${input} +\n        ${meta} +\n        ${ids} +\n        ${output};`;
    const invocation = `${command} + shellQuote(roomFilter) + ' ' + TOOLS_DIR + ${tool} + shellQuote(JSON.stringify(ORDER)),`;
    if (!source.includes(definition) || !source.includes(invocation)) return values;
    // Replace just one occurrence; another inline invocation must still be flagged.
    const index = values.indexOf(command);
    if (index >= 0) values[index] = 'room history predicate';
    return values;
  });
  return [n.command || '', ...literals].join('\n');
}

const SERVICE_CLASS = (s) => String(s).replace(/^com\.victronenergy\./, '').split(/[./]/)[0];

// Service classes and paths that the emulator publishes, read from the build() function of emulator.py.
function emulatorPairs() {
  const body = emulator.split(/^def build\(/m)[1].split(/^def /m)[0].replace(/^    else:/m, "    elif name == 'battery':");
  const pairs = new Set();
  const parts = body.split(/^\s*(?:el)?if name == '(\w+)':/m);
  const svcName = { system: 'system', vebus: 'vebus', battery: 'battery' };
  for (let i = 1; i < parts.length; i += 2) {
    for (const m of parts[i + 1].matchAll(/'(\/[A-Za-z0-9/_]+)'/g)) pairs.add(`${svcName[parts[i]]} ${m[1]}`);
  }
  // paths registered for every fake service (mandatory paths plus identity)
  for (const s of Object.values(svcName)) for (const p of ['/Mgmt/ProcessName', '/Mgmt/Connection', '/DeviceInstance', '/ProductName', '/FirmwareVersion', '/CustomName', '/Serial', '/Connected']) pairs.add(`${s} ${p}`);
  return pairs;
}

function kinds(n) {
  if (/^victron-input-/.test(n.type)) return ['victron-input'];
  if (/^victron-output-/.test(n.type)) return ['victron-output'];
  if (n.type === 'exec') {
    const t = withoutComments(execText(n));
    const out = [];
    if (SENSOR_SCRIPT.test(t)) out.push('exec:sensor');
    if (MAIL_SCRIPT.test(t)) out.push('exec:mail');
    if (/dbus -y|dbus\.SystemBus|\bg com\.victronenergy/.test(t)) out.push('exec:dbus');
    const tools = toolsUsed(t).filter((x) => !SENSOR_SCRIPT.test(x + '.js') && !MAIL_SCRIPT.test(x + '.js'));
    const local = !NETWORK_CMD.test(t) && tools.every((x) => LOCAL_TOOLS.has(x)) && (tools.length > 0 || LOCAL_SHELL.test(t));
    if (local) out.push('exec:local');
    if (!out.length || !local && tools.length || NETWORK_CMD.test(t)) out.push('exec:unknown');   // a network command is never covered, whatever else the node does
    return out;
  }
  return COVERAGE[n.type] ? [n.type] : [];
}

function inventory() {
  const rows = [];
  for (const n of flows) {
    for (const k of kinds(n)) {
      const row = { kind: k, id: n.id, name: n.name || '' };
      if (k.startsWith('victron-')) {
        row.service = n.service;
        row.path = n.path || (n.pathObj && n.pathObj.path);
      } else if (k === 'mqtt in' || k === 'mqtt out') row.topic = n.topic;
      else if (k === 'http request') row.url = n.url || '(from msg)';
      else if (k === 'http in') row.url = n.url;
      else if (k === 'exec:dbus') {
        row.dbus = dbusPairs(execText(n));
        if (TOLERANT_DBUS_READERS[n.id]) row.tolerant = tolerantPairs(n);
      }
      else if (k === 'exec:unknown') row.command = String(n.command || '').slice(0, 80);
      rows.push(row);
    }
  }
  return rows;
}

// "service-class path" pairs and bare service-name needs found in script text.
function dbusPairs(text) {
  const out = new Set();
  for (const m of text.matchAll(/com\.victronenergy\.(\w+)(?:\.(\w+))?[\w.]*["']?\s+(\/[A-Za-z0-9/_]+)/g)) out.add(`${m[1]} ${m[3]}`);
  if (/com\.victronenergy\.battery\.tty/.test(text)) out.add('battery.tty');
  return [...out];
}

// Paths a tolerant reader asks for and the emulator does not publish: reported, never fatal.
function warnings(rows) {
  const provided = emulatorPairs();
  return rows.filter((r) => r.tolerant).flatMap((r) => r.tolerant.filter((p) => !provided.has(p)).map((p) => `exec ${r.id} (${r.name}): ${p} is not published by emulator.py (reader tolerates it)`));
}

// Uncovered = a D-Bus pair the emulator does not publish (and is not in PLANNED_DBUS), or a node type with no coverage and not internal.
function problems(rows) {
  const out = [];
  for (const n of flows.filter(n => n.type === 'tuya-smart-device')) {
    if (!DEVICES[n.id] || !tuyaModel[DEVICES[n.id]]) out.push(`Tuya ${n.id}: no device model / proxy transformation`);
  }
  for (const [device, dps] of Object.entries(tuyaDps())) for (const dp of dps) {
    if (!tuyaModel[device]?.[dp]) out.push(`Tuya ${device}: consumed DPS ${dp} is not in tuya-model.json`);
  }
  const provided = emulatorPairs();
  const check = (where, pair) => {
    if (PLANNED_DBUS[pair]) return;
    if (!provided.has(pair) && !LOCALSETTINGS.has(pair)) out.push(`${where}: ${pair} is not published by emulator.py`);
  };
  for (const r of rows) {
    if (r.kind === 'mqtt in' && r.topic !== 'qingping/+/up' && !/^tuya\/(pump|valve|bypass|meter)\/(data|state)$/.test(r.topic)) out.push(`mqtt in ${r.id}: topic "${r.topic}" is not covered by emulator POST /mqtt or Tuya models`);
    if (r.kind === 'mqtt out' && !/^tuya\/(pump|valve|bypass|meter)\/command$/.test(r.topic)) out.push(`mqtt out ${r.id}: topic "${r.topic}" is not covered by Tuya /writes`);
    if (r.kind.startsWith('victron-') && !r.path) out.push(`${r.kind} ${r.id}: node has no D-Bus path`);
    if (r.kind.startsWith('victron-') && r.path) check(`${r.kind} ${r.id}`, `${SERVICE_CLASS(r.service)} ${r.path}`);
    if (r.kind === 'exec:unknown') out.push(`exec ${r.id} (${r.name}) is not classified (command: ${r.command || 'built by a function node'})`);
    if (r.tolerant && !r.tolerant.length) out.push(`exec ${r.id} (${r.name}) is a listed tolerant D-Bus reader but its COMMON/TYPE path tables were not found: the parser is out of date`);
    if (r.kind === 'exec:dbus' && !r.dbus.length && !r.tolerant) out.push(`exec ${r.id} (${r.name}) is marked dbus but no service + path pair was found: the parser or the category is wrong`);
    if (r.kind === 'exec:dbus') for (const p of r.dbus) check(`exec ${r.id}`, p);
  }

  const unknown = new Set(flows.filter((n) => n.type !== 'exec' && !isInternal(n.type) && !COVERAGE[n.type] && !/^victron-(in|out)put-/.test(n.type)).map((n) => n.type));
  for (const t of unknown) out.push(`node type "${t}" has no coverage entry and is not listed as internal`);
  return out;
}

// Known DPS aliases in the state/automation consumers. DP dictionaries cover dynamic reads by the UI.
function tuyaDps() {
  const result = { pump: new Set(), valve: new Set(), bypass: new Set(), meter: new Set() };
  for (const n of flows.filter(n => n.type === 'function')) {
    let text = withoutComments(n.func || '');
    const meter = text.match(/function meterReading\([^)]*\)\s*\{[\s\S]*?^\}/m);
    if (meter) {
      for (const m of meter[0].matchAll(/\bd\[['"]?(\d+)['"]?\]/g)) result.meter.add(m[1]);
      text = text.replace(meter[0], '');
    }
    const table = text.match(/\bHP_DPS\s*=\s*\{([\s\S]*?)^\};/m);
    if (/HP_DPS/.test(text) && !table) throw new Error('Tuya HP_DPS table cannot be parsed: ' + n.id);
    if (table) for (const m of table[1].matchAll(/['"]?(\d+)['"]?\s*:/g)) result.pump.add(m[1]);
    const pumpAliases = /HP_DPS/.test(text) ? 'H|hpd|hp|d' : 'H|hpd|hp';
    for (const [device, aliases] of Object.entries({ pump: pumpAliases, valve: 'V|vd|valve', bypass: 'B|bd|bypass', meter: 'meter' })) {
      for (const m of text.matchAll(new RegExp(`\\b(?:${aliases})(?:\\.dps)?\\[['"]?(\\d+)['"]?\\]`, 'g'))) result[device].add(m[1]);
    }
    for (const m of text.matchAll(/\bb\[['"](\d+)['"]\]/g)) result.bypass.add(m[1]);
    for (const m of text.matchAll(/\bdev\.dps\[['"]?(\d+)['"]?\]/g)) { result.valve.add(m[1]); result.bypass.add(m[1]); }
    for (const m of text.matchAll(/role:\s*['"](hp|valve|bypass|meter)['"],\s*dps:\s*(\d+)/g)) result[m[1] === 'hp' ? 'pump' : m[1]].add(m[2]);
  }
  return result;
}

if (require.main === module) {
  const rows = inventory();
  const byKind = {};
  for (const r of rows) (byKind[r.kind] = byKind[r.kind] || []).push(r);
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`${k}  x${list.length}  [${COVERAGE[k] ? COVERAGE[k].status : 'emulated'}: ${COVERAGE[k] ? COVERAGE[k].by : 'D-Bus emulator'}]`);
    if (!process.argv.includes('--brief')) {
      for (const r of list) console.log('   ', [r.id, r.service, r.path, r.topic, r.url, r.name].filter(Boolean).join('  '));
    }
  }
  for (const [k, why] of Object.entries(PLANNED_DBUS)) console.log('PLANNED  ', k, '-', why);
  const p = problems(rows);
  for (const m of p) console.log('UNCOVERED', m);
  for (const m of warnings(rows)) console.log('WARN     ', m);
  if (process.argv.includes('--check') && p.length) process.exit(1);
}

// tests replace the flow / emulator source to prove that gaps are detected
const useFixtures = (f, e, m) => { flows = f || flows; emulator = e || emulator; tuyaModel = m || tuyaModel; };

module.exports = { TOLERANT_DBUS_READERS, inventory, problems, warnings, COVERAGE, PLANNED_DBUS, useFixtures };
