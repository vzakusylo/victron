'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource, loadHeatPumpState, loadNode } = require('./harness');

const ROOT = path.join(__dirname, '..');
const FILES = ['35 Heat pump page.html', '39 Heat pump history page.html'];
const ATTRS = ['cx', 'cy', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'd', 'points', 'width', 'height'];

test('heating chart shows the confirmed asymmetric band and live readings only at valid marker points', () => {
    const html = readSource(FILES[0]);
    const watchers = {};
    const scope = { $watch: (key, fn) => { watchers[key] = fn; }, $on() {} };
    new Function('scope', 'document', html.match(/<script>([\s\S]+?)<\/script>/)[1])(scope, new EventTarget());
    const chart = { target: 34.5, reported: 36, supply: 32, svg: { now: { x: 100, yTarget: 90, yReported: 84, ySupply: 100 } } };
    function update(curveChart, cfg) {
        scope.msg = { payload: { curveChart, heatCtl: { cfg } } };
        watchers['msg.payload'](scope.msg.payload);
    }
    watchers['msg.hpStatic']({ curveChart: { svg: {
        viewBox: '0 0 700 260', top: 12, bottom: 212, yMin: 20, yMax: 60, line: '44,12 590,212'
    } } });
    update(chart, { bandDown: 1.5, bandUp: 3 });
    assert.match(html, /class="band-low"[^>]+hpCurvePlot\.lowShift/);
    assert.match(html, /class="band-high"[^>]+hpCurvePlot\.highShift/);
    assert.equal(scope.hpCurvePlot.lowShift, 7.5);
    assert.equal(scope.hpCurvePlot.highShift, -15);
    assert.ok(scope.hpCurvePlot.top <= -3 && scope.hpCurvePlot.bottom >= 219.5);
    assert.equal(scope.hpCurvePlot.viewBox, '0 -15 700 283');
    assert.deepStrictEqual(scope.hpCurvePlot.markers.map(p => [p.label, p.value, p.y]), [
        ['Curve target now', 34.5, 139.5], ['Pump set (fixed, DP 125)', 36, 132], ['Supply now', 32, 152]
    ]);
    assert.match(html, /<title>\{\{point\.label\}\}: \{\{point\.value\}\} °C<\/title>/);
    update({ ...chart, supply: null, svg: { now: { ...chart.svg.now, ySupply: null } } }, { bandDown: 0, bandUp: 2 });
    assert.equal(scope.hpCurvePlot.lowShift, 0);
    assert.equal(scope.hpCurvePlot.highShift, -10);
    assert.equal(scope.hpCurvePlot.markers.length, 2);
    update({ ...chart, supply: 66 }, { bandDown: 0, bandUp: 2 });
    assert.equal(scope.hpCurvePlot.markers.at(-1).y, -18);
    assert.ok(scope.hpCurvePlot.top <= -18);
    update({ ...chart, target: null, svg: { now: null } }, { bandDown: 1.5, bandUp: 3 });
    assert.deepStrictEqual(scope.hpCurvePlot.markers, []);
    assert.equal(scope.hpCurvePlot.lowShift, 7.5);
    update({ ...chart, target: null, svg: { now: null } });
    assert.deepStrictEqual(scope.hpCurvePlot.markers, []);
    assert.equal(scope.hpCurvePlot.lowShift, null);
    assert.equal(scope.hpCurvePlot.highShift, null);
    update(null);
    assert.equal(scope.hpCurvePlot, null);
});

test('heating editor previews both coefficients against the stored owner curve', () => {
    const now = Date.UTC(2026, 10, 24, 18);
    const state = loadHeatPumpState();
    state.flow.set('dhwView', { at: now, state: 'DHW', outAvg: -2, heatCurve: { p23: 38, p24: 4 } });
    const chart = state.run({ topic: 'hp', payload: { data: { dps: { 132: '1', 133: 20, 134: 12 } } } }, { now }).result[0].payload.curveChart;
    assert.deepStrictEqual([chart.p23, chart.p24, chart.pumpP23, chart.pumpP24], [38, 4, 20, 12]);
    assert.equal(chart.differsFromPump, true);
    const html = readSource(FILES[0]);
    const scope = { $watch() {}, $on() {}, hpStatic: { curveChart: chart }, msg: { payload: { curveChart: chart } } };
    new Function('scope', 'document', html.match(/<script>([\s\S]+?)<\/script>/)[1])(scope, new EventTarget());
    scope.hpCurveReset();
    assert.equal(scope.hpCurveChanged(), false);
    Object.assign(scope.hp, { p23: 40, p24: 9 });
    assert.equal(scope.hpCurveChanged(), true);
    assert.deepStrictEqual(chart.table.map(row => [row.out, row.set, scope.hpCurvePreviewAt(row.out)]),
        [[-20, 43.2, 60], [-10, 39.2, 60], [-5, 37.2, 60], [0, 35.2, 56], [5, 33.2, 51.5], [10, 31.2, 47]]);
    assert.equal(scope.hpPreviewLine().split(' ').length, 51);
});

