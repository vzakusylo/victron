'use strict';
process.env.TZ = 'Europe/Oslo';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = ['constants', 'helpers', 'control'].map(name =>
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'grid', `${name}.js`), 'utf8')).join('\n');
const {
    decideGrid, getConstants, sanitizeHighVoltageSettings, readStoredNumber,
    parseManualDischargeCommand, getWindowRemainingHours, getSolarForecastSummary,
    getRemainingForecastWh, getTariffSeason, buildSeasonProfile, getTierForAverageW,
    parseEnergyHistory, advanceHourBudget
} = new Function(`${source}
    return {
        decideGrid, getConstants, sanitizeHighVoltageSettings, readStoredNumber,
        parseManualDischargeCommand, getWindowRemainingHours, getSolarForecastSummary,
        getRemainingForecastWh, getTariffSeason, buildSeasonProfile, getTierForAverageW,
        parseEnergyHistory, advanceHourBudget
    };`)();

const at = (hour, minute = 0, second = 0) => new Date(2026, 10, 12, hour, minute, second);
const hv = extras => sanitizeHighVoltageSettings({ start: 55.2, release: 55, full: 55.4, ...extras });
const manualDischarge = { active: true, source: 'test', startedAt: at(13).toISOString() };

function decide({ protection, ...inputs } = {}, state = {}) {
    return decideGrid({
        now: at(14), C: getConstants(), highVoltageSettings: hv(protection),
        batteryVoltage: 54, consumedAhDeficit: 0, hasGridPowerReading: true,
        storedGridPowerW: 900, gridPowerSignedW: 900, storedAcLoadPowerW: 1000,
        storedPvChargerPowerW: 0, solarGenerationW: 0, manualDischargeStopVoltage: 54,
        storedExportGuard: {}, ...inputs
    }, { manualDischarge: { active: false }, voltageLimitActive: false, forceChargeLimiterActive: false, ...state });
}

test('constant overrides require finite own values and validate rounded discrete settings', () => {
    const overrides = Object.assign(Object.create({ MIN_GRID_SETPOINT: 950 }), {
        WINTER_START_MMDD: '228.6', SUMMER_START_MMDD: 230, WINTER_TARIFF_TIER: '3.7',
        SUMMER_TARIFF_TIER: 9, MAX_GRID_STEP_W: 'bad', MAX_CHARGE_CURRENT: -1
    });
    const c = getConstants(overrides);
    assert.deepEqual([
        c.MIN_GRID_SETPOINT, c.WINTER_START_MMDD, c.SUMMER_START_MMDD, c.WINTER_TARIFF_TIER,
        c.SUMMER_TARIFF_TIER, c.MAX_GRID_STEP_W, c.MAX_CHARGE_CURRENT
    ], [200, 229, 415, 4, 1, 100, 1]);
});

test('protection read clamps tuning but rejects a strict target outside its rounded range', () => {
    const settings = hv({
        gridSupportMode: 'ADAPTIVE-DAY', gridSupportStartHour: -3, gridSupportEndHour: 24,
        gridSupportSolarAssistGainPct: 'bad', forceChargeGridW: '2999.7'
    });
    assert.deepEqual([
        settings.gridSupportMode, settings.gridSupportStartHour, settings.gridSupportEndHour,
        settings.gridSupportSolarAssistGainPct, settings.forceChargeGridW
    ], ['adaptive-day', 0, 23, 25, 3000]);
    assert.equal(hv({ gridSupportMode: 'unsupported' }).gridSupportMode, 'hv-only');
    assert.equal(hv({ gridSupportW: 1000.5 }), null);
});

