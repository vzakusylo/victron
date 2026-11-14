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

test('52 / 50: a Qingping MQTT message becomes the Air monitor card of the Devices page', () => {
    const air = loadNode('52 Air monitor.js');
    const ts = Math.round(NOW / 1000);
    const payload = JSON.stringify({ type: '17', mac: '582D34701F19', timestamp: ts, sensorData: [
        { timestamp: { value: ts - 900 }, co2: { value: 500 }, pm25: { value: 3 } },
        { timestamp: { value: ts - 60 }, temperature: { value: 21.4 }, humidity: { value: 38.2 }, co2: { value: 612 }, pm25: { value: 4 }, pm10: { value: 5 }, tvoc: { value: 87 } }
    ] });
    air.run({ topic: 'qingping/582D34701F19/up', payload }, { now: NOW });
    air.run({ topic: 'qingping/582D34701F19/up', payload: '{"type":"13"}' }, { now: NOW + 1000 });   // no readings: values stay
    air.run({ topic: 'qingping/582D34701F19/up', payload: 'not json' }, { now: NOW + 2000 });
    const stored = air.flow.get('airMonitor')['582D34701F19'];
    assert.equal(stored.t, (ts - 60) * 1000);
    assert.equal(stored.values.co2, 612);

    const devices = loadNode('50 Devices model.js');
    const card = (now) => {
        devices.flow.set('airMonitor', air.flow.get('airMonitor'));
        return devices.run({ topic: 'read', payload: '' }, { now }).result[0].payload.devices.find((d) => d.group === 'air');
    };
    const fresh = card(NOW + 5 * 60 * 1000);
    assert.equal(fresh.online, true);
    assert.deepEqual(fresh.values.find((v) => v.k === 'CO2'), { k: 'CO2', v: '612 ppm' });
    assert.deepEqual(fresh.values.find((v) => v.k === 'Temperature'), { k: 'Temperature', v: '21.4 °C' });
    assert.equal(card(NOW + 2 * 3600 * 1000).online, false);

    // online by the GX receive time, not the monitor clock; other MACs get no card
    const skewed = JSON.parse(JSON.stringify(air.flow.get('airMonitor')));
    skewed['582D34701F19'].t -= 3600 * 1000;                      // monitor clock 1 h behind
    skewed.AABBCCDDEEFF = { mac: 'AABBCCDDEEFF', t: NOW, seen: NOW, values: { co2: 1 } };
    devices.flow.set('airMonitor', skewed);
    const list = devices.run({ topic: 'read', payload: '' }, { now: NOW + 3 * 60 * 1000 }).result[0].payload.devices.filter((d) => d.group === 'air');
    assert.equal(list.length, 1);
    assert.equal(list[0].online, true);

    const empty = loadNode('50 Devices model.js').run({ topic: 'read', payload: '' }, { now: NOW }).result[0].payload.devices.find((d) => d.group === 'air');
    assert.equal(empty.online, false);
    assert.match(empty.note, /developer\.qingping\.co/);
});
test('52 / 54: readings go to the day file once, and the Air quality page gets the day chart', () => {
    const air = loadNode('52 Air monitor.js');
    const ts = Math.round(NOW / 1000);
    const msg = (type, rows) => ({ topic: 'qingping/582D34701F19/up', payload: JSON.stringify({ type, mac: '582D34701F19', timestamp: ts, sensorData: rows }) });
    const row = (s, co2) => ({ timestamp: { value: s }, co2: { value: co2 }, temperature: { value: 21.899999618530273 }, humidity: { value: 36.5 } });
    const first = air.run(msg('12', [row(ts - 120, 800)]), { now: NOW }).result;
    assert.equal(first[0].length, 1);
    assert.match(first[0][0].filename, /\/grid-control-logs\/air\/2026-11-12\.csv$/);
    assert.equal(first[0][0].payload, '13:28:00,800,,,,21.9,36.5\n');
    // the history message repeats the reading already written and adds a newer one
    const second = air.run(msg('17', [row(ts - 120, 800), row(ts - 60, 900)]), { now: NOW }).result;
    assert.deepEqual(second[0].map((m) => m.payload), ['13:29:00,900,,,,21.9,36.5\n']);
    assert.equal(air.run(msg('17', [row(ts - 60, 900)]), { now: NOW }).result, null, 'nothing new: nothing written');

    const hist = loadNode('54 Air quality history.js');
    const ask = hist.run({ topic: 'ui', payload: { action: 'day', day: '2026-11-11' } }, { now: NOW }).result;
    assert.equal(ask[1].day, '2026-11-11');
    assert.match(ask[1].payload, /cat \/data\/home\/nodered\/grid-control-logs\/air\/2026-11-11\.csv/);
    assert.equal(hist.run({ topic: 'ui', payload: { action: 'day', day: '../../etc/x' } }, { now: NOW + 10000 }).result[1].day, '2026-11-11', 'a bad day is ignored');
    const text = '2026-11-10.csv\n2026-11-11.csv\nnotes.txt\n@@DATA\n00:01:00,700,5,6,400,21,40\n00:01:00,700,5,6,400,21,40\n00:03:00,900,7,8,,22,\n23:59:30,1000,,,,,\n';
    const model = hist.run({ topic: 'read', day: '2026-11-11', payload: text }, { now: NOW }).result[0].payload;
    assert.equal(model.count, 3, 'a reading written twice counts once');
    assert.deepEqual(model.days, ['2026-11-12', '2026-11-11', '2026-11-10'], 'today first, newest first');
    assert.equal(model.series.co2.length, 288);
    assert.equal(model.series.co2[0], 800, '00:00-00:05 bucket = average of 700 and 900');
    assert.equal(model.series.co2[287], 1000);
    assert.equal(model.series.co2[1], null);
    assert.deepEqual(model.stats.co2, { min: 700, avg: 866.7, max: 1000, last: 1000 });
    assert.deepEqual(model.stats.humidity, { min: 40, avg: 40, max: 40, last: 40 });
    assert.equal(model.first, '00:01');
    // the refresh tick reads only while today is shown
    assert.equal(hist.run({ topic: 'tick' }, { now: NOW + 60000 }).result, null);
});
test('38: two power charts, compressor (calculated) and SA1 meter (measured) with V and A from DP 6', () => {
    const node = loadNode('38 Build heat pump history.js');
    // SA1 DP 6 = 220.8 V, 7.4 A, 1617 W; compressor 6 A at a 320 V DC bus
    const rows = ['#day 2026-11-11', '#hp1 2026-11-11 10 cols=t,st,112,114,115,pw,m6', '0,CCCC,6,320,50,1617,CKAAHOgABlE='];
    for (let t = 30; t < 600; t += 30) rows.push(String(t));
    rows.push('600,CCCS');                                               // meter stale: no meter values
    for (let t = 630; t < 900; t += 30) rows.push(String(t));
    const out = node.run({ topic: 'day', day: '2026-11-11', payload: rows.join('\n') }, { now: NOW }).result.payload;
    const powers = out.chart.powers;
    assert.deepEqual(powers.map((p) => p.id), ['compressor', 'meter']);
    const s = (p, unit) => p.series.find((x) => x.unit === unit);
    const i = 10 * 30;                                                   // 10:00 bucket (2 min)
    assert.equal(s(powers[0], 'W').v[i], 1920);
    assert.equal(s(powers[0], 'A').v[i], 6);
    assert.equal(s(powers[0], 'V').v[i], 320);
    assert.equal(s(powers[1], 'W').v[i], 1617);
    assert.equal(s(powers[1], 'A').v[i], 7.4);
    assert.equal(s(powers[1], 'V').v[i], 220.8);
    assert.equal(s(powers[1], 'W').v[i + 6], null, 'stale meter: no power');
    assert.equal(s(powers[1], 'V').v[i + 6], null, 'stale meter: no voltage');
    assert.equal(s(powers[0], 'W').v[i + 6], 1920, 'the compressor still counts');
    assert.equal(out.chart.power, undefined);
});
test('47: daily devices mail lists offline devices and batteries to replace, once a day from 08:00', () => {
    const node = loadNode('47 Heat pump alerts.js');
    const at8 = new Date(2026, 10, 13, 8, 0, 30).getTime();
    node.flow.set('devicesReport', { at: at8 - 60000, devices: [
        { id: 'a', name: 'Air monitor', group: 'air', online: false, lastData: at8 - 3 * 3600000, battery: null, note: 'no reading for 180 min', link: 'MQTT' },
        { id: 'b', name: 'stue', group: 'smartlife', online: true, lastData: at8 - 600000, battery: { text: 'low', low: true }, note: '', link: 'cloud' },
        { id: 'c', name: '1st smoke detector', group: 'smartlife', online: true, lastData: at8 - 20 * 3600000, battery: { text: '30 %', low: false }, note: '', link: '' },
        { id: 'd', name: 'Heat pump', group: 'tuya', online: true, lastData: at8, battery: null, note: '', link: '' },
        { id: 'e', name: 'EV Charger', group: 'smartlife-off', online: false, lastData: 0, battery: null, note: '', link: '' }
    ] });
    assert.equal(node.run({ topic: 'tick' }, { now: at8 - 3600000 }).result, null, 'not before 08:00');
    const mail = node.run({ topic: 'tick' }, { now: at8 }).result;
    const m = JSON.parse(mail.payload);
    assert.equal(m.subject, 'Devices: 1 offline, 1 battery low, 1 battery getting low, 1 quiet > 12 h');
    assert.match(m.text, /Offline \(1\):\n- Air monitor: no reading for 180 min \(last data 3 h ago, MQTT\)/);
    assert.match(m.text, /Battery low — replace \(1\):\n- stue: battery low/);
    assert.match(m.text, /Battery getting low \(1\):\n- 1st smoke detector: battery 30 %/);
    assert.match(m.text, /3 of 5 devices online; 1 more are offline in Smart Life too \(not counted above\): EV Charger/);
    assert.equal(node.run({ topic: 'tick' }, { now: at8 + 60000 }).result, null, 'once a day');
    assert.ok(node.run({ topic: 'report' }, { now: at8 + 120000 }).result, 'on demand');
});
test('08: the solar forecast is capped by the real output of the last 14 days', () => {
    const node = loadNode('08 Adjust solar forecast for shade.js');
    const raw = { '2026-11-12 12:00:00': 2000, '2026-11-12 13:00:00': 1800, '2026-11-12 15:00:00': 500 };
    const run = () => node.run({ payload: { result: raw } }, { now: NOW }).result.payload;

    // No logged days yet: the June tables alone (12:00 -> 2000 * 0.72 = 1440 W).
    assert.equal(run().adjustedResult['2026-11-12 12:00:00'], 1440);

    const days = {};
    for (let d = 1; d <= 10; d += 1) days['2026-11-' + String(d).padStart(2, '0')] = { 12: d === 4 ? 40 : 10, 13: 20 };
    node.context.set('observedSolar', { readOn: '2026-11-12', days });
    const p = run();
    assert.equal(p.adjustedResult['2026-11-12 12:00:00'], 50, 'best 12:00 hour 40 Wh x 1.25');
    assert.equal(p.adjustedResult['2026-11-12 13:00:00'], 25);
    assert.equal(p.adjustedResult['2026-11-12 15:00:00'], 0, 'never produced at 15:00 lately');
    assert.equal(p.today.condition, 'low');
    assert.equal(p.assumptions.observedDays, 10);
});