test('heating editor displays the unconfirmed result without replacing the edit', () => {
    const html = readSource(FILES[0]);
    const watchers = {}, messages = [];
    const scope = { $watch: (key, fn) => { watchers[key] = fn; }, $on() {}, send: msg => messages.push(msg) };
    new Function('scope', 'document', 'confirm', 'setTimeout', html.match(/<script>([\s\S]+?)<\/script>/)[1])(
        scope, new EventTarget(), () => true, () => {}
    );
    scope.msg = { payload: { controls: { curve: true }, curveChart: { p23: 38, p24: 4 } } };
    watchers['msg.payload'](scope.msg.payload);
    Object.assign(scope.hp, { p23: 40, p24: 9, dirty: true });
    scope.hpApplyCurve();
    assert.deepStrictEqual(messages[0], { topic: 'curve', payload: { p23: 40, p24: 9, requestId: scope.hp.curveSent } });
    scope.msg.payload.curveChart.ownerCurveResult = { requestId: scope.hp.curveSent, text: 'Heating curve not applied: not confirmed', ok: false };
    watchers['msg.payload'](scope.msg.payload);
    assert.equal(scope.hp.curveSent, null);
    assert.match(scope.hp.curveMessage, /not confirmed/);
    assert.deepStrictEqual([scope.hp.p23, scope.hp.p24], [40, 9]);
});

test('Colder / Warmer previews on input and queues one owner P23 change on release', () => {
    const now = Date.UTC(2026, 10, 24, 18);
    const state = loadHeatPumpState();
    state.flow.set('dhwView', { at: now, outAvg: -9, heatCurve: { p23: 30, p24: 4 } });
    const chart = state.run({ topic: 'hp', payload: { data: { dps: { 103: 8, 132: '1', 133: 20, 134: 12 } } } }, { now }).result[0].payload.curveChart;
    const html = readSource(FILES[0]);
    const watchers = {}, messages = [], listeners = {};
    const document = { addEventListener: (key, fn) => { listeners[key] = fn; } };
    const scope = {
        $id: 42, $watch: (key, fn) => { watchers[key] = fn; }, $on() {}, $evalAsync: fn => fn(),
        send: msg => messages.push(msg)
    };
    new Function('scope', 'document', 'setTimeout', html.match(/<script>([\s\S]+?)<\/script>/)[1])(scope, document, () => {});
    scope.msg = { payload: { controls: { curve: true }, curveChart: chart } };
    watchers['msg.hpStatic']({ curveChart: chart });
    watchers['msg.payload'](scope.msg.payload);
    const slider = parseElements(html).find(el => el.tag === 'input' && el.attrs['aria-label'] === 'Heating curve P23: Colder to Warmer');
    assert.ok(slider, 'P23 slider is present');
    assert.deepStrictEqual([slider.attrs.min, slider.attrs.max, slider.attrs.step, slider.attrs['ng-model']], ['0', '40', '1', 'hp.p23']);
    assert.equal(scope.hp.p23, 30);
    scope.hp.p24 = 9; // unsaved Advanced edit must not affect the quick adjustment
    for (const p23 of [32, 31]) {
        scope.hp.p23 = p23;
        assert.equal(slider.attrs['ng-change'], 'hpEditCurveSlider()');
        scope.hpEditCurveSlider();
        assert.deepStrictEqual(messages, []);
        assert.notEqual(scope.hpPreviewLine(), chart.svg.line);
    }
    assert.equal(scope.hpCurveOutdoorPreview(), 'at -9 °C the set point goes 35.6 → 36.0 °C');
    chart.outdoor = null;
    assert.equal(scope.hpCurveOutdoorPreview(), 'no outdoor value');
    chart.outdoor = -9;

    const release = (valueAsNumber = 31) => listeners.change({ target: { id: scope.hpCurveSliderId, valueAsNumber } });
    release(30);
    assert.deepStrictEqual([scope.hp.p23, scope.hp.dirty], [30, false], 'unchanged release clears the draft');
    scope.hp.p23 = 31;
    scope.hpEditCurveSlider();
    scope.msg.payload.controls = { curve: false, curveReason: 'DHW cycle running' };
    release();
    assert.deepStrictEqual(messages, []);
    assert.deepStrictEqual([scope.hp.p23, scope.hp.dirty], [30, false], 'blocked release clears the draft');
    scope.msg.payload.controls.curve = true;
    scope.hp.p23 = 31;
    scope.hpEditCurveSlider();
    scope.msg.payload.controls.curve = false;
    watchers['msg.payload'](scope.msg.payload);
    assert.deepStrictEqual([scope.hp.p23, scope.hp.dirty], [30, false], 'disabled mid-drag resets even without a native change');
    scope.hp.p24 = 9;
    scope.hpEditAdvancedCurve();
    watchers['msg.payload'](scope.msg.payload);
    assert.deepStrictEqual([scope.hp.p24, scope.hp.dirty], [9, true], 'disabled slider leaves the Advanced draft alone');
    scope.msg.payload.controls.curve = true;
    release();
    assert.ok(scope.hp.curveSent);
    release();
    assert.deepStrictEqual(messages, [{ topic: 'curve', payload: { p23: 31, p24: 4, requestId: scope.hp.curveSent } }]);
    const forwarded = loadNode('37 Heat pump command.js').run(messages[0], { now }).result;
    assert.deepStrictEqual(forwarded, [null, null, null, { topic: 'ui', payload: { action: 'ownerCurve', ...messages[0].payload } }]);
    Object.assign(chart, { p23: 31, target: 36, ownerCurveResult: { requestId: scope.hp.curveSent, text: 'Heating curve confirmed.', ok: true } });
    watchers['msg.payload'](scope.msg.payload);
    assert.equal(scope.hp.curveSent, null);
    assert.match(scope.hp.curveMessage, /confirmed/);
    assert.equal(scope.hpCurveChanged(), false);

    const key = { key: 'ArrowRight' };
    assert.equal(slider.attrs['ng-keydown'], 'hpCurveSliderKeyDown($event)');
    assert.equal(slider.attrs['ng-keyup'], 'hpCurveSliderKeyUp($event)');
    for (const p23 of [32, 33, 34]) {
        scope.hpCurveSliderKeyDown(key);
        scope.hp.p23 = p23;
        scope.hpEditCurveSlider();
        release(p23); // Chromium emits native change on each keyboard repeat.
    }
    assert.equal(messages.length, 1, 'held key only updates the preview');
    scope.hpCurveSliderKeyUp(key);
    assert.deepStrictEqual(messages.slice(1), [{ topic: 'curve', payload: { p23: 34, p24: 4, requestId: scope.hp.curveSent } }]);
});

