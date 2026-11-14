'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'tools', 'tuya-cloud-sensors.js'), 'utf8');
const DIR = '/data/home/nodered/grid-control-config/';
const EVENTS = '/data/home/nodered/grid-control-logs/sensor-events/';
const ID = 'test-motion-sensor';
const NOW = Date.parse('2026-11-14T13:00:00Z');
const meta = { [ID]: { name: 'Motion Sensor', battery: true, cloudOnline: true, dps: { 101: { code: 'pir_state' } } } };

async function run(pages, { previous = {}, files = new Map(), now = NOW } = {}) {
    files = new Map(files);
    files.set(DIR + 'tuya-cloud.json', JSON.stringify({ accessId: 'test-id', accessSecret: 'test-secret', endpoint: 'https://example.invalid' }));
    files.set(DIR + 'tuya-devices-meta.json', JSON.stringify(meta));
    files.set(DIR + 'tuya-devices-cloud.json', JSON.stringify({ at: 0, devices: { [ID]: previous } }));
    const requests = [];
    let page = 0;
    await vm.runInNewContext(SOURCE, {
        require: (name) => name !== 'fs' ? require(name) : {
            readFileSync: (file) => {
                if (!files.has(file)) throw Object.assign(new Error('missing ' + file), { code: 'ENOENT' });
                return files.get(file);
            },
            writeFileSync: (file, text) => files.set(file, text),
            mkdirSync: () => {},
            appendFileSync: (file, text) => files.set(file, (files.get(file) || '') + text)
        },
        Date: class extends Date { static now() { return now; } },
        URLSearchParams, AbortSignal,
        setTimeout: () => ({ unref() {} }),
        process: { argv: ['node', 'tool', '--now'], env: {}, exit() {} },
        console: { log() {}, error() {} },
        fetch: async (url) => {
            const request = new URL(url);
            requests.push(request);
            let result;
            if (request.pathname === '/v1.0/token') result = { access_token: 'test-token' };
            else if (request.pathname.endsWith('/shadow/properties')) result = { properties: [{ dp_id: 101, value: 'none', time: now }] };
            else {
                assert.equal(request.pathname, '/v2.1/cloud/thing/' + ID + '/report-logs');
                assert.equal(request.searchParams.get('codes'), 'pir_state');
                const value = pages[page++];
                if (value instanceof Error) throw value;
                assert.ok(value, 'unexpected history page');
                result = value;
            }
            return { json: async () => ({ success: true, result }) };
        }
    });
    const events = [...files.entries()].filter(([file]) => file.startsWith(EVENTS))
        .flatMap(([, text]) => text.trim().split('\n').filter(Boolean).map(JSON.parse));
    return { files, requests, events, state: JSON.parse(files.get(DIR + 'tuya-devices-cloud.json')) };
}

test('PIR history preserves real motion and clear values with report timestamps, not online events', async () => {
    const result = await run([{ hasMore: false, logs: [
        { code: 'pir_state', value: 'none', eventTime: NOW },
        { code: 'pir_state', value: 'pir', eventTime: NOW - 1000 }
    ] }], { previous: { logTo: NOW - 500 } });
    assert.deepEqual(result.events.map((e) => [e.t, e.dps['101'], e.source]), [
        [NOW - 1000, 'pir', 'cloud report'], [NOW, 'none', 'cloud report']
    ]);
    assert.equal(result.state.devices[ID].reportTo, NOW);
    assert.equal(result.state.devices[ID].events, 2);
    assert.equal(result.requests.at(-1).searchParams.get('start_time'), String(NOW - 7 * 24 * 3600000),
        'the old online-event cursor must not skip real reports');
});

test('PIR history follows empty pages and keeps the time range and encoded pagination cursor', async () => {
    const cursor = 'cursor+/=';
    const result = await run([
        { hasMore: true, lastRowKey: cursor, logs: [] },
        { has_more: false, logs: [{ code: 'pir_state', value: 'pir', event_time: NOW }] }
    ]);
    assert.equal(result.events.length, 1);
    const history = result.requests.filter((r) => r.pathname.endsWith('/report-logs'));
    assert.equal(history[1].searchParams.get('last_row_key'), cursor);
    assert.equal(history[0].searchParams.get('start_time'), history[1].searchParams.get('start_time'));
    assert.equal(history[0].searchParams.get('end_time'), history[1].searchParams.get('end_time'));
});

test('PIR history deduplicates repeated page entries and replay after restart', async () => {
    const report = { code: 'pir_state', value: 'pir', eventTime: NOW };
    const first = await run([{ hasMore: false, logs: [report, report] }]);
    const second = await run([{ hasMore: false, logs: [report] }], {
        files: first.files, previous: first.state.devices[ID], now: NOW + 1000
    });
    assert.equal(first.events.length, 1);
    assert.equal(second.events.length, 1);
    assert.equal(second.state.devices[ID].events, 0);
});

test('failed or broken pagination does not append partial history or advance its cursor', async () => {
    for (const next of [new Error('request failed'), { hasMore: true, logs: [] }]) {
        const result = await run([
            { hasMore: true, lastRowKey: 'next', logs: [{ code: 'pir_state', value: 'pir', eventTime: NOW }] },
            next
        ], { previous: { reportTo: NOW - 2000 } });
        assert.equal(result.events.length, 0);
        assert.equal(result.state.devices[ID].reportTo, NOW - 2000);
        assert.match(result.state.error, /request failed|pagination cursor/);
    }
});

