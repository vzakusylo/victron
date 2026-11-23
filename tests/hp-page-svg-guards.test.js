'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['35 Heat pump page.html', '39 Heat pump history page.html'];
const ATTRS = ['cx', 'cy', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'd', 'points', 'width', 'height'];

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