test('history day chips start on the newest week and page between available weeks only', () => {
    const html = readSource(FILES[1]);
    const messages = [];
    let receive;
    const scope = { send: msg => messages.push(msg), $watch: (_, fn) => { receive = fn; }, $on() {} };
    new Function('scope', 'setTimeout', 'setInterval', html.match(/<script>([\s\S]+?)<\/script>/)[1])(
        scope, () => {}, () => {}
    );
    const summary = days => receive({ topic: 'hpHistory', payload: { kind: 'summary', days } });
    const days = Array.from({ length: 28 }, (_, i) => ({ day: new Date(Date.UTC(2026, 10, 23 - i)).toISOString().slice(0, 10) }))
        .filter(d => d.day < '2026-11-09' || d.day > '2026-11-15'); // one week with no files
    const chips = () => scope.h.chips.map(d => d.day);
    summary(days);
    assert.match(html, /ng-repeat="d in h\.chips track by d\.day"/);
    assert.match(html, /ng-disabled="!hpWeekTarget\(1\)" ng-click="hpGoWeek\(1\)"/);
    assert.match(html, /ng-disabled="!hpWeekTarget\(-1\)" ng-click="hpGoWeek\(-1\)"/);
    assert.equal(scope.h.sel, '2026-11-23');
    assert.deepStrictEqual(chips(), ['2026-11-23']);
    assert.equal(scope.hpWeekTarget(-1), null);
    scope.hpGoWeek(1);
    assert.equal(scope.h.sel, '2026-11-22');
    assert.equal(messages.at(-1).payload.day, '2026-11-22');
    assert.deepStrictEqual(chips(), days.slice(1, 8).map(d => d.day).reverse());
    assert.ok(chips().length <= 14);
    summary(days);
    assert.equal(scope.h.sel, '2026-11-22');
    scope.hpGoWeek(1);
    assert.equal(scope.h.sel, '2026-11-08');
    scope.hpGoWeek(1);
    assert.equal(scope.hpWeekTarget(1), null);
    const count = messages.length;
    scope.hpGoWeek(1);
    assert.equal(messages.length, count);
    scope.hpGoWeek(-1);
    assert.equal(scope.h.sel, '2026-11-08');
    scope.hpLoad(days[0].day);
    assert.deepStrictEqual(chips(), ['2026-11-23']);
    scope.hpLoad(scope.hpStep(1));
    assert.equal(scope.h.sel, '2026-11-22');
    assert.equal(chips().length, 7);
    summary([]);
    assert.deepStrictEqual(chips(), []);
    assert.equal(scope.hpWeekTarget(1), null);
});

