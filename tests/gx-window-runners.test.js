'use strict';
// The "safe moment" check (tools/gx/window.js) on the states met on 14-15 Nov 2026, and the fixed step
// lists of the two runners: the documentation quotes them, so they must not drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./harness');
const { judge, format, defrostIntervalMin } = require('../tools/gx/window.js');

const MIN = 60000;
const NOW = new Date(2026, 10, 15, 1, 22).getTime();
// 15 Nov 01:22, read before the secret install: idle, last defrost start 38 min ago, one every ~42 min.
function idle() {
    return {
        now: NOW, view: { at: NOW - 3000 }, dhw: { state: 'HEATING', run: false }, sequences: {}, queue: [], flag: { on: false },
        hp: { fan: 591, hz: 69, fault: 0 }, valve: false, bypass: false,
        defrostStarts: [NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN]
    };
}

test('window: the defrost interval is the median gap of the recorded starts', () => {
    assert.equal(defrostIntervalMin([NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN]), 42);
    assert.equal(defrostIntervalMin([NOW - 400 * MIN, NOW - 122 * MIN, NOW - 80 * MIN, NOW - 38 * MIN, NOW - 37 * MIN]), 42, 'gaps under 15 min or over 3 h are not intervals');
    assert.equal(defrostIntervalMin([NOW]), null);
    assert.equal(defrostIntervalMin(undefined), null);
});

test('window: 15 Nov 01:22 was safe for a deploy but not for stopping Node-RED (a defrost was due)', () => {
    const deploy = judge(idle());
    assert.equal(deploy.safe, true);
    assert.match(format(deploy), /^SAFE for deploy \(defrost every ~42 min, last start 38 min ago, next in ~4 min\)$/);

    const stop = judge(idle(), { purpose: 'stop', marginMin: 8 });
    assert.equal(stop.safe, false);
    assert.match(format(stop), /^WAIT for stop[\s\S]*the next defrost is expected in 4 min .* needs 8 free minutes/);
});

test('window: right after a defrost there is room to stop Node-RED; an estimate overdue for long stops blocking', () => {
    const fresh = idle();
    fresh.defrostStarts = [NOW - 96 * MIN, NOW - 54 * MIN, NOW - 12 * MIN];
    assert.equal(judge(fresh, { purpose: 'stop' }).safe, true);

    const overdue = idle();
    overdue.defrostStarts = [NOW - 136 * MIN, NOW - 94 * MIN, NOW - 52 * MIN];   // due 10 min ago
    const waiting = judge(overdue, { purpose: 'stop' });
    assert.equal(waiting.safe, false);
    assert.match(format(waiting), /overdue by 10 min/);
    overdue.defrostStarts = overdue.defrostStarts.map((t) => t - 15 * MIN);       // due 25 min ago: it got warmer
    assert.equal(judge(overdue, { purpose: 'stop' }).safe, true);

    const none = idle();
    none.defrostStarts = [];
    assert.equal(judge(none, { purpose: 'stop' }).safe, true, 'no defrost season: nothing to wait for');
});

test('window: every state in which a redeploy or a stop would interrupt something is WAIT, with its reason', () => {
    const cases = [
        [(i) => { i.dhw = { state: 'DHW', run: true }; }, /a DHW cycle is running \(DHW\)/],
        [(i) => { i.dhw = { state: 'HEATING', run: true }; }, /a DHW cycle is running/],
        [(i) => { i.dhw = null; }, /no DHW state/],
        [(i) => { i.sequences = { df_exchange_on: { idx: 1 } }; }, /a rule sequence is running: df_exchange_on/],
        [(i) => { i.queue = [{}, {}]; }, /2 device write\(s\) still queued/],
        [(i) => { i.flag = { on: true }; }, /the defrost flag is ON/],
        [(i) => { i.hp = { fan: 0, hz: 59, fault: 0 }; }, /a defrost is running \(fan 0, compressor 59 Hz\)/],
        [(i) => { i.valve = true; }, /the 3-way valve is not on heating/],
        [(i) => { i.bypass = true; }, /the bypass is not OFF/],
        [(i) => { i.bypass = undefined; }, /the bypass is not OFF \(undefined\)/],
        [(i) => { i.hp.fault = 1; }, /fault code 1/],
        [(i) => { i.view = { at: NOW - 5 * MIN }; }, /the automations are not ticking/],
        [(i) => { i.view = null; }, /the automations are not ticking/]
    ];
    for (const [change, reason] of cases) {
        const input = idle();
        change(input);
        const result = judge(input);
        assert.equal(result.safe, false, String(reason));
        assert.match(result.wait.join('\n'), reason);
    }
});

test('runners: the step lists are fixed and the handoff document quotes them exactly', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    const steps = (script) => {
        const out = spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'scripts', script), '-Steps'], { encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
        return out.stdout.trim().split(/\r?\n/).map((line) => line.trim());
    };
    const deploy = steps('gx-deploy.ps1'), install = steps('gx-secrets-install.ps1');
    assert.deepEqual(deploy.map((line) => line.split(/\s+/).slice(0, 2).join(' ')),
        ['1 preflight', '2 snapshot', '3 compare', '4 plan', '5 window', '6 dry', '7 deploy', '8 verify']);
    assert.deepEqual(install.map((line) => line.split(/\s+/).slice(0, 2).join(' ')),
        ['1 preflight', '2 sync', '3 check', '4 window', '5 dispatch', '6 approve', '7 compare', '8 start']);
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'gx-handoff.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const line of deploy.concat(install)) assert.ok(doc.includes(line), 'docs/gx-handoff.md does not quote: ' + line);
});

test('runners: without -Apply / with -DryRun nothing can change, and bad hosts are refused before any connection', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    for (const script of ['gx-deploy.ps1', 'gx-secrets-install.ps1']) {
        const text = fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8');
        for (const bad of ['root@gx; reboot', "root@gx'x", 'gx.example.test']) {
            const out = spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'scripts', script), '-GxHost', bad, '-SshKey', 'nokey'], { encoding: 'utf8' });
            assert.notEqual(out.status, 0, script + ' accepted ' + bad);
            assert.match(out.stderr + out.stdout, /GxHost must look like/);
        }
        // every command that changes the GX sits behind the switch
        if (script === 'gx-deploy.ps1') {
            assert.ok(text.indexOf('if (-not $Apply) {') < text.indexOf('DRY=0 node'), 'the real deploy comes after the -Apply gate');
            assert.equal((text.match(/DRY=0/g) || []).length, 1);
        } else {
            const gate = text.indexOf("if ($DryRun) { Write-Host ''; Write-Host 'DRY RUN finished");
            assert.ok(gate > 0 && gate < text.indexOf('svc -d $service') && gate < text.indexOf("'action=install'"), 'stop and install come after the -DryRun exit');
            assert.ok(text.indexOf('finally {') > text.indexOf('svc -d $service') && text.includes('svc -u $service'), 'Node-RED is started again in the finally block');
        }
    }
});
