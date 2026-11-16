'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    ScenarioAssertionError,
    assertWrites,
    createAdmin,
    faketimeRate,
    junitXml,
    loadScenarios,
    parseDuration,
    parseYaml,
    runScenario,
    runScenarios,
    trivialScenario,
    validateScenario
} = require('../tools/test-gx/run-scenarios.js');
const { loadNode } = require('./harness');

test('scenario YAML parser handles nested maps, sequences, quoted values and comments', () => {
    const parsed = parseYaml(`
name: "heat pump #1"
faketime: '@2026-11-16 12:00:00'
initial:
  inputs:
    tuya.pump.dps.108: 49
    tuya.valve.dps.1: false
steps:
  - when: 15m
    expect:
      writes:
        - device: pump
          operation: SET
          dps: "133"
          value: 38
          applied: true
`);
    assert.equal(parsed.name, 'heat pump #1');
    assert.equal(parsed.initial.inputs['tuya.pump.dps.108'], 49);
    assert.deepEqual(parsed.steps[0].expect.writes, [{
        device: 'pump', operation: 'SET', dps: '133', value: 38, applied: true
    }]);
});

test('scenario YAML parser rejects duplicate keys, tab indentation and malformed collections', () => {
    assert.throws(() => parseYaml('name: one\nname: two'), /duplicate key/);
    assert.throws(() => parseYaml('name: one\n\tfaketime: now'), /tabs are not supported/);
    assert.throws(() => parseYaml('values: [one, two]'), /inline collections must be JSON/);
});

test('faketime and when durations are validated and converted', () => {
    assert.equal(faketimeRate('@2026-11-16 12:00:00 x60'), 60);
    assert.equal(faketimeRate('@2026-11-16 12:00:00'), 1);
    assert.equal(parseDuration('1.5m'), 90000);
    assert.throws(() => faketimeRate('not a clock'), /@YYYY-MM-DD HH:mm:ss/);
    assert.throws(() => parseDuration('next week'), /invalid duration/);
});

test('scenario settings reject unsupported fields and rule modes', () => {
    const scenario = { name: 'settings', faketime: '@2026-11-16 12:00:00', steps: [{ when: '0s' }] };
    assert.throws(() => validateScenario({ ...scenario, settings: { master: true, modes: {}, unsupported: {} } }), /known rule modes/);
    assert.throws(() => validateScenario({ ...scenario, settings: { master: true, modes: { hp_er03_restart: 'invalid' } } }), /known rule modes/);
    assert.throws(() => validateScenario({ ...scenario, settings: { master: true, modes: {}, heatCurve: { p23: 41, p24: 4 } } }), /valid p23 and p24/);
});

test('write assertions compare write count, order and requested fields', () => {
    const actual = [{ device: 'pump', operation: 'SET', dps: '133', value: 38, applied: true, ts: 1 }];
    assert.doesNotThrow(() => assertWrites(actual, [{ device: 'pump', dps: '133', value: 38 }], 'curve', 1));
    assert.throws(() => assertWrites([], [{ dps: '133' }], 'curve', 1), ScenarioAssertionError);
    assert.throws(() => assertWrites(actual, [{ dps: '134' }], 'curve', 1), /dps expected/);
    assert.throws(() => assertWrites([...actual, ...actual], [{ dps: '133' }], 'curve', 1), /expected 1 writes, received 2/);
});

test('full Er03 scenario rejects every missing or reordered command', () => {
    const scenario = loadScenarios().find(s => s.name === 'Er03 full restart sequence');
    assert.ok(scenario);
    assert.equal(faketimeRate(scenario.faketime), 1);
    const writes = scenario.steps.flatMap(step => step.expect.writes);
    assert.deepEqual(writes.map(({ device, dps, value }) => [device, dps, value]), [
        ['valve', '1', false], ['valve', '1', false], ['pump', '1', false],
        ['pump', '1', true], ['bypass', '1', false], ['pump', '132', '1']
    ]);
    assert.doesNotThrow(() => assertWrites(writes, writes, scenario.name, 1));
    for (let i = 0; i < writes.length; i++) {
        assert.throws(() => assertWrites(writes.filter((_, n) => n !== i), writes, scenario.name, 1), ScenarioAssertionError);
    }
    const reordered = [...writes];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    assert.throws(() => assertWrites(reordered, writes, scenario.name, 1), ScenarioAssertionError);
});