test('setup recognizes a sleeping PIR sensor and preserves its known endpoint while asleep', async () => {
    const files = new Map();
    const setup = fs.readFileSync(path.join(__dirname, '..', 'tools', 'tuya-devices-setup.js'), 'utf8');
    await vm.runInNewContext(setup, {
        require: (name) => {
            if (name === 'child_process') return { execSync: () => '' };
            if (name !== 'fs') return require(name);
            return {
                readFileSync: (file) => JSON.stringify(file.endsWith('tuya-devices-meta.json')
                    ? { [ID]: { ip: '192.168.1.66', version: '3.4', mac: '00:00:00:00:00:01' } }
                    : { accessId: 'test-id', accessSecret: 'test-secret', endpoint: 'https://example.invalid' }),
                writeFileSync: (file, text) => files.set(file, text)
            };
        },
        Date, process: { argv: ['node', 'setup'], env: {}, exit() {} },
        console: { log() {} },
        fetch: async (url) => {
            const request = new URL(url);
            let result;
            if (request.pathname === '/v1.0/token') result = { access_token: 'test-token' };
            else if (request.pathname.includes('/users/')) result = [{ id: ID, name: 'Motion Sensor', category: 'tdq', online: true, local_key: 'test-key' }];
            else if (request.pathname.endsWith('/factory-infos')) result = [{ id: ID, mac: '00:00:00:00:00:01' }];
            else if (request.pathname.endsWith('/shadow/properties')) result = { properties: [
                { dp_id: 101, code: 'pir_state' }, { dp_id: 102, code: 'battery_state' }
            ] };
            else if (request.pathname.endsWith('/specifications')) result = { status: [] };
            else result = { uid: 'test-user' };
            return { json: async () => ({ success: true, result }) };
        }
    });
    assert.equal(JSON.parse(files.get(DIR + 'tuya-devices-meta.json'))[ID].battery, true);
    assert.equal(JSON.parse(files.get(DIR + 'tuya-devices.json'))[ID].battery, true);
    assert.equal(JSON.parse(files.get(DIR + 'tuya-devices-meta.json'))[ID].ip, '192.168.1.66');
    assert.equal(JSON.parse(files.get(DIR + 'tuya-devices.json'))[ID].version, '3.4');
});

test('known-IP PIR listener reads local DPs on wake without a beacon and shares the wake cooldown', async () => {
    const { EventEmitter } = require('node:events');
    const files = new Map([
        [DIR + 'tuya-local-sensors.json', '{}'],
        [DIR + 'tuya-devices.json', JSON.stringify({
            [ID]: { battery: true, key: 'test-key', name: 'Motion Sensor', ip: '192.168.1.66', version: '3.4', dps: { 101: { code: 'pir_state' } } }
        })]
    ]);
    const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'tuya-local-sensors.js'), 'utf8');
    let probes = 0;
    function worker() {
        const timers = [];
        let tick;
        const messages = [];
        class Device extends EventEmitter {
            constructor(options) {
                super();
                assert.equal(options.ip, '192.168.1.66');
                assert.equal(options.version, '3.4');
            }
            connect() { return Promise.resolve(); }
            get() { return Promise.resolve({ dps: { 101: 'pir', 102: 'high' } }); }
            disconnect() {}
        }
        vm.runInNewContext(source, {
            require: (name) => {
                if (name.startsWith('/')) return Device;
                if (name === 'dgram') return { createSocket: () => Object.assign(new EventEmitter(), { bind() {} }) };
                if (name === 'net') return {
                    createConnection: ({ host, port }) => {
                        assert.equal(host, '192.168.1.66');
                        assert.equal(port, 6668);
                        probes++;
                        const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
                        queueMicrotask(() => socket.emit('connect'));
                        return socket;
                    }
                };
                if (name !== 'fs') return require(name);
                const missing = () => Object.assign(new Error('missing file'), { code: 'ENOENT' });
                return {
                    readFileSync: (file) => { if (!files.has(file)) throw missing(); return files.get(file); },
                    statSync: (file) => { if (!files.has(file)) throw missing(); return { mtimeMs: NOW }; },
                    unlinkSync: (file) => { if (!files.delete(file)) throw missing(); },
                    openSync: (file) => {
                        if (files.has(file)) throw Object.assign(new Error('locked'), { code: 'EEXIST' });
                        files.set(file, '');
                        return 1;
                    },
                    closeSync() {}, mkdirSync() {},
                    writeFileSync: (file, value) => files.set(file, value),
                    appendFileSync: (file, value) => files.set(file, (files.get(file) || '') + value)
                };
            },
            Date: class extends Date { static now() { return NOW; } },
            process: { argv: ['node', 'listener'], env: {}, stdout: { write: (text) => messages.push(JSON.parse(text)) }, exit() {} },
            setInterval: (fn) => { tick = fn; },
            setTimeout: (fn, delay) => { timers.push({ fn, delay }); }
        });
        return { tick: () => tick(), timers, messages };
    }
    const first = worker();
    first.tick();
    await new Promise(setImmediate);
    first.timers.find((timer) => timer.delay === 1500).fn();
    const reading = first.messages.find((message) => message.kind === 'reading');
    assert.equal(reading.dps['101'], 'pir');
    assert.equal(reading.dps['102'], 'high');
    const event = [...files.entries()].find(([file]) => file.startsWith(EVENTS));
    assert.equal(JSON.parse(event[1]).source, 'local');
    assert.equal(JSON.parse(event[1]).dps['101'], 'pir');
    const second = worker();
    second.tick();
    await new Promise(setImmediate);
    assert.equal(probes, 1, 'the overlapping listener must not connect during the same wake');
});
