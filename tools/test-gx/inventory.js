#!/usr/bin/env node
// Lists every input and output of the flow and checks that the test GX emulation covers it.
//   node tools/test-gx/inventory.js          print the inventory
//   node tools/test-gx/inventory.js --check  exit 1 when an input/output has no emulation entry
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..', '..');
const flows = JSON.parse(fs.readFileSync(path.join(repo, 'flows.json'), 'utf8'));
const emulator = fs.readFileSync(path.join(__dirname, 'emulator', 'emulator.py'), 'utf8');

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

const kind = (n) => {
  if (/^victron-input-/.test(n.type)) return 'victron-input';
  if (/^victron-output-/.test(n.type)) return 'victron-output';
  return COVERAGE[n.type] ? n.type : null;
};

function inventory() {
  const rows = [];
  for (const n of flows) {
    const k = kind(n);
    if (!k) continue;
    const row = { kind: k, id: n.id, name: n.name || '' };
    if (k.startsWith('victron-')) {
      row.service = n.service;
      row.path = n.path || (n.pathObj && n.pathObj.path);
    } else if (k === 'mqtt in') row.topic = n.topic;
    else if (k === 'http request') row.url = n.url || '(from msg)';
    else if (k === 'http in') row.url = n.url;
    rows.push(row);
  }
  return rows;
}

// Uncovered = a D-Bus path the emulator does not publish, or a node type with no COVERAGE entry.
function problems(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind.startsWith('victron-') && r.path && !emulator.includes(r.path)) {
      out.push(`${r.kind} ${r.id}: ${r.service} ${r.path} is not in emulator.py`);
    }
  }
  const unknown = new Set(flows.filter((n) => /^(mqtt|tcp|udp|websocket|serial|modbus|amqp|kafka|redis)/.test(n.type) && !kind(n) && !/broker|config/.test(n.type)).map((n) => n.type));
  for (const t of unknown) out.push(`node type "${t}" is an input/output with no coverage entry`);
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
  const p = problems(rows);
  for (const m of p) console.log('UNCOVERED', m);
  if (process.argv.includes('--check') && p.length) process.exit(1);
}

module.exports = { inventory, problems, COVERAGE };
