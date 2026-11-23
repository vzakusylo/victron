'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
    assertChangedWrites, assertOutputs, ScenarioAssertionError, createAdmin, faketimeRate, loadScenarios, parseDuration, runScenario
} = require('../tools/test-gx/run-scenarios');
const { preserveController, CONTEXT_KEYS, contextBridgeSource } = require('../tools/test-gx/scenario-controller');
const { loadNode, loadGrid } = require('./harness');

// Read-back faults require a real D-Bus fixture; this replay covers decisions only.
for (const scenario of loadScenarios().filter(item => item.controller &&
    item.steps.some(step => step.expect.outputs || step.expect.writes) &&
    ![item.initial, ...item.steps].some(step => Object.values(step?.fail || {}).includes('ignore-write')))) {
    test(`controller fixture: ${scenario.name}`, () => {
        const controller = loadGrid();
        const protection = loadNode('06 Apply HV settings.js');
        const start = new Date(scenario.faketime.slice(1, 20).replace(' ', 'T')).getTime();
        let inputs = { batt_v: 50, consumed_ah: -112, grid_w: 1000, load_w: 800, pv_w: 0,
            ...scenario.initial?.inputs };
        let freshForecast;
        const applyProtection = value => {
            const result = protection.run({ payload: JSON.stringify({
                start: 55.2, release: 55, full: 55.4, exportGuardEnabled: false, ...value
            }) }, { now: start });
            controller.flow.set('highVoltageSettings', result.result[0].payload);
        };
        applyProtection(scenario.controller.protection || {});
        const topics = { consumed_ah: 'battery-consumed-ah', batt_v: 'battery-voltage',
            grid_w: 'grid-power', load_w: 'ac-load-power', pv_w: 'pv-charger-power' };
        const sources = { batt_v: 'battery./Dc/0/Voltage', consumed_ah: 'battery./ConsumedAmphours',
            grid_w: 'system./Ac/Grid/L1/Power', load_w: 'system./Ac/Consumption/L1/Power', pv_w: 'system./Dc/Pv/Power' };
        const staleUntil = new Map();
        for (const [index, step] of scenario.steps.entries()) {
            const at = start + parseDuration(step.when);
            inputs = { ...inputs, ...step.inputs };
            for (const [source, seconds] of Object.entries(step.stale || {})) {
                staleUntil.set(source, at + seconds * 1000 * faketimeRate(scenario.faketime));
            }
            const action = step.controller || {};
            if (action.protection) applyProtection(action.protection);
            if (action.refreshForecast) {
                const shade = loadNode('08 Adjust solar forecast for shade.js');
                const store = loadNode('09 Store solar prediction.js');
                const day = scenario.faketime.slice(1, 11);
                const result = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [
                    `${day} ${String(hour).padStart(2, '0')}:00:00`,
                    hour >= 11 && hour <= 17 ? scenario.controller.forecastWatts : 0
                ]));
                const adjusted = shade.run({ payload: { result } }, { now: at }).result;
                store.run(adjusted, { now: at });
                freshForecast = store.flow.get('solarForecastToday');
                controller.flow.set('solarForecastToday', freshForecast);
                controller.flow.set('solarForecastAdjusted', store.flow.get('solarForecastAdjusted'));
            }
            if (action.forecastFault) {
                const summary = { ...freshForecast };
                const hours = { stale: 19, future: -1 };
                if (action.forecastFault === 'nan') summary.energyKWh = Number.NaN;
                else if (action.forecastFault === 'previous-day') {
                    const previous = new Date(at);
                    previous.setDate(previous.getDate() - 1);
                    previous.setHours(23, 0, 0, 0);
                    summary.updatedAt = previous.toISOString();
                }
                else summary.updatedAt = new Date(at - hours[action.forecastFault] * 3600000).toISOString();
                controller.flow.set('solarForecastToday', summary);
            }
            if (action.command) controller.run(action.command, { now: at });
            let last;
            for (let second = 0; second <= parseDuration(step.settle) / 1000; second++) {
                for (const [key, topic] of Object.entries(topics)) {
                    const now = at + second * 1000;
                    if (staleUntil.get(sources[key]) > now) continue;
                    last = controller.run({ topic, payload: inputs[key] }, { now });
                }
            }
            const values = {
                '/Settings/SystemSetup/MaxChargeCurrent': last.result[0].payload,
                '/Settings/CGwacs/AcPowerSetPoint': last.result[1].payload,
                '/Ac/In/1/CurrentLimit': controller.context.get('gridCurrentLimitA')
            };
            const fractionalCurrent = {
                'charging HV full voltage scales scheduled current': 5.1,
                'charging day high load reduces scheduled current proportionally': 24.5,
                'charging HV grid support also scales the current': 2.5
            }[scenario.name];
            if (fractionalCurrent !== undefined && step === scenario.steps[0]) {
                assert.equal(values['/Settings/SystemSetup/MaxChargeCurrent'], fractionalCurrent);
            }
            const expectations = [...(step.expect.writes || []), ...(step.expect.outputs || [])];
            if (index + 1 === scenario.expected_fail_step) {
                assert.ok(expectations.some(expected => values[expected.path] !== expected.value),
                    `${scenario.name}: safe-mode assertions now pass; remove expected_fail`);
            } else {
                for (const expected of expectations) {
                    assert.equal(values[expected.path], expected.value, `${scenario.name} at ${step.when}: ${expected.path}`);
                }
            }
        }
    });
}