test('40: heating power controller steps Silent → Smart while the supply lags, and down when it rises too fast', () => {
    const node = loadNode('40 Heat pump automations.js');
    const T0 = Date.parse('2026-11-14T12:00:00Z');
    const hp = (sup, ret, mode) => ({ 1: true, 2: mode, 101: ret, 102: sup, 103: -5, 108: 47, 115: 69, 116: 594, 125: 36, 112: 3, 132: '1', 133: 38, 134: 4, 15: 0 });
    const setDev = (now, dps) => node.flow.set('heatPump', {
        hp: { state: 'CONNECTED', lastData: now, dps }, valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
        bypass: { state: 'CONNECTED', lastData: now, dps: { 1: false } } });
    node.context.set('settings', { master: true, modes: { heat: 'live' } });
    const writes = (call) => call.sent.filter((m) => m && m[0] === null && m[1] && m[1].payload && m[1].payload.operation === 'SET').map((m) => m[1].payload);
    let all = [];
    for (let i = 0; i <= 62; i++) {
        const now = T0 + i * 10000;
        setDev(now, hp(33, 30, 'mute'));
        all = all.concat(writes(node.run({ topic: 'tick' }, { now })));
    }
    assert.deepEqual(all, [{ operation: 'SET', dps: 2, set: 'smart' }], 'one step up to Smart');
    const view = node.flow.get('dhwView').heat;
    assert.equal(view.lag, -3);
    assert.equal(view.gap, 3);
    // Smart now, supply − return 6 °C (> gapMax + 1) → after the step time one step down
    all = [];
    for (let i = 63; i <= 130; i++) {
        const now = T0 + i * 10000;
        setDev(now, hp(36, 30, 'smart'));
        all = all.concat(writes(node.run({ topic: 'tick' }, { now })));
    }
    assert.deepEqual(all, [{ operation: 'SET', dps: 2, set: 'mute' }], 'one step down to Silent');
});

