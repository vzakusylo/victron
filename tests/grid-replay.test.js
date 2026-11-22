// Synthetic d#206 baseline. To intentionally accept a behavior change, review the
// diff from `node tests/grid-replay.test.js --update-reference`. G1–G6 refactoring
// PRs must NOT regenerate these references.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadGrid } = require('./harness');

const fixtures = path.join(__dirname, 'fixtures', 'grid');
const controller = () => loadGrid();
const read = file => JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'));
const topics = {
    batteryV: 'battery-voltage',
    consumedAh: 'battery-consumed-ah',
    gridW: 'grid-power',
    loadW: 'ac-load-power',
    dcW: 'dc-power',
    pvW: 'pv-charger-power'
};

function snapshot(outputs) {
    const trace = outputs[5].payload;
    const { hourKey, usedWh, fullHourCoverage } = trace.hourBudget;
    const tariff = trace.tariff;
    return {
        flags: trace.limitFlags,
        window: trace.window,
        forceLimiterActive: trace.forceChargeLimiterActive,
        hour: { hourKey, usedWh, fullHourCoverage, remainingWh: tariff.hourRemainingWh },
        day: { gridWh: tariff.todayGridWh, peakWh: tariff.todayPeakBillableWh, peakHour: tariff.todayPeakHourKey },
        month: { topPeaksWh: tariff.monthTopPeaksWh, averageW: tariff.monthTop3AverageW, tier: tariff.monthTier }
    };
}

function replay({ protection, samples }) {
    const node = controller();
    node.flow.set('highVoltageSettings', protection);
    const actuators = result => result ? {
        dvccA: result[0].payload,
        essW: result[1].payload,
        vebusA: result[2]?.payload ?? null
    } : null;
    // Sample times are local wall time, well away from DST changes. Exclude
    // absolute epoch timestamps from the reference so hosts in any TZ agree.
    return samples.map(({ at, readings }) => {
        const perInput = Object.entries(readings).map(([key, payload]) => {
            const topic = topics[key];
            assert.ok(topic, `Unknown input ${key}`);
            const { result } = node.run({ topic, payload }, { now: at });
            return actuators(result);
        });
        // A non-sensor message obtains an unthrottled trace at the sample time.
        const { result } = node.run({ topic: 'replay-tick' }, { now: at });
        return { at, perInput, tick: actuators(result), ...snapshot(result) };
    });
}

const cases = ['winter-night', 'summer-export', 'force-charge', 'high-voltage'];
if (process.argv.includes('--update-reference')) {
    for (const name of cases) {
        const frames = replay(read(`${name}.json`));
        fs.writeFileSync(path.join(fixtures, `expected-${name}.json`),
            `[\n${frames.map(frame => `  ${JSON.stringify(frame)}`).join(',\n')}\n]\n`);
    }
} else {
    for (const name of cases) {
        test(`grid replay: ${name}`, () => {
            assert.deepEqual(replay(read(`${name}.json`)), read(`expected-${name}.json`));
        });
    }

    test('grid tariff: rollover resets the hour, discounts the night peak and updates the top-3 tier', () => {
        const node = controller();
        const run = (at, topic = 'tariff-test-tick', payload) => node.run({ topic, payload }, { now: at }).result;
        const hourStart = '2026-11-16T05:00:00';
        run(hourStart, 'battery-voltage', 53);
        run(hourStart, 'battery-consumed-ah', -40);
        run(hourStart, 'grid-power', 4000);
        run(hourStart, 'tariff-history', [
            '2026-11-12 17,1000,1000,0',
            '2026-11-13 17,1800,1800,0',
            '2026-11-14 17,1900,1900,0',
            '2026-11-15 17,2000,2000,0',
            '2026-11-15 18,1500,1500,0'
        ].join('\n'));

        const before = snapshot(run('2026-11-16T05:30:00'));
        assert.deepEqual(before.day, { gridWh: 2000, peakWh: 1400, peakHour: '2026-11-16 05' });
        assert.deepEqual(before.month, { topPeaksWh: [2000, 1900, 1800], averageW: 1900, tier: 1 });
        assert.equal(snapshot(run('2026-11-16T05:59:24')).hour.usedWh, 3960);

        const after = snapshot(run('2026-11-16T06:00:00'));
        assert.equal(after.hour.hourKey, '2026-11-16 06');
        assert.equal(after.hour.usedWh, 0);
        assert.deepEqual(after.day, { gridWh: 3960, peakWh: 2772, peakHour: '2026-11-16 05' });
        assert.deepEqual(after.month, { topPeaksWh: [2772, 2000, 1900], averageW: 2224, tier: 2 });
        const day = snapshot(run('2026-11-16T06:45:00'));
        assert.deepEqual(day.day, { gridWh: 6960, peakWh: 3000, peakHour: '2026-11-16 06' });
    });

    test('grid tariff: midnight resets the day, retains this month’s peaks, and raises the tier', () => {
        const node = controller();
        const run = (at, topic = 'tariff-test-tick', payload) => node.run({ topic, payload }, { now: at }).result;
        const start = '2026-11-16T23:00:00';
        run(start, 'battery-voltage', 53);
        run(start, 'battery-consumed-ah', -40);
        run(start, 'grid-power', 5000);
        run(start, 'tariff-history', [
            '2026-11-13 17,1800,1800,0',
            '2026-11-14 17,1900,1900,0',
            '2026-11-15 17,2000,2000,0'
        ].join('\n'));
        assert.equal(snapshot(run(start)).month.tier, 1);
        run('2026-11-16T23:59:24');

        const after = snapshot(run('2026-11-17T00:00:00'));
        assert.equal(after.hour.usedWh, 0);
        assert.deepEqual(after.day, { gridWh: 0, peakWh: 0, peakHour: '2026-11-17 00' });
        assert.deepEqual(after.month, { topPeaksWh: [3465, 2000, 1900], averageW: 2455, tier: 2 });
    });
}
