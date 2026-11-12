// node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode } = require('./harness');

const NOW = new Date(2026, 10, 12, 13, 30, 0).getTime();

test('05 / 06 / 07: protection settings keep zeros and reject bad values', () => {
    const save = loadNode('05 Save HV settings from dashboard.js');
    const form = {
        enabled: false, start: 56.9, release: 56, full: 57, gridSupportW: 890, gridSupportMode: 'hv-only',
        gridSupportBatteryCapacityAh: 250, gridSupportReserveAh: 0, gridSupportStartHour: 0, gridSupportEndHour: 18,
        gridSupportMaxDischargeA: 0, gridSupportForecastConfidencePct: 0, gridSupportSolarAssistGainPct: 0,
        gridSupportWeakForecastBlockAh: 0, gridSupportMinGridImportW: 200, gridSupportDisableNoSun: true,
        gridSupportDisableNoSunBelowW: 0, exportGuardEnabled: false, forceChargeEnabled: true, forceChargeGridW: 1350,
        forceChargeLimiterEnabled: true, forceChargeLimiterStart: 55.8, forceChargeLimiterRelease: 55.9, forceChargeLimiterFull: 54
    };
    const [fileMsg, statusMsg, savedMsg] = save.run({ payload: form }).result;
    assert.equal(statusMsg.hvStatus.level, 'success');
    const stored = JSON.parse(fileMsg.payload);
    for (const key of Object.keys(form)) assert.equal(stored[key], form[key], key);
    assert.equal(savedMsg.payload.source, 'dashboard');

    // the page shows the saved zeros, not the defaults
    const page = loadNode('07 Build HV dashboard state.js');
    page.flow.set('highVoltageSettings', stored);
    const ui = page.run({}).result;
    for (const key of Object.keys(form)) assert.equal(ui.payload[key], form[key], 'page ' + key);
    assert.equal(ui.meta.protectionStatus, 'Disabled');

    // the saved file loads back unchanged and is not rewritten
    const apply = loadNode('06 Apply HV settings.js');
    const [loaded, rewrite] = apply.run({ payload: fileMsg.payload }).result;
    assert.equal(rewrite, null);
    assert.deepEqual(loaded.payload, stored);

    // rejected: full below start; nothing is stored
    const bad = loadNode('05 Save HV settings from dashboard.js');
    const rejected = bad.run({ payload: Object.assign({}, form, { full: 56 }) }).result;
    assert.equal(rejected[0], null);
    assert.equal(rejected[1].hvStatus.level, 'error');
    assert.equal(bad.flow.get('highVoltageSettings'), undefined);

    // an old file without the newer keys is completed and rewritten
    const old = apply.run({ payload: JSON.stringify({ start: 55.4, release: 55.2, full: 55.6 }) }).result;
    assert.equal(old[0].payload.exportGuardEnabled, true);
    assert.ok(old[1], 'file rewritten');
});

test('24 / 25: constants are validated against one list and stored as overrides', () => {
    const page = loadNode('24 Build controller constants state.js');
    const ui = page.run({ payload: '{"MIN_GRID_SETPOINT":100,"HEAVY_LOAD_THRESHOLD_W":4000}' }).result.payload;
    assert.equal(ui.overrideCount, 1, 'a key of an older version is not counted');
    const field = ui.groups.flatMap(g => g.fields).find(f => f.key === 'MIN_GRID_SETPOINT');
    assert.deepEqual([field.value, field.defaultValue, field.isOverridden], [100, 200, true]);

    const save = loadNode('25 Save controller constants.js');
    assert.equal(save.run({ topic: 'save-controller-constants', payload: {} }).result[1].payload.ok, false, 'spec not loaded yet');
    save.flow.set('controllerConstantsSpec', page.flow.get('controllerConstantsSpec'));

    const ok = save.run({ topic: 'save-controller-constants', payload: { MAX_CHARGE_CURRENT: 30, MIN_GRID_SETPOINT: 200, WINTER_START_MMDD: 1101, UNKNOWN: 1 } }).result;
    assert.deepEqual(JSON.parse(ok[0].payload), { MAX_CHARGE_CURRENT: 30, WINTER_START_MMDD: 1101 }, 'defaults and unknown keys are not stored');
    assert.deepEqual(save.flow.get('controllerConstantsOverrides'), { MAX_CHARGE_CURRENT: 30, WINTER_START_MMDD: 1101 });

    for (const payload of [{ MAX_CHARGE_CURRENT: 99 }, { WINTER_START_MMDD: 230 }, { SUMMER_TARIFF_TIER: 1.5 }, { GRID_CURRENT_MAX_A: null }, { TARIFF_TIER_MARGIN_W: 'x' }]) {
        const result = save.run({ topic: 'save-controller-constants', payload }).result;
        assert.equal(result[0], null, JSON.stringify(payload));
        assert.equal(result[1].payload.ok, false);
    }
    assert.deepEqual(save.flow.get('controllerConstantsOverrides'), { MAX_CHARGE_CURRENT: 30, WINTER_START_MMDD: 1101 }, 'a rejected save changes nothing');
});