test('change-only D-Bus assertions check final state, missing changes, extra changes and ordered changes', () => {
    const target = { service: 'settings', path: '/Settings/SystemSetup/MaxChargeCurrent' };
    const state = value => ({ outputs: [{ ...target, value }] });
    const expected = [{ ...target, value: 25 }];
    assert.throws(() => assertChangedWrites([], expected, state(25), state(25), 'charge', 1),
        /if_changed requires a new write/);
    assertChangedWrites(expected, expected, state(0), state(25), 'charge', 1);
    assert.throws(() => assertChangedWrites(expected, expected, state(0), state(0), 'charge', 1), /final .* expected 25/);
    assert.throws(() => assertChangedWrites([], expected, state(0), state(25), 'charge', 1), ScenarioAssertionError);
    assert.throws(() => assertChangedWrites([...expected, { ...target, value: 0 }], expected,
        state(0), state(25), 'charge', 1), /expected 1 writes, received 2/);
    assert.throws(() => assertChangedWrites([], expected, {}, state(25), 'charge', 1), /require emulator/);
    assert.throws(() => assertChangedWrites([], expected, state(25),
        { outputs: [{ ...target, value: 25, error: 'settings unavailable' }] }, 'charge', 1), /Cannot read emulator output/);
});

test('no-change scenario steps can still assert final actuator outputs', () => {
    const target = { service: 'settings', path: '/Settings/SystemSetup/MaxChargeCurrent', value: 0 };
    assertOutputs({ outputs: [target] }, [target], 'charge', 1);
    assert.throws(() => assertOutputs({ outputs: [{ ...target, value: 25 }] }, [target], 'charge', 1),
        /final .* expected 0, received 25/);
    assert.throws(() => assertOutputs({ outputs: [{ ...target, error: 'settings unavailable' }] }, [target], 'charge', 1),
        /settings unavailable/);
});