test('quiet-period scenarios use the same demand and settings on both sides of the guard', () => {
    const scenarios = loadScenarios();
    const quiet = scenarios.find(s => s.name === 'no heat pump commands during deploy quiet period');
    const after = scenarios.find(s => s.name === 'DHW demand starts after deploy quiet period');
    assert.ok(quiet && after);
    assert.deepEqual(quiet.settings, after.settings);
    assert.deepEqual(quiet.initial, after.initial);
    assert.equal(quiet.faketime, after.faketime);
    assert.deepEqual(quiet.steps[0].expect.writes, []);
    assert.ok(after.steps[0].expect.writes.some(w => w.device === 'pump' && w.dps === '133' && w.value === 0));
});

test('a trivial scenario passes, calls the emulator API and produces JUnit XML', async () => {
    const actions = [];
    const api = {
        post: async (route, body) => { actions.push([route, body]); return { ok: true }; },
        getState: async () => ({}),
        getWrites: async () => []
    };
    const results = await runScenarios([trivialScenario()], {
        api,
        waitReady: false,
        setFaketime: async value => actions.push(['faketime', value]),
        restoreFaketime: false
    });
    assert.deepEqual(results.map(r => r.status), ['pass']);
    assert.deepEqual(actions, [
        ['faketime', '@2026-11-16 12:00:00'],
        ['/reset', {}]
    ]);
    const xml = junitXml(results);
    assert.match(xml, /tests="1" failures="0" skipped="0"/);
    assert.match(xml, /name="trivial scenario runner smoke"/);
});

test('runner CLI creates the JUnit output directory for its self-test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-junit-'));
    const report = path.join(root, 'nested', 'report.xml');
    try {
        const result = spawnSync(process.execPath, [
            path.join(__dirname, '..', 'tools', 'test-gx', 'run-scenarios.js'),
            '--self-test', '--junit', report
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(fs.readFileSync(report, 'utf8'), /tests="1" failures="0" skipped="0"/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scenario actions use the approved emulator input, stale and fail endpoints', async () => {
    const calls = [];
    const scenario = {
        name: 'API actions',
        faketime: '@2026-11-16 12:00:00',
        initial: { inputs: { 'tuya.pump.dps.108': 49 } },
        steps: [{
            when: '0s', settle: '0s',
            inputs: { 'tuya.pump.dps.15': 1 },
            fail: { 'tuya.valve': 'offline' },
            stale: { 'tuya.bypass': 60 },
            expect: { writes: [] }
        }]
    };
    const api = {
        post: async (route, body) => { calls.push([route, body]); return { ok: true }; },
        getState: async () => ({}),
        getWrites: async () => []
    };
    await runScenario(scenario, { api, waitReady: false, setFaketime: async () => {}, wait: async () => {} });
    assert.deepEqual(calls, [
        ['/reset', {}],
        ['/set', { path: 'tuya.pump.dps.108', value: 49 }],
        ['/set', { path: 'tuya.pump.dps.15', value: 1 }],
        ['/fail', { path: 'tuya.valve', mode: 'offline' }],
        ['/stale', { path: 'tuya.bypass', seconds: 60 }]
    ]);
});

test('scenario applies its settings and asserts only new SET commands', async () => {
    const calls = [];
    const scenario = {
        name: 'deterministic settings',
        faketime: '@2026-11-16 12:00:00',
        settings: { master: true, modes: { hp_er03_restart: 'live' } },
        steps: [{ when: '0s', settle: '0s', expect: { writes: [{ device: 'valve', dps: '1', value: false }] } }]
    };
    const api = {
        post: async route => { calls.push(route); },
        getWrites: async () => [
            { service: 'vebus', path: '/Ac/In/1/CurrentLimit', value: 31 },
            { device: 'pump', operation: 'GET' },
            { device: 'valve', operation: 'SET', dps: '1', value: false }
        ]
    };
    await runScenario(scenario, {
        api, waitReady: false, setFaketime: async () => {},
        admin: { loadSettings: async settings => { calls.push(settings); } }
    });
    assert.deepEqual(calls, [scenario.settings, '/reset']);
});

test('settings use temporary inject nodes and remove the temporary flow', async () => {
    const calls = [];
    const fetch = async (url, options) => {
        const route = url.pathname;
        const body = options.body && JSON.parse(options.body);
        calls.push({ method: options.method, route, body });
        const text = route === '/flow' ? JSON.stringify({ id: 'temporary-flow' })
            : options.method === 'GET' ? JSON.stringify({ nodes: [{ id: 'inject-id', type: 'inject', name: 'Load scenario settings' }] })
            : options.method === 'POST' ? 'OK' : '';
        return { ok: true, text: async () => text };
    };
    const admin = createAdmin('http://127.0.0.1:1881', fetch, async () => {});
    await admin.loadSettings({ master: true, modes: { hp_er03_restart: 'live' }, heatCurve: { p23: 35, p24: 4 } });
    assert.deepEqual(calls[0].body.nodes[0].wires, [['hpa-fn-01']]);
    const load = calls.find(call => call.route === '/inject/inject-id' && call.body.__user_inject_props__[1].v === 'load');
    assert.equal(load.body.__user_inject_props__[0].vt, 'str');
    const node = loadNode('40 Heat pump automations.js');
    node.run({ topic: 'load', payload: load.body.__user_inject_props__[0].v });
    assert.deepEqual(node.context.get('settings').heatCurve, { p23: 35, p24: 4 });
    const actions = calls.filter(call => call.route === '/inject/inject-id')
        .map(call => ({
            topic: call.body.__user_inject_props__[1].v,
            payload: JSON.parse(call.body.__user_inject_props__[0].v)
        }));
    assert.deepEqual(actions, [
        { topic: 'load', payload: { master: false, heatCurve: { p23: 35, p24: 4 } } },
        { topic: 'ui', payload: { action: 'master', on: false } },
        { topic: 'ui', payload: { action: 'modeAll', mode: 'off' } },
        { topic: 'ui', payload: { action: 'mode', id: 'dhw', mode: 'off' } },
        { topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'off' } },
        { topic: 'ui', payload: { action: 'mode', id: 'hp_er03_restart', mode: 'live' } },
        { topic: 'ui', payload: { action: 'master', on: true } }
    ]);
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.equal(calls.at(-1).route, '/flow/temporary-flow');
});

test('settings remove the temporary flow if the inject node is absent', async () => {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push([options.method, url.pathname]);
        const text = url.pathname === '/flow' ? '{"id":"temporary-flow"}'
            : options.method === 'GET' ? '{"nodes":[]}' : '';
        return { ok: true, text: async () => text };
    };
    const admin = createAdmin('http://127.0.0.1:1881', fetch, async () => {});
    await assert.rejects(admin.loadSettings({ master: true, modes: {} }), /did not deploy/);
    assert.deepEqual(calls.at(-1), ['DELETE', '/flow/temporary-flow']);
});