test('boiler curve edits preview against the static frame after a live update', () => {
    const html = fs.readFileSync(path.join(ROOT, FILES[0]), 'utf8');
    const scope = { $watch() {}, $on() {} };
    vm.runInNewContext(html.match(/<script>([\s\S]+?)<\/script>/)[1], { scope: scope, document: new EventTarget() });
    scope.msg = { payload: { dhwChart: { svg: { now: null } } } };
    scope.hp.dhw = { curve: [[0, 50], [10, 40]], frostLimit: 0 };
    assert.strictEqual(scope.hpDhwPreviewLine(), '');
    scope.hpStatic = { dhwChart: { svg: {
        outMin: 0, outMax: 1, yMin: 30, yMax: 60, left: 10, right: 100, top: 10, bottom: 100
    } } };
    assert.strictEqual(scope.hpDhwPreviewLine(), '10.0,40.0 100.0,43.0');
});

// Paths that can never be null/undefined once the element renders (regex on the dotted path -> reason).
const ALLOW = [
    [/^[tepr]\.(x|y|w)$/, 'ng-repeat items built with numeric coordinates by the producer (ticks, events, motion points)'],
    [/^point\.y$/, 'marker list only includes finite coordinates and readings'],
    [/^hpCurvePlot\.(top|bottom)$/, 'required chart plot supplies both edges from its static SVG frame'],
    [/^hpStatic\.(curveChart|dhwChart)\.svg\.(left|right|top|bottom|line|startLine|supplyLine)$/, 'static geometry is built as a unit; chart wrappers require the static part'],
    [/^msg\.payload\.(curveChart|dhwChart)\.svg\.now\.x$/, 'now.x is numeric whenever the "now" object exists (parent ng-if on now)'],
    [/^h\.day\.chart\.(left|right|t1|b2|evTop|evH)$/, 'static chart geometry set with chart'],
    [/^h\.day\.chart\.plan\.(x0|xNow)$/, 'plan x values come from clamped numeric sOf()/xs()'],
    [/^h\.hov\.x$/, 'hover x is set together with h.hov.chart (cursor is under ng-if on h.hov.chart)'],
    [/^pc\.(top|bottom)$/, 'panel geometry set with the panel'],
    [/^(hpPreviewLine|hpDhwPreviewLine)$/, 'function returns a string'],
    [/^s\.segs$|^p$/, 'polyline point strings joined by the producer (may be empty, never null)']
];

function parseElements(html) {
    const out = [];
    const stack = [];
    const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(html))) {
        const tag = m[1].toLowerCase();
        if (m[0].startsWith('</')) {
            while (stack.length && stack.pop().tag !== tag) { /* pop to the matching open tag */ }
            continue;
        }
        const attrs = {};
        for (const a of m[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
        const el = { tag, attrs, line: html.slice(0, m.index).split('\n').length, parents: stack.slice() };
        out.push(el);
        if (!m[3] && !/^(br|hr|img|input|meta|link)$/.test(tag)) stack.push(el);
    }
    return out;
}

function pathsOf(expr) {
    const s = expr.replace(/'[^']*'|"[^"]*"/g, '').replace(/\{\{|\}\}/g, ' ');
    return [...new Set((s.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) || []).filter((p) => !/^(true|false|null|undefined)$/.test(p)))];
}

function guardsOf(el) {
    return [el, ...el.parents].map((e) => e.attrs['ng-if']).filter(Boolean).join(' && ');
}

for (const file of FILES) {
    test(`${file}: SVG position bindings are guarded against null`, () => {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const problems = [];
        let checked = 0;
        for (const el of parseElements(html)) {
            if (!/^(circle|line|rect|path|polyline|text)$/.test(el.tag)) continue;
            const guard = guardsOf(el);
            for (const a of ATTRS) {
                const v = el.attrs['ng-attr-' + a];
                if (v === undefined || !v.includes('{{')) continue;
                checked++;
                for (const p of pathsOf(v)) {
                    if (ALLOW.some(([re]) => re.test(p))) continue;
                    if (guard.includes(p)) continue;
                    problems.push(`${file}:${el.line} <${el.tag}> ng-attr-${a} binds "${p}" without an ng-if checking it`);
                }
            }
        }
        assert.ok(checked > 20, 'expected to find SVG bindings');
        assert.deepStrictEqual(problems, []);
    });
}
