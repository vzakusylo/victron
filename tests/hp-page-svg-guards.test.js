'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource } = require('./harness');

const ROOT = path.join(__dirname, '..');
const FILES = ['35 Heat pump page.html', '39 Heat pump history page.html'];
const ATTRS = ['cx', 'cy', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'd', 'points', 'width', 'height'];

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
    vm.runInNewContext(html.match(/<script>([\s\S]+?)<\/script>/)[1], { scope: scope });
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