test('charging stops Node-RED and resets actuators before startup, so a preceding result cannot satisfy the case', async () => {
    const calls = [];
    const target = { service: 'settings', path: '/Settings/SystemSetup/MaxChargeCurrent' };
    const writes = [];
    const scenario = {
        name: 'fresh actuator baseline', faketime: '@2026-11-16 08:00:00',
        controller: {}, observe: [target],
        steps: [{ when: '0s', settle: '0s', expect: { if_changed: true, writes: [{ ...target, value: 25 }] } }]
    };
    let dvcc = 25;
    let applyOutput = true;
    const options = {
        waitReady: false, wait: async () => {},
        stopNodeRed: async () => { calls.push('stop'); },
        setFaketime: async value => { calls.push(['start', value]); },
        api: {
            post: async (route, body) => {
                calls.push([route, body]);
                if (body.outputs) {
                    dvcc = -1;
                    writes.length = 0;
                }
            },
            getState: async () => ({ outputs: [
                { ...target, value: dvcc },
                { service: 'settings', path: '/Settings/CGwacs/AcPowerSetPoint', value: 0 },
                { service: 'vebus', path: '/Ac/In/1/CurrentLimit', value: 25 }
            ] }),
            getWrites: async () => writes
        },
        admin: {
            verifyDeployed: async () => {},
            preserveSettings: async () => ({ restore: async () => {} }),
            preserveController: async () => ({
                restore: async () => {},
                apply: async () => {
                    if (applyOutput) {
                        dvcc = 25;
                        writes.push({ ...target, value: 25 });
                    }
                }
            })
        }
    };
    await runScenario(scenario, options);
    assert.deepEqual(calls.slice(0, 3), ['stop', ['/reset', { outputs: true }], ['start', scenario.faketime]]);
    applyOutput = false;
    await assert.rejects(runScenario(scenario, options), /expected 1 writes, received 0/);
    options.api.post = async () => { throw Error('reset unavailable'); };
    const beforeResetFailure = calls.length;
    await assert.rejects(runScenario(scenario, options), /reset unavailable/);
    assert.deepEqual(calls.slice(beforeResetFailure), ['stop', ['start', '']]);
});

test('an abort during preserveController still lets restore() run', async () => {
    const target = { service: 'settings', path: '/Settings/SystemSetup/MaxChargeCurrent' };
    const scenario = {
        name: 'abort in preserve', faketime: '@2026-11-16 08:00:00', controller: {}, observe: [target],
        steps: [{ when: '0s', settle: '0s', expect: { writes: [] } }]
    };
    const abort = new AbortController();
    let restored = false;
    const options = {
        waitReady: false, wait: async () => {}, signal: abort.signal,
        stopNodeRed: async () => {},
        setFaketime: async () => {},
        api: {
            post: async () => {},
            getState: async () => ({ outputs: [
                { ...target, value: -1 },
                { service: 'settings', path: '/Settings/CGwacs/AcPowerSetPoint', value: 0 },
                { service: 'vebus', path: '/Ac/In/1/CurrentLimit', value: 25 }
            ] }),
            getWrites: async () => []
        },
        admin: {
            verifyDeployed: async () => {},
            preserveSettings: async () => ({ restore: async () => {} }),
            preserveController: async () => {
                abort.abort(new Error('timed out'));
                await new Promise(resolve => setTimeout(resolve, 20));
                return { restore: async () => { restored = true; }, apply: async () => {} };
            }
        }
    };
    await assert.rejects(runScenario(scenario, options), /timed out/);
    assert.equal(restored, true);
});

test('actuator reset checks D-Bus results without closing the shared connection', () => {
    execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-c', `
import ast, sys, types
source = ast.parse(open(sys.argv[1], encoding='utf-8').read())
function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'reset_outputs')
calls = []
class Item:
    def __init__(self, path): self.path = path
    def SetValue(self, value, **kw):
        calls.append((self.path, value))
        return return_code[0]
class Bus:
    def get_object(self, service, path): return Item(path)
    def close(self): calls.append('closed')
return_code = [0]
services = {'vebus': {}}
namespace = {
    'dbus': types.SimpleNamespace(SystemBus=lambda: Bus(), Double=float), 'services': services,
    'ActuatorResetError': type('ActuatorResetError', (RuntimeError,), {})}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<reset_outputs>', 'exec'), namespace)
namespace['reset_outputs']()
assert calls == [
    ('/Settings/SystemSetup/MaxChargeCurrent', -1.0),
    ('/Settings/CGwacs/AcPowerSetPoint', 0.0)]
assert services['vebus']['/Ac/In/1/CurrentLimit'] == 25.0
return_code[0] = 1
try:
    namespace['reset_outputs']()
except RuntimeError:
    pass
else:
    raise AssertionError('failed D-Bus reset was accepted')
assert 'closed' not in calls
`, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator', 'emulator.py')], { stdio: 'pipe' });
});

test('actuator snapshots report unavailable services instead of synthesizing valid defaults', () => {
    execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-c', `
import ast, sys, types
source = ast.parse(open(sys.argv[1], encoding='utf-8').read())
functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
             and node.name in ('settings_value', 'actuator_outputs')]
