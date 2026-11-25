'use strict';
process.env.TZ = 'Europe/Oslo';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { loadNode, readSource } = require('./harness');

const file = '01 Battery + Grid Controller.js';
const cadence = 'grid-control-tick';
const settings = 'com.victronenergy.settings';
const dvccPath = '/Settings/SystemSetup/MaxChargeCurrent';
const essPath = '/Settings/CGwacs/AcPowerSetPoint';
const veBusPath = '/Ac/In/1/CurrentLimit';
const date = Date.parse('2026-11-18T23:59:40+01:00');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeBus(invoke, listNames) {
    const connection = new EventEmitter();
    const calls = [];
    let closed = 0;
    connection.stream = { end: () => closed++ };
    return {
        connection, calls, listNames,
        get closed() { return closed; },
        invoke(request, callback) {
            calls.push(request);
            invoke(request, callback);
        }
    };
}

function readback(bus, address) {
    let transport;
    let deadline;
    let cleared = false;
    const dbus = {
        systemBus() { transport = 'system'; return bus; },
        createClient(options) { transport = options; return bus; }
    };
    const [read, channels] = new Function('dbus', 'env', 'setTimeout', 'clearTimeout',
        `${readSource('lib/grid/readback.js')}\nreturn [readGridOutput, feedbackChannels];`)(
        dbus, { get: key => key === 'DBUS_SYSTEM_BUS_ADDRESS' ? address : undefined },
        (cb, ms) => deadline = { cb, ms }, timer => { cleared = timer === deadline; }
    );
    return {
        read: i => read(channels[i]),
        get transport() { return transport; },
        get deadline() { return deadline; },
        get cleared() { return cleared; }
    };
}

test('settings read-back selects the native or anonymous TCP bus and closes it', async () => {
    const address = 'tcp:host=localhost,port=12345';
    for (const [i, busAddress, transport, path] of [
        [0, undefined, 'system', dvccPath],
        [0, 'unix:path=/run/dbus/system_bus_socket', 'system', dvccPath],
        [1, address, { busAddress: address, authMethods: ['ANONYMOUS'] }, essPath]
    ]) {
        const bus = fakeBus((_, cb) => cb(null, ['d', [0]]));
        const reader = readback(bus, busAddress);
        assert.deepEqual(await reader.read(i), { value: 0 });
        assert.deepEqual(reader.transport, transport);
        assert.deepEqual(bus.calls, [{ destination: settings, path, interface: 'com.victronenergy.BusItem', member: 'GetValue' }]);
        assert.equal(reader.cleared, true);
        assert.equal(bus.closed, 1);
    }
});

test('VE.Bus read-back ignores unrelated names, other instances and failed lookups', async () => {
    const names = ['other.service', ...['dead', 'wrong', 'right'].map(name => `com.victronenergy.vebus.${name}`)];
    const bus = fakeBus(({ destination, path }, cb) => {
        if (path === veBusPath) cb(null, ['d', [21.5]]);
        else if (destination === names[1]) cb('No owner');
        else cb(null, ['i', [destination === names[3] ? 276 : 1]]);
    }, cb => cb(null, names));
    assert.deepEqual(await readback(bus).read(2), { value: 21.5 });
    assert.deepEqual(bus.calls.map(({ destination, path }) => [destination, path]), [
        ...names.slice(1).map(name => [name, '/DeviceInstance']), [names[3], veBusPath]
    ]);
});

for (const [name, instances] of [['missing', [1, '276']], ['ambiguous', [276, 276]]]) {
    test(`VE.Bus read-back rejects ${name} instance selection`, async () => {
        const names = instances.map((_, i) => `com.victronenergy.vebus.device${i}`);
        const bus = fakeBus(({ destination }, cb) => cb(null, ['i', [instances[names.indexOf(destination)]]]),
            cb => cb(null, names));
        const reader = readback(bus);
        await assert.rejects(reader.read(2), /instance 276 unavailable or ambiguous/);
        assert.ok(bus.calls.every(({ path }) => path === '/DeviceInstance'));
        assert.equal(reader.cleared, true);
        assert.equal(bus.closed, 1);
    });
}

