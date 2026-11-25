'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = () => new Map();

const source = name => fs.readFileSync(path.join(__dirname, '..', 'lib', 'heat-pump', name + '.js'), 'utf8');
const make = new Function('flow', 'node', 'fs', source('write-attribution') + source('curve-change-log') +
    '\nreturn { log: hpCurveLog, attribution: hpAttribution };');
const at = Date.parse('2026-11-25T10:00:00Z');

test('observed curve changes carry the dispatch source, details and Oslo timestamp', () => {
    const { attribution, log } = make(store());
    const parts = { owner: { p23: 24, p24: 7 }, boost: 1, warmUp: 2, bandOffset: 1, capApplied: true,
        outdoorAverage: 5, dhw: 'HEATING', defrost: false };
    const cases = [
        ['owner', 'owner (dashboard)'], ['heat', 'heating controller'], ['dhw', 'DHW'],
        ['kick', 'kick'], ['protection', 'protection'], ['recovery', 'restore'],
        ['heat', 'owner (pause)', 'owner (pause)'], [null, 'outside Node-RED (app / cloud / pump)']
    ];
    for (const [i, [source, writer, curveWriter]] of cases.entries()) {
        const t = at + i * 10, dp = i % 2 ? 134 : 133;
        const value = 25 + i;
        const previous = { [dp]: 24 };
        if (source) attribution.sent({ role: 'hp', dps: dp, set: value, shadow: { writer: source },
            curveWriter, curveParts: source === 'heat' ? parts : undefined }, t, t + 5);
        attribution.observe({ [dp]: value }, previous, t + 1, log.append);
        attribution.observe({ [dp]: value }, previous, t + 2, log.append);
        const row = log.view(t + 2).recent[0];
        assert.deepEqual(row, { time: new Date(t + 1).toISOString(), oslo: '2026-11-25 11:00:00',
            dp, old: i < 2 ? 24 : value - 2, new: value, writer, ...(source === 'heat' && { parts }) });
    }
    assert.equal(log.view(at + 100).recent.length, cases.length);
    assert.equal(log.view(at + 100).counts['heating controller'], 1);
    assert.deepEqual(log.view(at + 86400100).counts, {});
});

test('disk rotation caps both segments and a fresh context restores the newest entries', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-curve-log-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const local = file => path.join(dir, path.posix.basename(file));
    const disk = {
        readFileSync: (file, ...args) => fs.readFileSync(local(file), ...args),
        appendFileSync: (file, ...args) => fs.appendFileSync(local(file), ...args),
        renameSync: (source, target) => fs.renameSync(local(source), local(target))
    };
    const node = { warn: message => assert.fail(message) };
    const { log } = make(store(), node, disk);
    for (let i = 0; i < 2010; i++) log.append(at + i, 133, i, i + 1, 'heating controller');
    const restored = make(store(), node, disk).log.view(at + 2010);
    assert.equal(restored.counts['heating controller'], 1010);
    assert.equal(restored.recent.length, 50);
    assert.equal(restored.recent[0].new, 2010);
    assert.equal(restored.recent[49].new, 1961);
});

test('an unreadable curve log backs off across readers and recovers on the next attempt', () => {
    const warnings = [];
    let attempts = 0, denied = true;
    const disk = {
        readFileSync() {
            attempts++;
            if (denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            return '';
        }
    };
    const { log } = make(store(), { warn: msg => warnings.push(msg) }, disk);
    assert.equal(log.view(at).error, 'Curve log unavailable');
    for (let i = 1; i < 30; i++) assert.equal(log.recent(5, at + i * 10000), null);
    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);
    denied = false;
    assert.deepEqual(log.view(at + 300000), { counts: {}, recent: [] });
    assert.equal(attempts, 3);
});

test('failed curve log rotation warns once, keeps writing and bounds the current file', () => {
    let text = '';
    const warnings = [];
    const disk = {
        readFileSync: file => file.endsWith('.1') ? '' : text,
        appendFileSync: (_file, line) => { text += line; },
        renameSync() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
        writeFileSync: (_file, content) => { text = content; }
    };
    const node = { warn: msg => warnings.push(msg) };
    const { log } = make(store(), node, disk);
    for (let i = 0; i < 4010; i++) {
        log.append(at + i, 133, i, i + 1, 'heating controller');
        if (i % 100 === 0) assert.ok(text.trimEnd().split('\n').length <= 2000);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /rotation failed/);
    const restored = make(store(), node, disk).log.recent(5, at + 4010);
    assert.deepEqual(restored.map(row => row.new), [4010, 4009, 4008, 4007, 4006]);
});

test('pause protection fails open and retry limits require a clear fault and elapsed delay', () => {
    const { pauseProtection, retryDecision } = new Function('MIN', source('operator-controls') +
        '\nreturn { pauseProtection, retryDecision };')(60000);
    const tankCfg = { curve: [[-20, 37], [1, 50]], hyst: 3 };
    assert.equal(pauseProtection(null, 50, tankCfg), 'frost protection');
    assert.equal(pauseProtection(5, 34, tankCfg), 'tank protection');
    assert.equal(pauseProtection(5, 35, tankCfg), '');
    const cfg = { autoRetry: true, retryMax: 2, retryWait: 30 };
    const due = at + 1800000;
    const block = { at, retryable: true };
    assert.equal(retryDecision(block, 2, cfg, 0, due), null);
    assert.equal(retryDecision(block, 0, { ...cfg, autoRetry: false }, 0, due), null);
    assert.equal(retryDecision({ at }, 0, cfg, 0, due), null);
    assert.equal(retryDecision(block, 1, cfg, NaN, due).ready, false);
    assert.equal(retryDecision(block, 1, cfg, 0, due - 1).ready, false);
    assert.deepEqual(retryDecision(block, 1, cfg, 0, due), { due, ready: true });
});