test('40: after a node start no DHW cycle starts for 15 min (outdoor sensor may be warm from a defrost)', () => {
    const init = loadNode('40 Heat pump automations.init.js');
    const node = loadNode('40 Heat pump automations.js');
    const T0 = Date.now();
    node.context.set('settings', { master: true, modes: { dhw: 'live' }, heatCurve: { p23: 38, p24: 4, at: 0 } });
    init.run({});
    for (const k of Object.keys(init.context.data)) node.context.set(k, init.context.data[k]);
    const dps = { 1: true, 2: 'mute', 101: 30, 102: 33, 103: 17.8, 108: 40, 115: 60, 116: 600, 125: 36, 112: 3, 132: '1', 133: 38, 134: 4, 15: 0 };
    const starts = [];
    for (let i = 0; i < 30; i++) {
        const now = T0 + i * 10000;
        node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: now, dps }, valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: now, dps: { 1: false } } });
        node.run({ topic: 'tick' }, { now });
        if (node.context.get('dhw').state !== 'HEATING') starts.push(i);
    }
    assert.deepEqual(starts, []);
    assert.match(node.context.get('dhw').why, /defrost now or/);
});

test('40: DHW waits for a forecast defrost and, after it, for the supply to reach the heating set point', () => {
    const node = loadNode('40 Heat pump automations.js');
    const T0 = Date.parse('2026-11-14T10:00:00Z');
    const M = 60000;
    node.context.set('settings', { master: true, modes: { dhw: 'live' }, heatCurve: { p23: 38, p24: 4, at: 0 },
        defrostStarts: [T0 - 150 * M, T0 - 100 * M, T0 - 50 * M] });   // every 50 min → next ≈ T0
    const tick = (now, over) => {
        const dps = Object.assign({ 1: true, 2: 'mute', 101: 30, 102: 36, 103: 3, 108: 40, 115: 60, 116: 600, 125: 36, 112: 3, 132: '1', 133: 38, 134: 4, 15: 0 }, over);
        node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: now, dps }, valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: now, dps: { 1: false } } });
        node.run({ topic: 'tick' }, { now });
        return node.context.get('dhw');
    };
    let d;
    for (let i = 0; i < 6; i++) d = tick(T0 - 15 * M + i * 10000);
    assert.equal(d.state, 'HEATING');
    assert.match(d.why, /defrost expected/);
    for (let i = 0; i < 6; i++) d = tick(T0 + i * 10000, { 116: 0, 115: 60 });     // defrost
    assert.equal(node.context.get('settings').defrostStarts.length, 4, 'start recorded');
    for (let i = 0; i < 6; i++) d = tick(T0 + 20 * M + i * 10000, { 102: 30 });     // supply not back yet
    assert.equal(d.state, 'HEATING');
    assert.match(d.why, /after the defrost supply 30/);
    for (let i = 0; i < 6; i++) d = tick(T0 + 22 * M + i * 10000, { 102: 35.5 });   // back at set − 1
    assert.equal(d.state, 'STOP', 'cycle started right after the defrost');
});