test('bus callback errors and missing or non-numeric read values reject the read', async () => {
    const listBus = fakeBus(() => assert.fail('must not read when listing fails'), cb => cb('Failed to enumerate'));
    await assert.rejects(readback(listBus).read(2), /Failed to enumerate/);
    const invokeBus = fakeBus((_, cb) => cb('Settings service unavailable'));
    await assert.rejects(readback(invokeBus).read(0), /Settings service unavailable/);
    for (const value of [undefined, ['d', []], ['s', ['10']], ['d', [Infinity]]]) {
        const bus = fakeBus((_, cb) => cb(null, value));
        await assert.rejects(readback(bus).read(1), /no numeric value/);
    }
});

for (const [failure, message] of [
    ['end', 'D-Bus disconnected'],
    ['error', 'Socket reset'],
    ['timeout', 'D-Bus read-back timed out']
]) {
    test(`in-flight D-Bus read rejects and closes on ${failure}`, async () => {
        const bus = fakeBus(() => {});
        const reader = readback(bus);
        const pending = reader.read(0);
        assert.equal(reader.deadline.ms, 3000);
        if (failure === 'timeout') reader.deadline.cb();
        else bus.connection.emit(failure, new Error('Socket reset'));
        await assert.rejects(Promise.race([pending, flush()]), { message });
        assert.equal(reader.cleared, true);
        assert.equal(bus.closed, 1);
    });
}

const advance = new Function(`${readSource('lib/grid/feedback.js')}\nreturn advanceGridFeedback;`)();

test('feedback does not write unavailable targets, but still verifies and probes prior writes', () => {
    const step = (state, now, value, reading) => advance(state, { now, value, reading, gap: 0, tolerance: 0 });
    const start = step(undefined, 0, undefined);
    assert.equal(start.write, undefined);
    const queued = step(start.state, 1, 0);
    assert.equal(queued.write, 0);
    const reading = step(queued.state, 4001, NaN);
    assert.equal(reading.read, true);
    const verified = step(reading.state, 4002, Infinity, { value: 0 });
    assert.equal(verified.state.phase, 'verified');
    assert.equal(verified.write, undefined);
    const failed = { ...verified.state, phase: 'failed', fault: 'mismatch', due: 14002 };
    assert.equal(step(failed, 14001, undefined).read, undefined);
    assert.equal(step(failed, 14002, undefined).read, true);
});

test('feedback gives a changed target a fresh retry budget and reports the read error', () => {
    const step = (state, now, value, reading) => advance(state, { now, value, reading, gap: 0, tolerance: 0 });
    const old = { phase: 'failed', value: 100, sent: 0, retried: true, fault: 'prior failure', due: 10000 };
    const queued = step(old, 10000, 200);
    assert.equal(queued.write, 200, 'a due probe must not block a new target');
    const read = step(queued.state, 14000, 200);
    const retry = step(read.state, 14001, 200, { error: 'Socket reset' });
    assert.equal(retry.write, 200);
    const retried = step(retry.state, 18001, 200);
    const failed = step(retried.state, 18002, 200, { error: 'Socket reset' });
    assert.equal(failed.state.fault, 'expected 200; Socket reset');
    assert.equal(failed.alarm, undefined, 'the existing incident is still active');
    assert.equal(failed.state.due, 28002);
});

function controller(bus, ready = true) {
    let elapsed = 0;
    // Keep writer pacing independent of the tick's wall clock, including hour changes.
    const gridClock = { hrtime: { bigint: () => BigInt(elapsed) * 1000000n } };
    const node = loadNode(file, undefined, undefined, { dbus: { systemBus: () => bus }, gridClock });
    const run = (topic, wall, payload, ms = elapsed) => {
        elapsed = ms;
        return node.run({ topic, payload }, { now: date + wall });
    };
    if (ready) {
        run('battery-voltage', -100, 54);
        run('battery-consumed-ah', -90, 0);
        run('grid-power', -80, 500);
    }
    return {
        ...node, run,
        tick(ms, wall = ms) { return run(cadence, wall, undefined, ms); }
    };
}

function readingBus(callback) {
    return fakeBus(({ path }, cb) => path === '/DeviceInstance' ? cb(null, ['i', [276]]) : callback(path, cb),
        cb => cb(null, ['com.victronenergy.vebus.test']));
}