test('protection read rejects missing voltage and disordered hysteresis even when disabled', () => {
    assert.equal(hv({ enabled: false, full: undefined }), null);
    assert.ok(hv({ release: 55.2 }), 'HV release may equal start');
    assert.equal(hv({ release: 55.21 }), null);
    assert.equal(hv({ full: 55.2 }), null);
    assert.equal(hv({ forceChargeLimiterEnabled: false, forceChargeLimiterRelease: 53 }), null);
    assert.equal(hv({ forceChargeLimiterFull: 53 }), null);
    assert.equal(hv({ forceChargeLimiterFull: 39.9 }), null);
});

test('stored zero is a reading whereas null and corrupt stored readings are absent', () => {
    for (const raw of [0, '0', '-100']) {
        assert.deepEqual(readStoredNumber(raw), { has: true, value: Number(raw) });
    }
    for (const raw of [undefined, null, NaN, Infinity, 'bad']) {
        assert.deepEqual(readStoredNumber(raw), { has: false, value: 0 });
    }
});

test('manual object aliases retain a reason and accept only explicit start or stop signals', () => {
    assert.deepEqual(parseManualDischargeCommand({ enabled: true, reason: 'schedule' }),
        { active: true, source: 'schedule' });
    assert.deepEqual(parseManualDischargeCommand({ command: 'stop', source: 'ui', reason: 'old' }),
        { active: false, source: 'ui' });
    assert.deepEqual(parseManualDischargeCommand({ enabled: false }), { active: false, source: 'inject' });
    assert.deepEqual(parseManualDischargeCommand({ command: 'start' }), { active: true, source: 'inject' });
    assert.deepEqual(parseManualDischargeCommand('on'), { active: true, source: 'inject' });
    assert.deepEqual(parseManualDischargeCommand('off'), { active: false, source: 'inject' });
    assert.equal(parseManualDischargeCommand({ active: 'false' }), null);
});

test('support windows are half-open, and equal endpoints give all-day support', () => {
    assert.equal(getWindowRemainingHours(at(6), 6, 18), 12);
    assert.equal(getWindowRemainingHours(at(17, 45), 6, 18), 0.25);
    assert.equal(getWindowRemainingHours(at(18), 6, 18), 0);
    assert.equal(getWindowRemainingHours(at(6), 22, 6), 0);
    assert.equal(getWindowRemainingHours(at(18), 6, 6), 24);
});

test('restoration forecast accepts the exact age limit and normalizes summary fields', () => {
    const now = at(14);
    const c = getConstants({ SOLAR_FORECAST_MAX_AGE_HOURS: 3 });
    const forecast = updatedAt => getSolarForecastSummary(now,
        { updatedAt, condition: 'SUNNY', energyKWh: '3.5', peakKW: '1.2' }, c);
    assert.deepEqual(forecast(at(11)), { valid: true, condition: 'sunny', energyKWh: 3.5, peakKW: 1.2 });
    assert.equal(forecast(at(10, 59, 59)).valid, false);
    assert.equal(forecast('invalid').valid, false);
    assert.deepEqual(getSolarForecastSummary(now, { updatedAt: now, peakKW: 'bad' }, c),
        { valid: true, condition: 'unknown', energyKWh: 0, peakKW: 0 });
    assert.deepEqual(getSolarForecastSummary(now, undefined, c),
        { valid: false, condition: 'unknown', energyKWh: 0, peakKW: 0 });
});

test('adjusted forecast counts a fractional current slot and only positive in-window hours today', () => {
    const adjustedResult = {
        '2026-11-11 16:00': 5000, '2026-11-12 13:00': 600,
        '2026-11-12 14:00': '600', '2026-11-12 15:00': -800,
        '2026-11-12 16:00': 800, '2026-11-12 17:00': 'bad',
        '2026-11-12 18:00': 500, '2026-11-12 XX:00': 500,
        '2026-11-13 16:00': 5000
    };
    assert.equal(getRemainingForecastWh(at(14, 29, 30), 6, 18, { adjustedResult }), 1105);
    assert.equal(getRemainingForecastWh(at(14), 6, 18, {}), 0);
});