class ReadError(Exception): pass
class Item:
    def GetValue(self, **kw):
        if broken[0]: raise ReadError('settings unavailable')
        return 12
class Bus:
    def get_object(self, *args): return Item()
broken = [False]
services = {'vebus': {'/Ac/In/1/CurrentLimit': 13.5}}
namespace = {'dbus': types.SimpleNamespace(SystemBus=Bus, DBusException=ReadError), 'services': services}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<actuator_outputs>', 'exec'), namespace)
assert [item['value'] for item in namespace['actuator_outputs']()] == [12, 12, 13.5]
broken[0] = True
services.clear()
actual = namespace['actuator_outputs']()
assert all(item['value'] is None and item['error'] for item in actual)
assert namespace['settings_value']('path', 42) == 42
`, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator', 'emulator.py')], { stdio: 'pipe' });
});

test('emulator property freeze leaves sibling sensors live and expires on the emulator clock', () => {
    execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-c', `
import ast, sys, types
source = ast.parse(open(sys.argv[1], encoding='utf-8').read())
function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'publish')
grid, pv = '/Ac/Grid/L1/Power', '/Dc/Pv/Power'
system = {grid: -200, pv: 2000}
clock = [10]
namespace = {
    'services': {'system': system}, 'time': types.SimpleNamespace(time=lambda: clock[0]),
    'state': {'load_w': 1000, 'pv_w': 500, 'soc': 60}, 'failed': {},
    'computed': {'grid_w': 1000, 'batt_v': 54, 'batt_a': 0, 'batt_w': 0},
    'stale_until': {'system.' + grid: 20},
    'bms': {'active': False}, 'BMS_SERVICE': 'com.victronenergy.battery.ttyTEST',
}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<publish>', 'exec'), namespace)
namespace['publish']('system')
assert (system[grid], system[pv]) == (-200, 500)
clock[0] = 20
namespace['publish']('system')
assert system[grid] == 1000
`, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator', 'emulator.py')], { stdio: 'pipe' });
});

test('controller input checks reject accepted emulator values that never reached the function', async () => {
    const values = { batteryVoltage: 54, batteryConsumedAh: 100, gridPowerW: -200,
        acLoadPowerW: 0, pvChargerPowerW: 500 };
    const admin = createAdmin(undefined, async url => {
        const key = url.pathname.split('/').at(-1);
        const value = values[key];
        return { ok: true, text: async () => JSON.stringify(value === undefined
            ? { format: 'undefined', msg: '(undefined)' } : { format: 'number', msg: String(value) }) };
    });
    const inputs = { batt_v: 54, consumed_ah: -100, grid_w: -200, load_w: -10, pv_w: 500 };
    await admin.verifyControllerInputs(inputs);
    values.batteryVoltage = 50;
    await assert.rejects(admin.verifyControllerInputs(inputs), /stale batt_v/);
    delete values.batteryVoltage;
    await assert.rejects(admin.verifyControllerInputs(inputs), /not received batt_v/);
});

test('raw forecast fixtures validate dates and watts and keep the real parser response shape', () => {
    execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
from forecast_fixture import forecast_fixture
response = forecast_fixture({'date': ['2026-11-16'], 'watts': ['500']})
assert len(response['result']) == 24
assert response['result']['2026-11-16 12:00:00'] == 500
assert response['result']['2026-11-16 02:00:00'] == 0
assert response['message']['ratelimit']['remaining'] == 11
for query in [
    {'date': ['2026-02-30']}, {'date': ['2026-1-2']},
    {'date': ['2026-11-16'], 'watts': ['nan']},
    {'date': ['2026-11-16'], 'watts': ['-1']},
    {'date': ['2026-11-16'], 'watts': ['20001']}
]:
    try:
        forecast_fixture(query)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid forecast query accepted')
`, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator')], { stdio: 'pipe' });
});