test('verified DVCC and ESS refresh on monotonic pacing, VE.Bus on a new hour only', async () => {
    const values = new Map();
    const control = controller(readingBus((path, cb) => cb(null, ['d', [values.get(path)]])));
    const first = control.tick(0).result;
    values.set(dvccPath, first[0].payload + 0.005);
    values.set(essPath, first[1].payload);
    values.set(veBusPath, first[2].payload + 0.005);
    control.tick(4000);
    await flush();
    assert.deepEqual(control.tick(10099, -5000).result.slice(0, 3), [null, null, null]);
    assert.deepEqual(control.tick(10100, -4999).result.slice(0, 3), [first[0], first[1], null]);
    control.tick(14100, -999);
    await flush();
    assert.deepEqual(control.tick(14101, 20000).result.slice(0, 3), [null, null, first[2]]);
});

test('a failed VE.Bus limit is reasserted once on a new hour', async () => {
    const values = new Map();
    const control = controller(readingBus((path, cb) => cb(null, ['d', [values.get(path)]])));
    const first = control.tick(0).result;
    values.set(dvccPath, first[0].payload);
    values.set(essPath, first[1].payload);
    values.set(veBusPath, first[2].payload - 1);
    control.tick(4000);
    await flush();
    assert.deepEqual(control.tick(6000).result[2], first[2]);
    control.tick(10000);
    await flush();
    const failed = control.tick(12000);
    assert.match(failed.result[3].payload, /VE\.Bus: expected/);
    assert.equal(failed.result[2], null);
    assert.deepEqual(control.tick(20000).result[2], first[2]);
    control.tick(24000);
    await flush();
    const stillFailed = control.tick(26000).result;
    assert.equal(stillFailed[2], null);
    assert.equal(stillFailed[3], null);
    assert.equal(stillFailed[9].payload.outputs[2].phase, 'failed');
});

test('cadence publishes its monotonic heartbeat but an immediate CT decision does not', () => {
    const control = controller();
    control.tick(99);
    assert.equal(control.flow.get('gridDecisionPulse'), 99);
    const step = control.run('grid-power', 200, 2000, 150);
    assert.ok(step.result[7].tick.decision);
    assert.equal(control.flow.get('gridDecisionPulse'), 99);
    control.tick(250, -1000);
    assert.equal(control.flow.get('gridDecisionPulse'), 250);
});

for (const [label, replace] of [
    ['not reading', { phase: 'pending' }],
    ['a newer send is pending verification', { sent: 1 }]
]) {
    test(`output stage discards a stale read callback when ${label}`, async () => {
        let finishEss;
        const control = controller(readingBus((path, cb) => {
            if (path === essPath) finishEss = cb;
            else cb(null, ['d', [0]]);
        }));
        control.tick(0);
        control.tick(4000);
        const states = control.context.get('gridWriteFeedback');
        const current = { ...states[1], ...replace };
        control.context.set('gridWriteFeedback', [states[0], current, states[2]]);
        finishEss(null, ['d', [states[1].value]]);
        await flush();
        assert.equal(current.reading, undefined);
    });
}