test('non-wrapping tariff dates and forced profiles retain the automatic next switch', () => {
    const c = getConstants({ WINTER_START_MMDD: 301, SUMMER_START_MMDD: 1001 });
    const march = new Date(2026, 2, 1);
    const october = new Date(2026, 9, 1);
    assert.deepEqual(getTariffSeason(march, c),
        { winter: true, mode: 'auto', nextSwitchKey: '2026-10-01', nextSeason: 'SUMMER' });
    assert.deepEqual(getTariffSeason(october, { ...c, TARIFF_SEASON_FORCE: 2 }),
        { winter: true, mode: 'forced', nextSwitchKey: '2027-03-01', nextSeason: 'WINTER' });
    assert.deepEqual(getTariffSeason(march, { ...c, TARIFF_SEASON_FORCE: 1 }),
        { winter: false, mode: 'forced', nextSwitchKey: '2026-10-01', nextSeason: 'SUMMER' });
    assert.equal(getTariffSeason(march, { ...c, SUMMER_START_MMDD: 301 }).nextSwitchKey, '');
});

test('tariff backstop clips VE.Bus current and reports a night profile over tier', () => {
    const profile = buildSeasonProfile(true, getConstants({
        WINTER_TARIFF_TIER: 6, WINTER_NIGHT_BONUS_PCT: 60, TARIFF_NIGHT_BILLING_PCT: 100, GRID_CURRENT_MAX_A: 20
    }));
    assert.deepEqual([
        profile.nightSetpointW, profile.nightBillableW, profile.nightOverTier, profile.dayCurrentA, profile.nightCurrentA
    ], [39920, 39920, true, 20, 20]);
    assert.equal(getTierForAverageW(25000), 6);
    assert.equal(getTierForAverageW(25001), 7);
    assert.equal(getTierForAverageW(2000), 1);
});

test('energy history filters the month, preserves explicit bills and lets later duplicates win', () => {
    const history = parseEnergyHistory([
        '2026-10-31 23,1000,0,0',
        '2026-11-12 22,1000,0,0,650',
        '2026-11-12 22,2000,0,0,1234',
        '2026-11-12 23:00 | Grid 1000Wh',
        '2026-11-12 15,-100,0,0,-80',
        'not a record'
    ].join('\r\n'), '2026-11', getConstants());
    assert.deepEqual(history, {
        '2026-11-12 15': { gridWh: 0, billWh: 0 },
        '2026-11-12 22': { gridWh: 2000, billWh: 1234 },
        '2026-11-12 23': { gridWh: 1000, billWh: 700 }
    });
});

test('hour budget repairs an old timestamp and ignores backwards time and negative power', () => {
    const partial = advanceHourBudget({ hourKey: '2026-11-12 14', lastTs: +at(13, 59), usedWh: 55 }, at(14, 30), 1200);
    assert.deepEqual(partial, {
        hourKey: '2026-11-12 14', lastTs: +at(14, 30), usedWh: 600, startTs: +at(14, 30), fullHourCoverage: false
    });
    assert.deepEqual(advanceHourBudget(partial, at(14, 29), 1200), partial);
    assert.deepEqual(advanceHourBudget(partial, at(14, 35), -1200), { ...partial, lastTs: +at(14, 35) });
});

test('restoration stays off at the exact Ah thresholds and uses nominal voltage for a zero reading', () => {
    assert.equal(decide({ now: at(8), consumedAhDeficit: 0.5 }).finalChargeCurrent, 0);
    assert.equal(decide({ now: at(23), consumedAhDeficit: 150 }).finalChargeCurrent, 0);
    const inputs = {
        now: at(8), batteryVoltage: 0, consumedAhDeficit: 30,
        solarForecastToday: { updatedAt: at(7), condition: 'sunny', energyKWh: 1.06 },
        C: getConstants({ SOLAR_TO_BATTERY_EFFICIENCY: 1 })
    };
    const restored = decide(inputs);
    assert.equal(restored.forecastRestoreAh, 20);
    assert.equal(restored.gridRestoreAhNeeded, 10);
    assert.equal(restored.finalChargeCurrent, 25);
    assert.deepEqual(restored.limitFlags, ['SOL:SUNNY']);
    assert.equal(decide({ ...inputs, consumedAhDeficit: NaN }).effectiveConsumedAhDeficit, 0);
});