test('expected_fail scenarios are distinguished from failures and unexpected passes', async () => {
    const failing = {
        name: 'known mismatch',
        faketime: '@2026-11-16 12:00:00',
        expected_fail: 'BUG-heatpump-1',
        steps: [{ when: '0s', settle: '0s', expect: { writes: [{ dps: '133' }] } }]
    };
    const api = {
        post: async () => ({ ok: true }),
        getState: async () => ({}),
        getWrites: async () => []
    };
    const results = await runScenarios([failing, { ...failing, name: 'unexpected pass', steps: [{ when: '0s', settle: '0s', expect: { writes: [] } }] }], {
        api,
        waitReady: false,
        setFaketime: async () => {},
        restoreFaketime: false
    });
    assert.deepEqual(results.map(r => r.status), ['expected_fail', 'fail']);
    const xml = junitXml(results);
    assert.match(xml, /expected_fail: BUG-heatpump-1/);
    assert.match(xml, /name="unexpected pass" time="[\d.]+"><failure/);
});

test('trivial scenario YAML is checked in and matches the runner smoke contract', () => {
    const file = path.join(__dirname, '..', 'tools', 'test-gx', 'scenarios', 'trivial.yml');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.name, trivialScenario().name);
    assert.deepEqual(parsed.steps[0].expect.writes, []);
});

test('all checked-in scenarios parse and validate', () => {
    const scenarios = loadScenarios();
    assert.ok(scenarios.length >= 5);
    assert.ok(scenarios.some(s => s.name === 'Er03 first-step positive control after deploy quiet period'));
    assert.ok(scenarios.some(s => s.name === 'Er03 offline pump guard'));
});

