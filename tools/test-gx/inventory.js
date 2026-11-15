#!/usr/bin/env node
// Lists every input and output of the flow and checks that the test GX emulation covers it.
//   node tools/test-gx/inventory.js          print the inventory
//   node tools/test-gx/inventory.js --check  exit 1 when an input/output has no emulation entry
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..', '..');
let flows = JSON.parse(fs.readFileSync(path.join(repo, 'flows.json'), 'utf8'));
let emulator = fs.readFileSync(path.join(__dirname, 'emulator', 'emulator.py'), 'utf8');

// Node types that are inputs/outputs; everything else is internal logic.
// status: emulated = the test GX drives/records it, planned = emulation is a later step-B item.
const COVERAGE = {
  'victron-input': { status: 'emulated', by: 'D-Bus emulator' },
  'victron-output': { status: 'emulated', by: 'D-Bus emulator (/writes)' },
  'tuya-smart-device': { status: 'planned', by: 'Tuya stub (B-tuya)' },
  'mqtt in': { status: 'planned', by: 'mosquitto + publisher (B-mqtt)' },
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

// Paths com.victronenergy.settings (localsettings in venus) provides itself; the emulator does not publish them.
const LOCALSETTINGS = new Set(['settings /Settings/CGwacs/AcPowerSetPoint', 'settings /Settings/SystemSetup/MaxChargeCurrent']);

const SENSOR_SCRIPT = /tuya-[\w-]+\.js/;
const MAIL_SCRIPT = /send-mail\.js/;
// Scripts and shell tools that only touch files under /data/home/nodered; anything else is not classified and fails the check.
const LOCAL_TOOLS = new Set(['sensor-history', 'heatpump-decode', 'elvenett-statistics', 'victron-secrets', 'reload-victron-secrets']);
const LOCAL_SHELL = /\b(cat|find|mkdir|tar|gzip|zcat|ls|python3?)\b/;
const NETWORK_CMD = /\b(curl|wget|ssh|scp|nc)\s+(-\S+\s+)*['"]?(https?:\/\/|[\w.-]+:\d+)/;
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const toolsUsed = (t) => [...t.matchAll(/(?:tools\/|TOOLS_DIR \+ '\/|\bnode (?:-- )?\S*\/)([\w-]+)\.js/g)].map((m) => m[1]);

// An exec node's real command is often built by the function node wired into it, so both texts are scanned.
function execText(n) {
  const feeders = flows.filter((f) => (f.wires || []).some((w) => w.includes(n.id)));
  return [n.command || '', ...feeders.map((f) => f.func || '')].join('\n');
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
  // mandatory paths every VeDbusService registers
  for (const s of Object.values(svcName)) for (const p of ['/Mgmt/ProcessName', '/Mgmt/Connection', '/DeviceInstance', '/ProductName', '/Connected']) pairs.add(`${s} ${p}`);
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
    if (!out.length || !local && tools.length) out.push('exec:unknown');
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
      } else if (k === 'mqtt in') row.topic = n.topic;
      else if (k === 'http request') row.url = n.url || '(from msg)';
      else if (k === 'http in') row.url = n.url;
      else if (k === 'exec:dbus') row.dbus = dbusPairs(execText(n));
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

// Uncovered = a D-Bus pair the emulator does not publish (and is not in PLANNED_DBUS), or a node type with no coverage and not internal.
function problems(rows) {
  const out = [];
  const provided = emulatorPairs();
  const check = (where, pair) => {
    if (PLANNED_DBUS[pair]) return;
    if (!provided.has(pair) && !LOCALSETTINGS.has(pair)) out.push(`${where}: ${pair} is not published by emulator.py`);
  };
  for (const r of rows) {
    if (r.kind.startsWith('victron-') && !r.path) out.push(`${r.kind} ${r.id}: node has no D-Bus path`);
    if (r.kind.startsWith('victron-') && r.path) check(`${r.kind} ${r.id}`, `${SERVICE_CLASS(r.service)} ${r.path}`);
    if (r.kind === 'exec:unknown') out.push(`exec ${r.id} (${r.name}) is not classified (command: ${r.command || 'built by a function node'})`);
    if (r.kind === 'exec:dbus') for (const p of r.dbus) check(`exec ${r.id}`, p);
  }
  const unknown = new Set(flows.filter((n) => n.type !== 'exec' && !isInternal(n.type) && !COVERAGE[n.type] && !/^victron-(in|out)put-/.test(n.type)).map((n) => n.type));
  for (const t of unknown) out.push(`node type "${t}" has no coverage entry and is not listed as internal`);
  return out;
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
  if (process.argv.includes('--check') && p.length) process.exit(1);
}

// tests replace the flow / emulator source to prove that gaps are detected
const useFixtures = (f, e) => { flows = f || flows; emulator = e || emulator; };

module.exports = { inventory, problems, COVERAGE, PLANNED_DBUS, useFixtures };