test('40: the heating controller ignores a defrost and its recovery and keeps the samples from before', () => {
    const node = loadNode('40 Heat pump automations.js');
    const T0 = Date.parse('2026-11-14T12:00:00Z');
    node.context.set('settings', { master: true, modes: { heat: 'live' } });
    const sets = [];
    const tick = (now, over, byp) => {
        const dps = Object.assign({ 1: true, 2: 'mute', 101: 30, 102: 33, 103: -5, 108: 47, 115: 69, 116: 594, 125: 36, 112: 3, 132: '1', 133: 38, 134: 4, 15: 0 }, over);
        node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: now, dps }, valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: now, dps: { 1: !!byp } } });
        const c = node.run({ topic: 'tick' }, { now });
        c.sent.forEach((m) => { if (m && m[1] && m[1].payload && m[1].payload.operation === 'SET') sets.push([Math.round((now - T0) / 60000), m[1].payload.set]); });
    };
    let t = T0;
    for (let i = 0; i < 36; i++, t += 10000) tick(t);                                  // 6 min lag −3
    for (let i = 0; i < 30; i++, t += 10000) tick(t, { 116: 0, 102: 22 }, true);       // 5 min defrost
    for (let i = 0; i < 120; i++, t += 10000) tick(t, { 102: 28 });                     // 20 min quiet + recovery
    assert.deepEqual(sets, [], 'no step during the defrost and the recovery');
    assert.match(node.context.get('heat').why, /ignored/);
    for (let i = 0; i < 30; i++, t += 10000) tick(t);                                  // back to −3: 5 min more
    assert.equal(sets.length, 1, 'step after 10 min outside the defrost, not 10 min after it');
    assert.equal(sets[0][1], 'smart');
});