test('the heat pump automation function exposes seven outputs with the documented device ports', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flows.json'), 'utf8'));
    const node = flows.find(n => n.id === 'hpa-fn-01');
    assert.ok(node);
    assert.equal(node.outputs, 7);
    assert.deepEqual(node.wires.map(wire => wire[0]), [
        'hpa-page-01', 'hp-tuya-pump-01', 'hpa-save-file-01', 'hp-tuya-bypass-01',
        'hp-tuya-valve-01', 'hpa-logfile-01', 'hpa-load-file-01'
    ]);
});

test('model, settings-save, log and settings-load outputs use their declared function ports', () => {
    const node = loadNode('40 Heat pump automations.js');
    const now = new Date(2026, 10, 16, 20, 0).getTime();
    const loaded = node.run({ topic: 'load', payload: JSON.stringify({ master: false, modes: {} }) }, { now });
    assert.equal(loaded.result[0].payload.master, false);

    const saved = node.run({ topic: 'ui', payload: { action: 'master', on: true } }, { now });
    assert.equal(saved.result[2].filename, '/data/home/nodered/grid-control-config/heat-pump-automations.json');
    assert.equal(JSON.parse(saved.result[2].payload).master, true);
    assert.ok(saved.sent.some(message => Array.isArray(message) && message[5] && message[5].event.kind === 'setting'));

    node.context.set('needLoad', true);
    const tick = node.run({ topic: 'tick' }, { now });
    assert.ok(tick.sent.some(message => Array.isArray(message) && message[6] && message[6].topic === 'load'));
});

test('automation log requests a day file and groups its events for the UI', () => {
    const node = loadNode('42 Automation log.js');
    const now = new Date(2026, 10, 16, 20, 0).getTime();
    const day = '2026-11-16';
    const request = node.run({ topic: 'ui', payload: { action: 'day', day } }, { now });
    assert.match(request.result[1].payload, /2026-11-16\.jsonl/);
    assert.match(request.result[1].payload, /-mtime \+400/);

    const read = node.run({ topic: 'read', day, payload: [
        { t: now, kind: 'start', rule: 'dhw', cloud: 'DHW controller', run: '1:dhw', live: true, text: 'start' },
        { t: now + 1000, kind: 'write', rule: 'dhw', cloud: 'DHW controller', run: '1:dhw', live: true, text: 'set P23' }
    ].map(JSON.stringify).join('\n') + `\n#days\n2 ${day}.jsonl` }, { now });
    assert.equal(read.result[0].payload.items[0].type, 'run');
    assert.equal(read.result[0].payload.items[0].steps.length, 2);

    const live = node.run({ topic: 'log', event: { t: now + 2000, kind: 'done', rule: 'dhw', run: '1:dhw', live: true, text: 'done' } }, { now: now + 2000 });
    assert.equal(live.result[0].payload.items[0].status, 'ok');
});

test('heat pump alerts wait 10 minutes before digesting a disconnected device', () => {
    const node = loadNode('47 Heat pump alerts.js');
    const now = new Date(2026, 10, 16, 20, 0).getTime();
    const devices = { payload: { devices: [{ role: 'hp', state: 'DISCONNECTED', stale: false }] } };
    assert.equal(node.run({ topic: 'tick', ...devices }, { now }).result, null);
    assert.equal(node.run({ topic: 'tick', ...devices }, { now: now + 9 * 60000 }).result, null);
    assert.equal(node.run({ topic: 'tick', ...devices }, { now: now + 10 * 60000 }).result, null);
    const digest = node.run({ topic: 'tick' }, { now: now + 12 * 60000 });
    assert.match(JSON.parse(digest.result.payload).text, /heat pump DISCONNECTED/);
});

test('deploy window holds while a DHW cycle is active', () => {
    const { judge } = require('../tools/gx/window.js');
    const now = new Date(2026, 10, 16, 20, 0).getTime();
    const result = judge({
        now,
        view: { at: now - 1000 },
        dhw: { state: 'DHW', run: true },
        sequences: {},
        queue: [],
        flag: { on: false },
        hp: { fan: 591, hz: 69, fault: 0 },
        valve: false,
        bypass: false,
        defrostStarts: [now - 122 * 60000, now - 80 * 60000, now - 38 * 60000]
    });
    assert.equal(result.safe, false);
    assert.match(result.wait.join('\n'), /DHW cycle is running/);
});

