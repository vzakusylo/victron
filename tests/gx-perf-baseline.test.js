'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collect, descendants, markdown, parseStat } = require('../tools/gx/perf-baseline');

const env = { GX_SSH_HOST: 'root@gx.example', GX_SSH_KEY_PATH: 'private-test-key-path' };

test('parses Linux stat including punctuation in comm and finds only Node-RED descendants', () => {
    const p = parseStat('123 (node ) red) S 5 0 0 0 0 0 0 0 0 0 13 7 0 0 0 0 0 0 456');
    assert.deepEqual(p, { pid: 123, name: 'node ) red', parent: 5, cpuTicks: 20, id: '123:456' });
    assert.throws(() => parseStat('123 (broken) S'), /Invalid \/proc stat/);
    assert.deepEqual(descendants([p, { pid: 124, parent: 123, id: '124:457' },
        { pid: 125, parent: 42, id: '125:458' }], 5), ['123:456', '124:457']);
});

test('uses one verified SSH session and reports CPU, RSS, distinct spawns and nearest-rank percentiles', () => {
    const samples = Array.from({ length: 7 }, (_, i) => ({
        atS: i * 10, cpuTicks: 100 + 50 * i, rssKiB: (100 + i) * 1024,
        children: i === 0 ? ['11:100'] : i < 4 ? ['11:100', '12:200'] : ['12:300'],
        adminTtfbMs: [100, 8, 3, 5, 6, 4, 7][i]
    }));
    const { summary } = collect(1, env, (cmd, args, opts) => {
        assert.equal(cmd, 'ssh');
        assert.ok(args.includes('StrictHostKeyChecking=yes'));
        assert.deepEqual(args.slice(-2), ['root@gx.example', 'node -']);
        assert.match(opts.input, /sampleRemote\(60, 10\)/);
        assert.doesNotThrow(() => new Function(opts.input));
        return { status: 0, stdout: JSON.stringify({ hz: 100, samples }) };
    });
    assert.deepEqual(summary, {
        durationS: 60, intervalS: 10, sampleCount: 7, cpuPct: 5,
        rssMeanMiB: 103, rssMaxMiB: 106, observedSpawns: 2, observedSpawnsPerHour: 120,
        adminTtfbMsP50: 6, adminTtfbMsP95: 100
    });
    assert.match(markdown(summary), /\| 5\.00 \| 103\.00 \| 106\.00 \| 120\.00 \| 6\.00 \| 100\.00 \|/);
});

test('fails closed on absent SSH configuration, failed probe or incomplete samples', () => {
    assert.throws(() => collect(1, {}, () => assert.fail('must not start SSH')), /Set GX_SSH_HOST/);
    assert.throws(() => collect(0, env, () => assert.fail('must not start SSH')), /Duration/);
    assert.throws(() => collect(1, env, () => ({ status: 1, stderr: 'Node-RED restarted' })), /Node-RED restarted/);
    const sample = { atS: 0, cpuTicks: 3, rssKiB: 1024, children: [], adminTtfbMs: 1 };
    assert.throws(() => collect(1, env, () => ({ status: 0,
        stdout: JSON.stringify({ hz: 100, samples: [sample, { ...sample, atS: 10 }] }) })), /Incomplete/);
});