test('40: after the top mode the heating controller raises the curve (P23 boost) and lowers the boost first', () => {
    const node = loadNode('40 Heat pump automations.js');
    const T0 = Date.parse('2026-11-14T12:00:00Z');
    node.context.set('settings', { master: true, modes: { heat: 'live' }, heatCurve: { p23: 38, p24: 4, at: 0 } });
    node.context.set('dhw', { state: 'HEATING', since: 0, outS: [], outAvg: -5, lagS: [], lastEnd: 0 });
    const sets = [];
    let p23 = 38, p24 = 4;
    const tick = (now, sup, mode) => {
        const dps = { 1: true, 2: mode, 101: sup - 3, 102: sup, 103: -5, 108: 47, 115: 69, 116: 594, 125: 36, 112: 3, 132: '1', 133: p23, 134: p24, 15: 0 };
        node.flow.set('heatPump', { hp: { state: 'CONNECTED', lastData: now, dps }, valve: { state: 'CONNECTED', lastData: now, dps: { 1: false } },
            bypass: { state: 'CONNECTED', lastData: now, dps: { 1: false } } });
        node.run({ topic: 'tick' }, { now }).sent.forEach((m) => { if (m && m[1] && m[1].payload && m[1].payload.operation === 'SET') { sets.push(m[1].payload); if (m[1].payload.dps === 133) p23 = m[1].payload.set; if (m[1].payload.dps === 134) p24 = m[1].payload.set; } });
    };
    let t = T0;
    for (let i = 0; i < 63; i++, t += 10000) tick(t, 33, 'smart');     // Smart (top), lag −4.2 → boost
    // +1 °C at −5 °C: P23 would be 41 > 40 → P23 40 with P24 5
    assert.deepEqual(sets, [{ operation: 'SET', dps: 134, set: 5 }, { operation: 'SET', dps: 133, set: 40 }]);
    assert.equal(node.context.get('settings').heatCurve.p23, 38, 'the boost is not stored as the owner curve');
    for (let i = 0; i < 63; i++, t += 10000) tick(t, 39, 'smart');     // above the point → boost off first
    assert.deepEqual(sets.slice(2), [{ operation: 'SET', dps: 134, set: 4 }, { operation: 'SET', dps: 133, set: 38 }]);
});
