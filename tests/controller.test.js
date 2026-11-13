// node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadNode, ROOT } = require('./harness');

const CONTROLLER = '01 Battery + Grid Controller.js';
const at = (month, day, hour, minute = 0, second = 0) => new Date(2026, month - 1, day, hour, minute, second).getTime();

// A controller that already has its sensor readings; returns { node, step(msg, time) }.
function controller({ voltage = 53, consumedAh = 0, grid = 1000, acLoad = 1000, pv = 0, start = at(11, 12, 13, 0), hv, overrides } = {}) {
    const node = loadNode(CONTROLLER);
    if (hv) node.flow.set('highVoltageSettings', hv);
    if (overrides) node.flow.set('controllerConstantsOverrides', overrides);
    let t = start;
    // 6 s apart: the trace is sent at most every 5 s for sensor topics.
    const step = (msg, time) => { t = time === undefined ? t + 6000 : time; return node.run(msg, { now: t }); };
    step({ topic: 'battery-consumed-ah', payload: -consumedAh }, start);
    step({ topic: 'grid-power', payload: grid });
    step({ topic: 'ac-load-power', payload: acLoad });
    step({ topic: 'pv-charger-power', payload: pv });
    const first = step({ topic: 'battery-voltage', payload: voltage });
    return { node, step, first };
}
const outputs = (call) => ({
    chargeA: call.result[0].payload,
    setpointW: call.result[1].payload,
    currentLimit: call.result[2] && call.result[2].payload,
    trace: call.result[5] && call.result[5].payload
});
const validHv = (extra) => Object.assign({ enabled: true, start: 55.2, release: 55.0, full: 55.4 }, extra);

test('waits for battery voltage and consumed Ah before it sends anything', () => {
    const node = loadNode(CONTROLLER);
    assert.equal(node.run({ topic: 'grid-power', payload: 500 }, { now: at(11, 12, 13) }).result, null);
    const call = node.run({ topic: 'battery-voltage', payload: 53 }, { now: at(11, 12, 13, 0, 1) });
    assert.equal(call.result, null);
    assert.match(call.status.text, /WAITING FOR BMS CONSUMED AH/);
});

test('season plan: winter tier 2 and summer tier 1 setpoints and input current limits', () => {
    const winterDay = outputs(controller({ start: at(11, 12, 13) }).first);
    assert.equal(winterDay.setpointW, 4950);
    assert.equal(winterDay.currentLimit, 23.5);
    const winterNight = outputs(controller({ start: at(11, 12, 23) }).first);
    assert.equal(winterNight.setpointW, 6440);
    assert.equal(winterNight.currentLimit, 31);
    const summerDay = outputs(controller({ start: at(6, 12, 13) }).first);
    assert.equal(summerDay.setpointW, 1950);
    assert.equal(summerDay.currentLimit, 9.5);
    const summerNight = outputs(controller({ start: at(6, 12, 2) }).first);
    assert.equal(summerNight.setpointW, 2850);
    assert.equal(summerNight.currentLimit, 13.5);
    assert.equal(outputs(controller({ start: at(10, 16, 13) }).first).setpointW, 1950, '16 Oct is still summer');
    assert.equal(outputs(controller({ start: at(10, 17, 13) }).first).setpointW, 4950, '17 Oct is winter');
});

test('restoration: morning charges any deficit, night only what the morning cannot cover', () => {
    assert.equal(outputs(controller({ consumedAh: 40, start: at(11, 12, 8) }).first).chargeA, 25);
    assert.equal(outputs(controller({ consumedAh: 0.2, start: at(11, 12, 8) }).first).chargeA, 0, 'inside the deadband');
    // 6 morning hours x 25 A = 150 Ah
    assert.equal(outputs(controller({ consumedAh: 140, start: at(11, 12, 23) }).first).chargeA, 0);
    assert.equal(outputs(controller({ consumedAh: 160, start: at(11, 12, 23) }).first).chargeA, 25);
    assert.equal(outputs(controller({ consumedAh: 160, start: at(11, 12, 14) }).first).chargeA, 0, 'no charging outside the windows');
});