test('no restoration occurs at the first instant of the outside and evening windows', () => {
    const run = now => decide({ now, consumedAhDeficit: 200 });
    const outside = run(at(12));
    assert.deepEqual([outside.windowName, outside.finalChargeCurrent], ['OUTSIDE', 0]);
    const evening = run(at(17));
    assert.deepEqual([evening.windowName, evening.finalChargeCurrent], ['EVENING', 0]);
    assert.equal(run(at(22)).windowName, 'NIGHT');
});

test('force limiter clears when bypassed or when the power request disappears', () => {
    const protection = { forceChargeEnabled: true, forceChargeGridW: 1000, forceChargeLimiterEnabled: true };
    const armed = decide({ protection, batteryVoltage: 53.01 });
    assert.equal(armed.forceChargeLimiterActive, false);
    assert.deepEqual(armed.limitFlags, ['FC-ARMED:1000W']);
    const disabled = decide({ protection: { ...protection, forceChargeLimiterEnabled: false }, batteryVoltage: 53 },
        { forceChargeLimiterActive: true });
    assert.equal(disabled.forceChargeLimiterActive, false);
    assert.deepEqual(disabled.limitFlags, ['FC:1000W']);
    const zero = decide({ protection: { ...protection, forceChargeGridW: 0 }, batteryVoltage: 53 },
        { forceChargeLimiterActive: true });
    assert.equal(zero.forceChargeLimiterActive, false);
    assert.deepEqual(zero.limitFlags, []);
});

test('manual discharge holds above the AC ceiling and stops exactly at the voltage floor', () => {
    const inputs = {
        batteryVoltage: 55, storedAcLoadPowerW: 3000,
        protection: { forceChargeEnabled: true, forceChargeGridW: 1000 }
    };
    const running = decide(inputs, { manualDischarge });
    assert.equal(running.windowName, 'MANUAL-DISCHARGE');
    assert.equal(running.finalGridSetpoint, 1900);
    assert.equal(running.finalChargeCurrent, 0);
    const held = decide({ ...inputs, storedAcLoadPowerW: 3001 }, { manualDischarge });
    assert.equal(held.windowName, 'FORCE-CHARGE');
    assert.equal(held.manualDischarge.active, true);
    assert.ok(held.limitFlags.includes('MD-HOLD>3000W'));
    const stopped = decide({ ...inputs, batteryVoltage: 54 }, { manualDischarge });
    assert.equal(stopped.windowName, 'FORCE-CHARGE');
    assert.deepEqual(stopped.manualDischarge, { active: false, startedAt: '', source: 'auto-stop-low-voltage' });
});

test('HV selects a zero floor without CT or a house-load floor during force charge', () => {
    const noGrid = decide({ batteryVoltage: 55.4, hasGridPowerReading: false, storedGridPowerW: 500 });
    assert.equal(noGrid.finalGridSetpoint, 0);
    const force = decide({
        batteryVoltage: 55.4, storedGridPowerW: 300,
        protection: { gridSupportW: 300, forceChargeEnabled: true, forceChargeGridW: 1500 }
    });
    assert.equal(force.finalGridSetpoint, 1000);
    assert.equal(force.finalChargeCurrent, 0);
    const disabled = decide({ batteryVoltage: 55.4, protection: { enabled: false } }, { voltageLimitActive: true });
    assert.equal(disabled.voltageLimitActive, false);
});