test('17: the daily summary adds closed hours and is restored from the energy files', () => {
    const node = loadNode('17 Update daily summary.js');
    node.run({ topic: 'hourly-energy', payload: { hourKey: '2026-11-12 12', gridWh: 1500, acWh: 1400, solarWh: 0 } }, { now: NOW });
    const history = [
        'hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min',
        '2026-11-11 23,9999,9999,0,7000,9999,6440,W,60',
        '2026-11-12 10,2000,1900,50,2000,2500,4950,W,60',
        '2026-11-12 11:00 | Grid 2100Wh | AC 2000Wh | Sol 10Wh',
        '2026-11-12 12,1,1,1,1,1,4950,W,5',
        '2026-11-12 13,700,700,0,700,900,4950,W,20'
    ].join('\n');
    const out = node.run({ topic: 'tariff-history', payload: history }, { now: NOW }).result[1];
    assert.deepEqual(node.flow.get('dailySummary'), {
        dateKey: '2026-11-12',
        hours: [
            { hour: '10:00', gridWh: 2000, acWh: 1900, solarWh: 50 },
            { hour: '11:00', gridWh: 2100, acWh: 2000, solarWh: 10 },
            { hour: '12:00', gridWh: 1500, acWh: 1400, solarWh: 0 }
        ]
    }, 'yesterday and the running hour are skipped, the live 12:00 row is kept');
    assert.equal(out.summary.totalGrid, 5600);
    assert.equal(node.run({ topic: 'other', payload: 1 }, { now: NOW }).result, null);
});

test('38: heat pump history does not count meter power while the meter is stale', () => {
    const node = loadNode('38 Build heat pump history.js');
    const rows = ['#day 2026-11-11', '#hp1 2026-11-11 10 cols=t,st,115,pw', '0,CCCC,50,1000'];
    for (let t = 30; t < 1800; t += 30) rows.push(String(t));            // 30 min at 1000 W
    rows.push('1800,CCCS');                                              // meter stale, pw "unchanged"
    for (let t = 1830; t < 3600; t += 30) rows.push(String(t));
    const day = node.run({ topic: 'summary', payload: rows.join('\n') }, { now: NOW }).result.payload.days[0];
    assert.equal(day.kwh, 0.5);
    assert.equal(day.meterH, 0.5);
    assert.equal(day.coverageH, 1);
    assert.equal(day.runH, 1, 'heat pump values still count');
});

