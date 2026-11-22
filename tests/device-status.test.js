'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const sample = [
    '@@HOST synthetic-gx', '@@MODEL Cerbo GX', '@@DATE synthetic sample',
    '@@NCPU 2', '@@LOAD 1.0 4.0 2.0 2/10', '@@TEMP /synthetic/zone0 78500',
    '@@MEM MemTotal: 102400 kB', '@@MEM MemAvailable: 10240 kB',
    '@@DF tmpfs 100 90 10 90% /run', '@@DF device 1000 900 100 90% /data',
    '@@SAMPLE 1', '@@CPU cpu 100 0 0 900', '@@SAMPLE 2', '@@CPU cpu 190 0 0 910'
].join('\r\n');

test('device status parses samples and publishes health before any exec output', () => {
    const gx = loadNode('29 Build device status.js');
    const watchdog = { state: 'healthy' };
    gx.flow.set('bmsWatchdogState', watchdog);
    const [view, exec] = gx.run({ topic: 'device-status-exec', payload: sample }, { now: NOW }).result;
    assert.equal(exec, null);
    assert.equal(view.topic, 'device-status');
    const { host, updatedAt, sampledAt, cpu, memory, temps, disks, warnings, bmsWatchdog } = view.payload;
    assert.deepEqual({ host, updatedAt, sampledAt }, {
        host: 'synthetic-gx', updatedAt: '2026-11-22T12:00:00.000Z', sampledAt: 'synthetic sample'
    });
    assert.deepEqual(cpu, { usagePct: 90, ncpu: 2, model: '', load: [1, 4, 2], runnable: '2/10', level: 'critical' });
    assert.deepEqual(memory, {
        totalText: '100.0 MB', usedText: '90.0 MB', availableText: '10.0 MB', usedPct: 90,
        cachedText: '0 B', swapText: 'none', level: 'critical'
    });
    assert.deepEqual(temps, [{ zone: 'zone0', celsius: 78.5 }]);
    assert.deepEqual(disks.map(({ mount, level }) => [mount, level]), [['/data', 'critical'], ['/run', 'critical']]);
    assert.deepEqual(warnings.slice(0, 5), [
        'CPU usage 90%', 'Load (5 min) 4 on 2 CPU', 'Low memory: 10.0 MB available', 'Disk /data 90% full', 'Temperature 78.5 °C'
    ]);
    assert.deepEqual(bmsWatchdog, watchdog);
    assert.deepEqual(gx.flow.get('deviceStatusState'), { busySince: 0, view: view.payload, error: '' });
});

test('device-status refresh coalesces concurrent requests and retries after the timeout with its cached view', () => {
    const gx = loadNode('29 Build device status.js');
    const refresh = now => gx.run({ topic: 'refresh' }, { now }).result;
    const [view, exec] = refresh(NOW);
    assert.equal(view, null);
    assert.equal(exec.topic, 'device-status-exec');
    assert.match(exec.payload, /\/proc\/stat/);
    assert.deepEqual(refresh(NOW + 1000), [null, null]);
    const [cached] = gx.run({ topic: 'device-status-exec', payload: sample }, { now: NOW + 2000 }).result;
    assert.deepEqual(refresh(NOW + 3000), [cached, exec]);
    assert.deepEqual(refresh(NOW + 32999), [cached, null]);
    assert.deepEqual(refresh(NOW + 33000), [cached, exec]);
    assert.equal(gx.flow.get('deviceStatusState').busySince, NOW + 33000);
});