test('Constants page overrides reach the controller', () => {
    const morning = { consumedAh: 40, start: at(11, 12, 8) };
    assert.equal(outputs(controller(Object.assign({ overrides: { MAX_CHARGE_CURRENT: 10 } }, morning)).first).chargeA, 10);
    assert.equal(outputs(controller(Object.assign({ overrides: { MAX_CHARGE_CURRENT: 500 } }, morning)).first).chargeA, 50, 'clamped to the allowed range');
    assert.equal(outputs(controller({ overrides: { RESTORE_AH_DEADBAND: 5 }, consumedAh: 4, start: at(11, 12, 8) }).first).chargeA, 0);

    const high = { acLoad: 4500, start: at(11, 12, 13) };
    assert.equal(outputs(controller(high).first).setpointW, 4850, 'default: 100 W lower above 4000 W');
    assert.equal(outputs(controller(Object.assign({ overrides: { DAY_HIGH_AC_LOAD_THRESHOLD_W: 5000 } }, high)).first).setpointW, 4950);
    assert.equal(outputs(controller(Object.assign({ overrides: { DAY_HIGH_AC_LOAD_REDUCTION_W: 300 } }, high)).first).setpointW, 4650);
});

test('manual discharge uses its constants and stops at the stop voltage', () => {
    const run = (overrides) => {
        const c = controller({ voltage: 55, acLoad: 2000, overrides });
        return { c, out: outputs(c.step({ topic: 'manual-discharge', payload: true })) };
    };
    assert.equal(run().out.setpointW, 900, '2000 W load - 20 A x 55 V');
    assert.equal(run({ MANUAL_DISCHARGE_MAX_CURRENT: 25 }).out.setpointW, 625);
    assert.equal(run({ MANUAL_DISCHARGE_MAX_CURRENT: 40 }).out.setpointW, 200, 'floored at the minimum grid import');
    assert.equal(run({ MANUAL_DISCHARGE_MAX_CURRENT: 40, MANUAL_DISCHARGE_MIN_GRID_W: 100 }).out.setpointW, 100);

    const { c } = run();
    const stopped = outputs(c.step({ topic: 'battery-voltage', payload: 53.9 }));
    assert.equal(stopped.setpointW, 4950);
    assert.equal(stopped.trace.manualDischarge.source, 'auto-stop-low-voltage');
});

test('high-voltage limiter tapers the setpoint in steps of MAX_GRID_STEP_W and releases', () => {
    const c = controller({ voltage: 55, grid: 1000, hv: validHv() });
    assert.equal(outputs(c.first).setpointW, 4950);
    const limited = outputs(c.step({ topic: 'battery-voltage', payload: 55.4 }));
    assert.equal(limited.setpointW, 4850, 'one step of 100 W towards the measured import');
    assert.equal(limited.trace.voltageLimitActive, true);
    assert.equal(outputs(c.step({ topic: 'battery-voltage', payload: 55.4 })).setpointW, 4750);
    const released = outputs(c.step({ topic: 'battery-voltage', payload: 55.0 }));
    assert.equal(released.trace.voltageLimitActive, false);
    assert.equal(released.setpointW, 4950);

    const slow = controller({ voltage: 55, grid: 1000, hv: validHv(), overrides: { MAX_GRID_STEP_W: 50 } });
    assert.equal(outputs(slow.step({ topic: 'battery-voltage', payload: 55.4 })).setpointW, 4900);
});

test('invalid protection settings fall back to the defaults; a force-charge limiter below 50 V is valid', () => {
    const invalid = outputs(controller({ hv: validHv({ start: 70 }) }).first).trace.highVoltageSettings;
    assert.equal(invalid.start, 55.2);

    const hv = validHv({ enabled: false, forceChargeEnabled: true, forceChargeGridW: 1000, forceChargeLimiterEnabled: true,
        forceChargeLimiterStart: 47, forceChargeLimiterRelease: 49, forceChargeLimiterFull: 45 });
    const out = outputs(controller({ voltage: 46.5, acLoad: 1000, hv }).first);
    assert.equal(out.trace.highVoltageSettings.enabled, false, 'the saved settings are used, not the defaults');
    assert.equal(out.trace.window, 'FORCE-CHARGE');
    assert.ok(out.chargeA > 0);
});

test('adaptive support window that wraps midnight counts the hours to its end', () => {
    const hv = validHv({ gridSupportMode: 'adaptive-day', gridSupportW: 500, gridSupportStartHour: 20, gridSupportEndHour: 6 });
    assert.equal(outputs(controller({ start: at(11, 12, 2), hv }).first).trace.supportWindowRemainingHours, 4);
    assert.equal(outputs(controller({ start: at(11, 12, 22), hv }).first).trace.supportWindowRemainingHours, 8);
    assert.equal(outputs(controller({ start: at(11, 12, 23) }).first).trace.remainingNightHours, 7);
    assert.equal(outputs(controller({ start: at(11, 12, 2) }).first).trace.remainingNightHours, 4);
});