test('33: disabling MCP leaves an empty token file, so a restart does not enable it again', () => {
    const node = loadNode('33 MCP page.js');
    const disable = node.run({ topic: 'mcp-command', payload: { action: 'disable' } }).result[1];
    assert.equal(disable.mcpStep, 'disable');
    assert.doesNotMatch(disable.payload, /rm -f/);
    const load = node.run({ topic: 'mcp-start' }).result[1];
    assert.match(load.payload, /\[ -e "[^"]+mcp-token\.txt" \] \|\|/, 'a token is only created when there is no file');

    node.flow.set('mcpToken', 'abc123');
    const page = node.run({ topic: 'mcp-exec', mcpStep: 'disable', payload: '@@TOKEN \n' }).result[0].payload;
    assert.equal(page.enabled, false);
    assert.equal(page.tokenError, '');
    assert.equal(node.run({ topic: 'mcp-exec', mcpStep: 'load', payload: '@@TOKEN \n' }).result[0].payload.tokenError, '', 'disabled is not an error');
    assert.match(node.run({ topic: 'mcp-exec', mcpStep: 'regenerate', payload: '@@TOKEN \n' }).result[0].payload.tokenError, /could not be created/);
    assert.equal(node.run({ topic: 'mcp-exec', mcpStep: 'load', payload: '@@TOKEN 0a1b2c\n' }).result[0].payload.enabled, true);
});

test('32: MCP server needs the token and serves get_heat_pump', () => {
    const node = loadNode('32 MCP server.js');
    const call = (headers, body) => node.run({ req: { method: 'POST', headers }, payload: body }).result[0];
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal(call({}, list).statusCode, 503, 'no token configured');
    node.flow.set('mcpToken', 'secret');
    assert.equal(call({}, list).statusCode, 401);
    assert.equal(call({ authorization: 'Bearer wrong' }, list).statusCode, 401);
    assert.equal(call({ authorization: 'Bearer secret', origin: 'https://evil.example', host: 'venus.local:1881' }, list).statusCode, 403);
    const auth = { 'x-mcp-token': 'secret' };
    const tools = call(auth, list).payload.result.tools.map(t => t.name);
    assert.ok(tools.includes('get_heat_pump'));

    const page = loadNode('33 MCP page.js');
    assert.deepEqual(page.run({ topic: 'mcp-command', payload: { action: 'refresh' } }).result[0].payload.tools.map(t => t.name), tools,
        'the page lists the same tools as the server');

    const heatPump = (id) => JSON.parse(call(auth, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_heat_pump' } }).payload.result.content[0].text);
    assert.equal(heatPump(2).available, false);
    node.flow.set('heatPumpModel', { updated: new Date().toISOString(), devices: [{ role: 'hp', state: 'CONNECTED' }], summary: { supply: 35, meterDps: [{ dp: '6', value: 'x' }] }, curveChart: { p23: 37, p24: 4, svg: {} } });
    const data = heatPump(3);
    assert.equal(data.summary.supply, 35);
    assert.equal(data.summary.meterDps, undefined);
    assert.deepEqual(data.curve, { p23: 37, p24: 4 });
});

test('04: file preview unpacks .gz, is size-limited and quotes the path; the state file stays small', () => {
    const node = loadNode('04 Manage root files dashboard.js');
    const dir = '/data/home/nodered/grid-control-logs';
    const list = ['@@DF', '/dev/x 1000 400 600 40% /data', '@@DU', '120 ' + dir, '@@FILES',
        '900\t' + dir + '/heatpump/2026-11-12/10.csv.gz', "50\t" + dir + "/it's $(reboot).log"].join('\n');
    const afterList = node.run({ topic: 'root-files-list', payload: list }).result;
    assert.match(afterList[4].payload, /gzip -dc .*10\.csv\.gz/);
    assert.doesNotMatch(afterList[4].payload, /head -c/, 'BusyBox on the GX has no head -c');
    const second = node.run({ topic: 'root-files-nav', payload: { action: 'next' } }).result;
    assert.equal(second[4].payload, "'dd if='\\''" + dir + "/it'\\''\\'\\'''\\''s $(reboot).log'\\'' bs=1024 count=512 2>/dev/null'");

    const done = node.run({ topic: 'root-file-content', payload: 'x'.repeat(5000), filePath: dir + '/a.log', fileName: 'a.log' }).result;
    assert.equal(done[2].payload.rawText.length, 5000);
    const persisted = JSON.parse(done[5].payload);
    assert.ok(done[5].payload.length < 500, 'no file content in the state file');
    assert.equal(persisted.content.path, dir + '/a.log');
    assert.equal(persisted.files, undefined);
});