test('write failures surface one combined alarm, then matching probes clear status', async () => {
    const values = new Map();
    let recover = false;
    let dvccReads = 0;
    const control = controller(readingBus((path, cb) => {
        if (recover || path === veBusPath) cb(null, ['d', [values.get(path)]]);
        else if (path === dvccPath) {
            if (dvccReads++ === 0) throw 'Cannot connect';
            cb('Settings unavailable');
        } else cb(null, ['d', [values.get(path) + 0.005]]);
    }));
    const first = control.tick(0).result;
    [dvccPath, essPath, veBusPath].forEach((path, i) => values.set(path, first[i].payload));
    control.tick(4000);
    await flush();
    const retry = control.tick(10100).result;
    assert.deepEqual(retry.slice(0, 3), [first[0], first[1], null]);
    assert.deepEqual(retry[9].payload.outputs[0].read, { value: null, state: 'Read failed', error: 'Cannot connect' });
    control.tick(14100);
    await flush();
    const failed = control.tick(16100);
    const dvccFault = `expected ${values.get(dvccPath)}; Settings unavailable`;
    const essFault = `expected ${values.get(essPath)}; read ${values.get(essPath) + 0.005}`;
    const text = `grid not following setpoint: DVCC: ${dvccFault}; ESS: ${essFault}`;
    const event = { t: date + 16100, kind: 'fail', rule: 'grid_feedback', live: true, text };
    assert.deepEqual(failed.status, { fill: 'red', shape: 'dot', text });
    assert.deepEqual(control.context.get('gridFeedbackAlarm'), { text });
    assert.deepEqual(failed.result[3], { notification: { title: 'Grid control', type: 'alarm', message: text }, payload: text });
    assert.deepEqual(failed.result[8], {
        topic: 'log', filename: '/data/home/nodered/grid-control-logs/automations/2026-11-18.jsonl',
        payload: JSON.stringify(event) + '\n', event
    });
    const snapshot = failed.result[9].payload;
    assert.equal(snapshot.feedbackAlerts, 1);
    assert.deepEqual(snapshot.outputs[0], {
        value: values.get(dvccPath), sentAt: date + 10100, phase: 'failed', fault: dvccFault,
        read: { value: null, state: 'Read failed', error: 'Settings unavailable' }
    });
    assert.deepEqual(snapshot.outputs[1].read, { value: values.get(essPath) + 0.005, state: 'Mismatch' });
    const persistent = control.tick(18100).result;
    assert.deepEqual([persistent[3], persistent[8], persistent[9]], [null, null, null]);
    recover = true;
    control.tick(26100, 19000);
    await flush();
    const recovered = control.tick(28100, 19100);
    assert.notEqual(recovered.status.fill, 'red');
    assert.deepEqual(control.context.get('gridFeedbackAlarm'), { text: '' });
    assert.equal(recovered.result[9].payload.feedbackAlerts, 1);
    assert.deepEqual(recovered.result[9].payload.outputs[0].read, { value: values.get(dvccPath), state: 'Match' });
    assert.equal(recovered.result[9].payload.outputs[0].fault, '');
});

test('waiting dashboard omits targets, retains sensor arrival times and includes loop health', () => {
    const control = controller(undefined, false);
    control.run('battery-voltage', -500, 54);
    control.run('grid-power', -100, 0);
    const first = control.tick(0).result;
    assert.deepEqual(first.slice(0, 3), [null, null, null]);
    const snapshot = first[9].payload;
    assert.deepEqual(snapshot, {
        decision: 'Waiting', reason: 'WAITING FOR BMS CONSUMED AH', targets: null,
        arrivals: [date - 500, null, date - 100, null, null, null],
        outputs: Array(3).fill({ value: null, sentAt: null, phase: 'not sent', fault: '', read: null }),
        safeMode: 'not implemented', feedbackAlerts: 0, heartbeatAlerts: 0, cadenceMs: null, lagMs: null,
        reportedAt: date
    });
    control.flow.set('gridLoopHealth', { alerts: 2, intervalP95Ms: 2001, lagP95Ms: 12 });
    const updated = control.tick(2000).result[9].payload;
    assert.deepEqual(updated, { ...snapshot, heartbeatAlerts: 2, cadenceMs: 2001, lagMs: 12, reportedAt: date + 2000 });
});

test('dashboard reasons prefer waiting text, then ordered limits, then the schedule', () => {
    const { gridDashboardSnapshot } = new Function('SENSOR_KEYS',
        `${readSource('lib/grid/dashboard.js')}\nreturn { gridDashboardSnapshot };`)(new Map());
    const decision = { windowName: 'NIGHT', finalChargeCurrent: 0, finalGridSetpoint: 1000, gridCurrentLimitA: 10 };
    const limited = { ...decision, limitFlags: ['HV', 'Export guard'] };
    assert.equal(gridDashboardSnapshot(limited, 'Waiting for battery').reason, 'Waiting for battery');
    const snapshot = gridDashboardSnapshot(limited);
    assert.equal(snapshot.reason, 'HV / Export guard');
    assert.equal(snapshot.decision, 'NIGHT');
    assert.deepEqual(snapshot.targets, [0, 1000, 10]);
    assert.equal(gridDashboardSnapshot(decision).reason, 'Tariff and charge schedule');
});