test('an offline pump is safe for the automation and raises an alert digest', () => {
    const now = new Date(2026, 10, 16, 20, 0).getTime();
    const node = loadNode('40 Heat pump automations.js');
    node.flow.set('heatPump', {
        hp: { state: 'DISCONNECTED', lastData: now, dps: { '1': true, '2': 'mute', '15': 0, '101': 31, '102': 36, '103': -2, '104': 60, '108': 47, '112': 3, '115': 69, '116': 596, '125': 36, '132': '1', '133': 38, '134': 4 } },
        valve: { state: 'CONNECTED', lastData: now, dps: { '1': false } },
        bypass: { state: 'CONNECTED', lastData: now, dps: { '1': false } }
    });
    node.run({ topic: 'load', payload: JSON.stringify({
        master: true,
        modes: { dhw: 'live', heat: 'live', df_exchange_off: 'live', df_exchange_on: 'live', hp_er03_restart: 'live' },
        heatCurve: { p23: 38, p24: 4 }
    }) }, { now });
    node.context.set('lastDefrost', now - 60 * 60000);
    const calls = [
        node.run({ topic: 'tick' }, { now }),
        node.run({ topic: 'tick' }, { now: now + 2 * 60000 })
    ];
    const writes = calls.flatMap(call => call.sent).flatMap(message => Array.isArray(message) ? message : [])
        .filter(message => message && message.payload && message.payload.operation === 'SET');
    assert.deepEqual(writes, []);

    const alerts = loadNode('47 Heat pump alerts.js');
    const events = calls.flatMap(call => call.sent)
        .flatMap(message => Array.isArray(message) ? message : [])
        .map(message => message && message.event)
        .filter(event => event && event.rule === 'hp_device');
    assert.ok(events.some(event => /not connected \/ no data for 2 min/.test(event.text)));
    for (const event of events) alerts.run({ event }, { now: event.t });
    const digest = alerts.run({ topic: 'tick' }, { now: now + 4 * 60000 });
    assert.match(digest.result.payload, /heat pump not connected/);
});

const inputPaths = [
    ...['1', '2', '15', '101', '102', '103', '104', '108', '112', '115', '116', '125', '132', '133', '134']
        .map(dp => ({ role: 'hp', dp })),
    { role: 'valve', dp: '1' },
    { role: 'bypass', dp: '1' }
];
const baseDps = {
    hp: { '1': true, '2': 'mute', '15': 0, '101': 31, '102': 36, '103': -2, '104': 60, '108': 47,
        '112': 3, '115': 69, '116': 596, '125': 36, '132': '1', '133': 38, '134': 4 },
    valve: { '1': false },
    bypass: { '1': false }
};
const now = new Date(2026, 10, 16, 20, 0).getTime();

for (const input of inputPaths) for (const variant of ['missing', 'stale', 'NaN']) {
    test(`${variant} ${input.role} DPS ${input.dp} is guarded`, () => {
            const node = loadNode('40 Heat pump automations.js');
            const devices = Object.fromEntries(['hp', 'valve', 'bypass'].map(role => [role, {
                state: 'CONNECTED', lastData: now, dps: { ...baseDps[role] }
            }]));
            if (variant === 'missing') delete devices[input.role].dps[input.dp];
            if (variant === 'NaN') devices[input.role].dps[input.dp] = Number.NaN;
            if (variant === 'stale') devices[input.role].lastData = now - 5 * 60 * 1000 - 1;
            node.flow.set('heatPump', devices);
            node.run({ topic: 'load', payload: JSON.stringify({
                master: true,
                modes: { dhw: 'live', heat: 'live', df_exchange_off: 'live', df_exchange_on: 'live', hp_er03_restart: 'live' },
                heatCurve: { p23: 38, p24: 4, at: now - 3600000 },
                dhwLastEnd: now - 5 * 3600000
            }) }, { now });
            node.context.set('lastDefrost', now - 60 * 60 * 1000);
            const call = node.run({ topic: 'tick' }, { now });
            const commands = call.sent.flatMap(message => Array.isArray(message) ? message : [])
                .filter(message => message && message.payload && message.payload.operation === 'SET');
            const expected = input.role === 'hp' && input.dp === '132' && variant !== 'stale'
                ? [{ payload: { operation: 'SET', dps: 132, set: '1' } }]
                : [];
            assert.deepEqual(commands, expected, `${variant} ${input.role} DPS ${input.dp} should use the safe behavior`);
    });
}
