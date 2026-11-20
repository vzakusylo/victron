'use strict';
// 20 Nov 00:36: the d#193 redeploy started the automations node with an empty context (defaults: local
// control OFF). A motion visit saved the settings before 'load' arrived and overwrote the real file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadNode, ROOT } = require('./harness');
const MIN = 60000;
const NOW = new Date(2026, 10, 20, 0, 36).getTime();

// Run the node's On Start code against its context, as Node-RED does after a deploy.
function onStart(node) {
    const code = fs.readFileSync(path.join(ROOT, '40 Heat pump automations.init.js'), 'utf8');
    vm.runInNewContext(code, { context: node.context, Date: { now: () => NOW } });
}
function hpDps(t) {
    return {
        hp: { state: 'CONNECTED', lastData: t, dps: { 1: true, 2: 'mute', 15: 0, 101: 32, 102: 35, 103: 1, 104: 60, 108: 49, 112: 3,
            115: 60, 116: 550, 125: 35, 132: '1', 133: 38, 134: 4 } },
        valve: { state: 'CONNECTED', lastData: t, dps: { 1: false } },
        bypass: { state: 'CONNECTED', lastData: t, dps: { 1: false } }
    };
}
const writesOf = (out) => [].concat(Array.isArray(out.result) ? [out.result[2]] : [], (out.sent || []).map(m => Array.isArray(m) ? m[2] : null)).filter(m => m && m.payload);
const fileWrites = (out) => writesOf(out).length;
const SAVED = JSON.stringify({ master: true, modes: { dhw: 'live', heat: 'live' }, heatCurve: { p23: 38, p24: 4, at: NOW - 3600000 } });

test('a fresh node does not write the settings file before it has read it', () => {
    const node = loadNode('40 Heat pump automations.js');
    onStart(node);
    assert.equal(node.context.get('settingsLoaded'), false);
    node.flow.set('heatPump', hpDps(NOW));
    node.flow.set('bathroomMotion', { source: 'local', value: 'pir', t: NOW - 1000, seen: NOW - 1000, lastMotionAt: NOW - 1000 });
    const out = node.run({ topic: 'tick' }, { now: NOW });
    assert.equal(fileWrites(out), 0, 'no settings file write before load');
});

test('a defrost start right after a restart does not write the file before load', () => {
    const node = loadNode('40 Heat pump automations.js');
    onStart(node);
    const st = hpDps(NOW); st.hp.dps[116] = 0; st.hp.dps[115] = 60;   // fan stopped, compressor on: defrost
    node.flow.set('heatPump', st);
    const out = node.run({ topic: 'tick' }, { now: NOW });
    assert.equal(fileWrites(out), 0);
});

test('after load, a counted visit writes the real settings, not the defaults', () => {
    const node = loadNode('40 Heat pump automations.js');
    onStart(node);
    node.run({ topic: 'load', payload: SAVED }, { now: NOW });
    assert.equal(node.context.get('settingsLoaded'), true);
    node.flow.set('heatPump', hpDps(NOW + MIN));
    node.flow.set('bathroomMotion', { source: 'local', value: 'pir', t: NOW + MIN - 1000, seen: NOW + MIN - 1000, lastMotionAt: NOW + MIN - 1000 });
    const out = node.run({ topic: 'tick' }, { now: NOW + MIN });
    const writes = writesOf(out);
    assert.ok(writes.length >= 1, 'the visit is saved once loaded');
    for (const w of writes) {
        const s = JSON.parse(w.payload);
        assert.equal(s.master, true);
        assert.equal(s.modes.dhw, 'live');
    }
});

test('a kept context (settings already loaded) may still save after a restart', () => {
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: SAVED }, { now: NOW });
    onStart(node);
    assert.equal(node.context.get('settingsLoaded'), true);
});