test('the separate context helper restores absence and preserves a real zero forecast', () => {
    const values = new Map([
        ['highVoltageSettings', { enabled: false }],
        ['controllerConstantsOverrides', { maxChargeCurrent: 12 }],
        ['solarForecastToday', { energyKWh: 0, updatedAt: '2026-11-16T08:00:00Z' }]
    ]);
    const local = new Map();
    const store = map => ({ get: key => map.get(key), set: (key, value) =>
        value === undefined ? map.delete(key) : map.set(key, value) });
    const bridge = new Function('msg', 'flow', 'context', 'node', contextBridgeSource());
    const run = payload => bridge({ payload }, store(values), store(local), { error() {} });
    const original = run({ action: 'snapshot' }).payload;
    assert.deepEqual(original.solarForecastAdjusted, { exists: false });
    assert.equal(run({ action: 'remember', requirePositive: false }).statusCode, undefined);
    assert.equal(run({ action: 'remember', requirePositive: true }).statusCode, 500);
    run({ action: 'reset' });
    assert.equal(values.has('solarForecastToday'), false);
    assert.deepEqual(values.get('controllerConstantsOverrides'), {});
    assert.deepEqual(run({ action: 'restore', context: original }).payload, original);
    assert.equal(run({ action: 'fault', fault: 'nan' }).statusCode, undefined);
    assert.equal(Number.isNaN(values.get('solarForecastToday').energyKWh), true);
});

test('controller preservation snapshots before injecting and restores keys, URL and temporary nodes', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-controller-test-'));
    const nodes = [
        { id: 'controller', z: 'main', name: 'Battery + Grid Controller', type: 'function' },
        { id: 'protection', name: 'Apply HV settings', type: 'function' },
        { id: 'refresh', name: 'Refresh solar forecast 15m', type: 'inject' },
        { id: 'forecast', name: 'Solar forecast Hokksund', type: 'subflow:forecast-template' },
        { id: 'http', z: 'forecast-template', type: 'http request', url: '' }
    ];
    let deployed = structuredClone(nodes);
    const calls = [];
    const originalContext = Object.fromEntries(CONTEXT_KEYS.map(key => [key, { exists: false }]));
    const request = async (method, route, body, headers) => {
        calls.push({ method, route, body, headers });
        if (route === '/flows' && method === 'GET') return { rev: 'revision', flows: structuredClone(deployed) };
        if (route === '/flows' && method === 'POST') { deployed = structuredClone(body.flows); return { rev: 'new-revision' }; }
        if (route.startsWith('/context/')) return { format: 'undefined', msg: '(undefined)' };
        if (route.startsWith('/test-gx-controller-')) return originalContext;
    };
    try {
        const session = await preserveController(request, async () => {}, {
            faketime: '@2026-11-16 08:00:00', controller: { forecastWatts: 500 }
        }, { backupDirectory: root });
        const backup = JSON.parse(fs.readFileSync(session.backupPath, 'utf8'));
        assert.deepEqual(backup.flows.flows, nodes);
        assert.deepEqual(backup.context, originalContext);
        assert.equal(deployed.find(node => node.id === 'http').url, 'http://venus:8081/forecast?date=2026-11-16&watts=500');
        await session.apply({ protection: { forceChargeEnabled: true, forceChargeGridW: 1000 }, refreshForecast: true });
        const protection = calls.find(call => call.route.endsWith('-protection'));
        assert.equal(protection.body.__user_inject_props__[0].vt, 'str');
        const firstDeployment = calls.findIndex(call => call.method === 'POST' && call.route === '/flows');
        assert.ok(calls.slice(0, firstDeployment).filter(call => call.route.startsWith('/context/')).length === CONTEXT_KEYS.length);
        assert.ok(calls.filter(call => call.method === 'POST' && call.route === '/flows')
            .every(call => call.headers['Node-RED-Deployment-Type'] === 'nodes'));
        await session.restore();
        assert.deepEqual(deployed, nodes);
        const concurrent = await preserveController(request, async () => {}, {
            faketime: '@2026-11-16 08:00:00', controller: { forecastWatts: 500 }
        }, { backupDirectory: root });
        deployed.find(node => node.id === 'http').url = 'http://other-test-source.invalid';
        await assert.rejects(concurrent.restore(), /changed concurrently; preserved that edit/);
        assert.equal(deployed.find(node => node.id === 'http').url, 'http://other-test-source.invalid');
        assert.equal(deployed.some(node => node.id.startsWith('tgx-controller-')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
