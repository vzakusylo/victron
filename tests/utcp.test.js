// node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const TOKEN = 'secret-token';
const NOW = new Date(2026, 10, 21, 14, 0, 0).getTime();

function server() {
    const node = loadNode('62 UTCP server.js');
    node.flow.set('mcpToken', TOKEN);
    node.flow.set('dhwView', { master: true, at: NOW, status: 'ok' });
    return node;
}
function call(node, method, tool, body, opts) {
    const o = opts || {};
    const headers = o.headers || { authorization: 'Bearer ' + TOKEN, host: 'gx' };
    const msg = { req: { method, headers, params: { tool } }, payload: body };
    const r = node.run(msg, { now: NOW + (o.dt || 0) }).result;
    return r;
}
const status = (r) => r[0].statusCode;

test('UTCP manual: every tool has inputs and a call template, and no host or secret is in it', () => {
    const r = call(server(), 'GET');
    assert.equal(status(r), 200);
    const m = r[0].payload;
    assert.ok(m.utcp_version && m.manual_version);
    const names = m.tools.map((t) => t.name);
    assert.deepEqual(names, ['get_system_overview', 'get_heat_pump_state', 'get_idle_periods', 'get_event_lane', 'get_deploy_version', 'get_automation_log',
        'set_heating_mode', 'start_warm_up', 'force_boiler_run', 'cancel']);
    for (const t of m.tools) {
        assert.equal(t.tool_call_template.call_template_type, 'http');
        assert.equal(t.tool_call_template.url, '/utcp/call/' + t.name);
        assert.ok(t.inputs && t.description);
        if (t.tags.includes('control')) assert.ok(t.inputs.required.includes('confirm'), t.name);
    }
    const text = JSON.stringify(m);
    assert.ok(!text.includes(TOKEN) && !/https?:\/\//.test(text) && !/\d+\.\d+\.\d+\.\d+/.test(text));
});

test('UTCP: a token is required (503 without one configured, 401 when wrong, 403 for a foreign origin)', () => {
    const node = server();
    assert.equal(status(call(node, 'GET', '', null, { headers: { host: 'gx' } })), 401);
    assert.equal(status(call(node, 'GET', '', null, { headers: { host: 'gx', authorization: 'Bearer nope' } })), 401);
    assert.equal(status(call(node, 'GET', '', null, { headers: { host: 'gx', 'x-mcp-token': TOKEN } })), 200);
    assert.equal(status(call(node, 'GET', '', null, { headers: { host: 'gx', origin: 'http://evil.example', authorization: 'Bearer ' + TOKEN } })), 403);
    const none = loadNode('62 UTCP server.js');
    assert.equal(status(call(none, 'GET')), 503);
    assert.equal(status(call(node, 'POST', 'set_heating_mode', { mode: 'on', confirm: true }, { headers: { host: 'gx' } })), 401, 'a control call without a token');
});

test('UTCP control: confirm is required; nothing is sent without it', () => {
    const node = server();
    const r = call(node, 'POST', 'set_heating_mode', { mode: 'on' });
    assert.equal(status(r), 400);
    assert.equal(r[1].payload ? r[1].payload.action : r[1][0], 'utcpLog');
    assert.equal(node.context.get('lastControl'), undefined, 'a refused call does not use the rate limit');
    assert.equal(status(call(node, 'POST', 'force_boiler_run', { confirm: 'yes' })), 400);
});

test('UTCP control: tools map to the dashboard ui messages and are logged as UTCP', () => {
    const cases = [
        ['set_heating_mode', { mode: 'test', confirm: true }, { action: 'mode', id: 'heat', mode: 'dry' }],
        ['set_heating_mode', { mode: 'on', confirm: true }, { action: 'mode', id: 'heat', mode: 'live' }],
        ['set_heating_mode', { mode: 'off', confirm: true }, { action: 'mode', id: 'heat', mode: 'off' }],
        ['start_warm_up', { deltaC: 3, hours: 2, confirm: true }, { action: 'heatWarm', on: true, deltaC: 3, hours: 2 }],
        ['start_warm_up', { confirm: true }, { action: 'heatWarm', on: true, deltaC: 2, hours: 1 }],
        ['force_boiler_run', { confirm: true }, { action: 'dhwForceRun', on: true }],
        ['cancel', { what: 'warm_up', confirm: true }, { action: 'heatWarm', on: false }],
        ['cancel', { what: 'force_boiler_run', confirm: true }, { action: 'dhwForceRun', on: false }]
    ];
    for (const [tool, body, ui] of cases) {
        const r = call(server(), 'POST', tool, body);
        assert.equal(status(r), 200, tool);
        assert.equal(r[0].payload.ok, true);
        assert.deepEqual(r[1][0], { topic: 'ui', payload: ui }, tool);
        assert.match(r[1][1].payload.text, /^UTCP: /);
    }
});

test('UTCP control: bad values are refused; local control OFF refuses all but cancel', () => {
    assert.equal(status(call(server(), 'POST', 'start_warm_up', { deltaC: 9, confirm: true })), 400);
    assert.equal(status(call(server(), 'POST', 'start_warm_up', { hours: 0, confirm: true })), 400);
    assert.equal(status(call(server(), 'POST', 'set_heating_mode', { mode: 'turbo', confirm: true })), 400);
    const off = server();
    off.flow.set('dhwView', { master: false, at: NOW });
    const r = call(off, 'POST', 'force_boiler_run', { confirm: true });
    assert.equal(status(r), 409);
    assert.match(r[1].payload.text, /local control is OFF/);
    assert.equal(status(call(off, 'POST', 'cancel', { what: 'warm_up', confirm: true }, { dt: 20000 })), 200);
    assert.equal(status(call(server(), 'POST', 'nothing', {})), 404);
});

test('UTCP control: one control call per 10 s', () => {
    const node = server();
    assert.equal(status(call(node, 'POST', 'force_boiler_run', { confirm: true })), 200);
    assert.equal(status(call(node, 'POST', 'force_boiler_run', { confirm: true }, { dt: 5000 })), 429);
    assert.equal(status(call(node, 'POST', 'force_boiler_run', { confirm: true }, { dt: 11000 })), 200);
});

test('UTCP read tools: routed to the exec nodes, answers shaped from their output', () => {
    const node = server();
    let r = call(node, 'POST', 'get_automation_log', { lines: 2, day: '2026-11-21' });
    assert.match(r[2].payload, /tail -n 2 .*2026-11-21\.jsonl/);
    const lines = JSON.stringify({ t: NOW, kind: 'info', text: 'a' }) + '\n' + JSON.stringify({ t: NOW + 1000, kind: 'warn', rule: 'x', text: 'b' }) + '\n{half';
    const back = node.run({ utcpPhase: 'log', utcpDay: '2026-11-21', req: { headers: {} }, payload: lines }, { now: NOW }).result;
    assert.equal(back[0].payload.count, 2);
    assert.equal(back[0].payload.entries[1].rule, 'x');

    assert.equal(status(call(node, 'POST', 'get_automation_log', { day: '../x' })), 400);
    r = call(node, 'POST', 'get_idle_periods', { day: '2026-11-21', minMinutes: 5 });
    assert.equal(r[3].topic, 'day');
    assert.equal(r[3].day, '2026-11-21');
    const events = [
        { kind: 'idle', from: '10:20', to: '10:35', min: 15, tip: 'Idle: below restart level' },
        { kind: 'idle', from: '11:00', to: '11:03', min: 3, tip: 'Idle: defrost' },
        { kind: 'heating', from: '11:03', to: '12:00', min: 57 }
    ];
    const lane = (tool) => ({ utcpPhase: 'day', utcpDay: '2026-11-21', utcpTool: tool, utcpMin: 5, req: { headers: {} }, payload: { events, legend: [{ kind: 'idle', count: 2 }] } });
    const idle = node.run(lane('get_idle_periods'), { now: NOW }).result[0].payload;
    assert.deepEqual([idle.count, idle.totalMinutes], [1, 15]);
    assert.equal(idle.periods[0].cause, 'below restart level');
    const ev = node.run(lane('get_event_lane'), { now: NOW }).result[0].payload;
    assert.equal(ev.segments.length, 3);
    assert.equal(ev.segments[0].tooltip, 'Idle: below restart level');
});