test('adaptive support combines reserved Ah, discounted forecast and live PV before the discharge cap', () => {
    const out = decide({
        now: at(14, 30), consumedAhDeficit: 200, solarGenerationW: 400, storedAcLoadPowerW: 550,
        solarForecastAdjusted: { adjustedResult: { '2026-11-12 16:00': 2400 } },
        protection: { gridSupportW: 900, gridSupportWeakForecastBlockAh: 20, gridSupportMaxDischargeA: 5 },
        C: getConstants({ MIN_GRID_SETPOINT: 350 })
    });
    assert.deepEqual([
        out.batteryRemainingAh, out.usableStoredSupportAh, out.predictedSupportAh, out.plannedGridSupportW,
        out.liveSolarAssistW, out.adaptiveGridSupportW, out.finalGridSetpoint, out.adaptiveGridSupportActive
    ], [100, 10, 4, 216, 100, 270, 350, true]);
    const saturated = decide({
        consumedAhDeficit: 350, solarGenerationW: 4000,
        protection: { gridSupportW: 500, gridSupportMaxDischargeA: 40 }
    });
    assert.deepEqual([
        saturated.batteryRemainingAh, saturated.usableStoredSupportAh, saturated.adaptiveGridSupportW,
        saturated.finalGridSetpoint
    ], [0, 0, 500, 500]);
});

test('adaptive support without a capacity estimate can use live PV but not a weak forecast', () => {
    const inputs = {
        solarGenerationW: 800, solarForecastAdjusted: { adjustedResult: { '2026-11-12 16:00': 500 } },
        protection: { gridSupportW: 900, gridSupportBatteryCapacityAh: 0, enabled: false }
    };
    const out = decide(inputs);
    assert.equal(out.batteryRemainingAh, null);
    assert.equal(out.predictedSupportAh, 0);
    assert.equal(out.finalGridSetpoint, 800);
    assert.equal(decide({ ...inputs, hasGridPowerReading: false }).finalGridSetpoint, 4950);
    assert.equal(decide({ ...inputs, now: at(18) }).finalGridSetpoint, 4950);
    const allDay = { ...inputs.protection, gridSupportStartHour: 0, gridSupportEndHour: 0 };
    assert.equal(decide({ ...inputs, now: at(23), protection: allDay }).adaptiveGridSupportActive, false);
});

test('adaptive support yields to force charge or manual discharge even with available battery capacity', () => {
    const inputs = {
        batteryVoltage: 55, storedAcLoadPowerW: 2000, protection: { gridSupportW: 900 }
    };
    assert.equal(decide(inputs).finalGridSetpoint, 1175);
    const force = decide({
        ...inputs, protection: { ...inputs.protection, forceChargeEnabled: true, forceChargeGridW: 1000 }
    });
    assert.equal(force.finalGridSetpoint, 3000);
    assert.equal(force.adaptiveGridSupportActive, false);
    const manual = decide(inputs, { manualDischarge });
    assert.equal(manual.finalGridSetpoint, 900);
    assert.equal(manual.adaptiveGridSupportActive, false);
});

test('low sun blocks both kinds of support and only hybrid retains adaptive support during HV', () => {
    const protection = { gridSupportW: 900, gridSupportDisableNoSun: true };
    const inputs = { batteryVoltage: 55.4, storedAcLoadPowerW: 1200, protection };
    const blocked = decide({ ...inputs, solarGenerationW: 199 });
    assert.equal(blocked.finalGridSetpoint, 900);
    assert.deepEqual(blocked.limitFlags, ['HV', 'GS-SUN<200W']);
    const hybrid = decide({ ...inputs, solarGenerationW: 200 });
    assert.equal(hybrid.finalGridSetpoint, 300);
    assert.ok(hybrid.limitFlags.includes('GS-A:831W'));
    const adaptive = decide({ ...inputs, solarGenerationW: 200, protection: { ...protection, gridSupportMode: 'adaptive-day' } });
    assert.equal(adaptive.finalGridSetpoint, 300);
    assert.equal(adaptive.adaptiveGridSupportActive, false);
});

