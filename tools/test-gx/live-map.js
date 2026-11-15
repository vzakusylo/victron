'use strict';
// Rewrites a snapshot of the REAL GX (tools/gx/live-snapshot.js --raw) with the original -> fake pairs that
// sanitize-backup.js wrote, so it can be compared with the sanitized image. One direction only: originals are
// replaced by fakes; the image is never touched. Values never go into the result's report, only counts.
const crypto = require('crypto');
const { stable } = require('../gx/live-snapshot.js');

const MAP_FORMAT = 'test-gx-map-v1';
const SECRET_SHAPES = [
    ['id', /\b[a-z0-9]{20,24}\b/g, (s) => /[0-9]/.test(s) && /[a-z]/.test(s)],
    ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (s) => !/^(?:127|0|10\.99)\./.test(s)],
    ['mac', /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, () => true],
    ['email', /[^@\s"']+@[^@\s"']+\.[a-z]+/gi, (s) => !/@example\.invalid$|@victronenergy\.com$/.test(s)],
];

function parseMap(text) {
    const data = JSON.parse(text);
    if (!data || data.format !== MAP_FORMAT || !Array.isArray(data.pairs)) throw new Error('not a ' + MAP_FORMAT + ' file');
    return data.pairs;
}

// Longest originals first, so an id that contains a shorter value is not replaced partially.
function makeApply(pairs, counts) {
    const ordered = [...pairs].sort((a, b) => b.from.length - a.from.length);
    return (text) => {
        for (const { from, to, kind } of ordered) {
            if (!text.includes(from)) continue;
            counts[kind] = (counts[kind] || 0) + text.split(from).length - 1;
            text = text.split(from).join(to);
        }
        return text;
    };
}

const mapDeep = (value, apply) => {
    if (typeof value === 'string') return apply(value);
    if (Array.isArray(value)) return value.map((v) => mapDeep(v, apply));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[apply(k)] = mapDeep(v, apply);
        return out;
    }
    return value;
};

// Values that look like ids / addresses; returned as {kind: Set}.
function shapeValues(text) {
    const found = {};
    for (const [kind, re, keep] of SECRET_SHAPES) found[kind] = new Set((text.match(re) || []).filter(keep));
    return found;
}

// Only counts per kind; values that also stand unchanged in `baseline` (the image: comments, LAN addresses the
// sanitizer deliberately left) are not new. What remains was added on the GX after the backup.
function unmappedShapes(text, baselineText) {
    const found = {}, base = baselineText ? shapeValues(baselineText) : {};
    for (const [kind, set] of Object.entries(shapeValues(text))) {
        const fresh = [...set].filter((v) => !(base[kind] && base[kind].has(v)));
        if (fresh.length) found[kind] = fresh.length;
    }
    return found;
}

// Returns { snapshot, replaced: {kind: n}, unmapped: {kind: n}, restMissing: n }. `baseline` is the image snapshot.
function applyMap(snap, pairs, baseline) {
    const replaced = {};
    const apply = makeApply(pairs, replaced);
    let restMissing = 0;
    const seen = [];
    const strip = makeApply(pairs.map((p) => ({ from: p.from, to: ' ', kind: p.kind })), {});
    const nodes = snap.nodes.map((node) => {
        const out = Object.assign({}, node);
        out.code = {};
        for (const [field, value] of Object.entries(node.code || {})) { out.code[field] = apply(value); seen.push(strip(value)); }
        if (typeof node.restJson === 'string') {
            const mapped = stable(mapDeep(JSON.parse(node.restJson), apply));
            out.rest = crypto.createHash('sha1').update(mapped).digest('hex').slice(0, 12);
            out.restJson = mapped;
            seen.push(strip(node.restJson));
        } else restMissing++;
        if (typeof out.name === 'string') out.name = apply(out.name);
        return out;
    });
    const baselineText = baseline ? baseline.nodes.map((n) => Object.values(n.code || {}).join('\n')).join('\n') : '';
    return { snapshot: Object.assign({}, snap, { nodes }), replaced, unmapped: unmappedShapes(seen.join('\n'), baselineText), restMissing };
}

module.exports = { MAP_FORMAT, parseMap, applyMap, unmappedShapes };