test('export guard floors the setpoint and lets the battery absorb PV', () => {
    const c = controller({ voltage: 54, grid: 500, acLoad: 300, pv: 800, start: at(6, 12, 13) });
    const out = outputs(c.step({ topic: 'grid-power', payload: -200 }));
    assert.equal(out.trace.exportGuard.active, true);
    assert.equal(out.trace.exportGuard.boostW, 500, 'minimum import 300 W + 200 W export');
    assert.ok(out.setpointW >= 300);
    assert.equal(out.chargeA, Math.round((800 + 500) / 54 * 10) / 10);
});

test('hour rollover writes the closed hour and re-sends the input current limit', () => {
    const c = controller({ grid: 3000, acLoad: 3000, start: at(11, 12, 13, 0, 0) });
    c.step({ topic: 'grid-power', payload: 3000 }, at(11, 12, 13, 59, 59));
    const call = c.step({ topic: 'grid-power', payload: 3000 }, at(11, 12, 14, 0, 1));
    const record = call.result[4].payload;
    assert.equal(record.hourKey, '2026-11-12 13');
    // the first seconds of the hour pass before the first grid reading arrives
    assert.ok(Math.abs(record.gridWh - 3000) <= 10, 'about 3000 Wh, got ' + record.gridWh);
    assert.equal(record.billWh, record.gridWh, 'day hours are billed in full');
    assert.equal(record.setpointW, 4950);
    assert.equal(record.season, 'W');
    assert.equal(call.result[2].payload, 23.5);
});

test('month history restores today and the month peaks, and is requested once', () => {
    const c = controller({ start: at(11, 12, 13, 5) });
    const request = c.first.result[6];
    assert.equal(request.topic, 'tariff-history');
    assert.match(request.payload, /energy-2026-11\.csv/);
    assert.equal(c.step({ topic: 'grid-power', payload: 1000 }).result[6], null, 'not requested again within a minute');
    const history = [
        'hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min',
        '2026-11-10 18,4200,4200,0,4200,4500,4950,W,60',
        '2026-11-12 02,6000,6000,0,4200,6100,6440,W,60',
        '2026-11-12 09:00 | Grid 3000Wh | AC 3000Wh | Sol 0Wh'
    ].join('\n');
    const tariff = outputs(c.step({ topic: 'tariff-history', payload: history })).trace.tariff;
    assert.ok(tariff.todayGridWh >= 9000 && tariff.todayGridWh < 9200);
    assert.equal(tariff.todayPeakBillableWh, 4200);
    assert.deepEqual(tariff.monthTopPeaksWh, [4200, 4200]);
    assert.equal(tariff.monthTier, 2);
});

test('constants: the controller and the Constants page share defaults and ranges', () => {
    const source = fs.readFileSync(path.join(ROOT, CONTROLLER), 'utf8');
    const literal = source.match(/const CONSTANT_SPECS = Object\.freeze\((\{[\s\S]*?\n\})\);/)[1];
    const controllerSpecs = new Function('TARIFF_TIER_LIMITS_W', 'return ' + literal)(new Array(6));
    const page = loadNode('24 Build controller constants state.js');
    page.run({ payload: '{}' });
    const pageSpecs = page.flow.get('controllerConstantsSpec');

    assert.deepEqual(Object.keys(pageSpecs).sort(), Object.keys(controllerSpecs).sort());
    for (const key of Object.keys(controllerSpecs)) {
        const c = controllerSpecs[key], p = pageSpecs[key];
        assert.equal(p.def, c.def, key + ' default');
        assert.equal(p.kind, c.mmdd ? 'mmdd' : (c.int ? 'int' : 'number'), key + ' kind');
        if (!c.mmdd) assert.deepEqual([p.min, p.max], [c.min, c.max], key + ' range');
    }
});

test('protection defaults are the same in the controller and the settings nodes', () => {
    const apply = loadNode('06 Apply HV settings.js');
    const loaded = apply.run({ payload: '' }).result[0].payload;
    assert.equal(loaded.source, 'default');
    const fromController = outputs(controller().first).trace.highVoltageSettings;
    const defaults = Object.assign({}, loaded);
    delete defaults.updatedAt;
    delete defaults.source;
    assert.deepEqual(defaults, Object.assign({}, fromController));

    // the controller accepts exactly what the settings node stores
    const viaFlow = outputs(controller({ hv: loaded }).first).trace.highVoltageSettings;
    assert.deepEqual(viaFlow, defaults);
});