test('fixed HV support floors the cap at MIN_GRID_SETPOINT and cannot cap without a CT reading', () => {
    const inputs = {
        batteryVoltage: 55.4, storedAcLoadPowerW: 350, previousGridSetpoint: 1000,
        protection: { gridSupportMode: 'hv-only', gridSupportW: 300 }
    };
    assert.equal(decide(inputs).finalGridSetpoint, 200);
    assert.equal(decide({ ...inputs, hasGridPowerReading: false }).finalGridSetpoint, 900);
    const manual = decide({
        ...inputs, storedAcLoadPowerW: 2000, C: getConstants({ MANUAL_DISCHARGE_MAX_CURRENT: 1 })
    }, { manualDischarge });
    assert.equal(manual.finalGridSetpoint, 1945);
});

test('day load cap applies only above its threshold, never overnight or during a priority mode', () => {
    assert.equal(decide({ storedAcLoadPowerW: 4000 }).finalGridSetpoint, 4950);
    assert.equal(decide({ storedAcLoadPowerW: 4001 }).finalGridSetpoint, 4850);
    assert.equal(decide({ now: at(23), storedAcLoadPowerW: 4001 }).finalGridSetpoint, 6440);
    assert.equal(decide({
        storedAcLoadPowerW: 4001, protection: { forceChargeEnabled: true, forceChargeGridW: 1000 }
    }).finalGridSetpoint, 4950);
    assert.equal(decide({
        batteryVoltage: 55, storedAcLoadPowerW: 4001, C: getConstants({ MANUAL_DISCHARGE_MAX_AC_LOAD_W: 5000 })
    }, { manualDischarge }).finalGridSetpoint, 2901);
    assert.equal(decide({
        batteryVoltage: 55.4, storedAcLoadPowerW: 4001, storedGridPowerW: 50
    }).finalGridSetpoint, 0);
});

test('export guard integrates only at the interval, holds at the deadband edge and releases at zero', () => {
    const now = at(14);
    const guard = { active: true, boostW: 500, since: at(13).toISOString(), lastAdjustTs: +now };
    const run = (ms, watts, storedExportGuard = guard) =>
        decide({ now: new Date(+now + ms), gridPowerSignedW: watts, storedExportGuard }).exportGuard;
    assert.deepEqual(run(14999, -1000), guard);
    const raised = run(15000, -1000);
    assert.deepEqual(raised, { ...guard, boostW: 700, lastAdjustTs: +now + 15000 });
    assert.deepEqual(run(30000, 350, raised), { ...raised, lastAdjustTs: +now + 30000 });
    const lowered = run(30000, 400, raised);
    assert.equal(lowered.boostW, 650);
    const released = run(45000, 600, { ...lowered, boostW: 150 });
    assert.deepEqual(released, { active: false, boostW: 0, since: '', lastAdjustTs: 0 });
});

test('export guard clips boost, floors a lower ESS target and clears without a usable CT', () => {
    assert.equal(decide({ gridPowerSignedW: 0 }).exportGuard.active, false);
    const out = decide({
        batteryVoltage: 55.4, storedGridPowerW: 0, gridPowerSignedW: -4000, storedPvChargerPowerW: 1000
    });
    assert.deepEqual([out.exportGuard.boostW, out.finalGridSetpoint, out.finalChargeCurrent], [2000, 300, 25]);
    assert.deepEqual(out.limitFlags, ['EXP:+2000W@-4000W']);
    const later = decide({
        now: new Date(+at(14) + 15000), storedExportGuard: out.exportGuard, gridPowerSignedW: -4000
    });
    assert.equal(later.exportGuard.boostW, 2000);
    for (const inputs of [{ hasGridPowerReading: false }, { protection: { exportGuardEnabled: false } }]) {
        assert.equal(decide({ storedExportGuard: out.exportGuard, gridPowerSignedW: -4000, ...inputs }).exportGuard.active, false);
    }
});
