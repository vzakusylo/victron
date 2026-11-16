'use strict';
const { snapshot, stable } = require('../gx/live-snapshot.js');
const { transformTuya } = require('./transform-tuya.js');

function validateTransformation(source, image, registry, manifest) {
    const expected = transformTuya(source, registry);
    if (stable(expected.transformed) !== stable(manifest)) throw new Error('Tuya transformation manifest is not the deterministic transformation');
    const a = snapshot(expected.flows, null, { raw: true }).nodes;
    const b = snapshot(image, null, { raw: true }).nodes;
    for (const { id } of manifest) {
        if (stable(a.find(n => n.id === id)) !== stable(b.find(n => n.id === id))) throw new Error('Sanitized Tuya transformation differs from its source: ' + id);
    }
    return expected.transformed;
}

function transformLiveSnapshot(live, registry, manifest) {
    const originals = new Set(manifest.filter(n => n.from === 'tuya-smart-device').map(n => n.id));
    const input = live.nodes.filter(n => originals.has(n.id) || n.type === 'mqtt-broker').map(n => {
        if (typeof n.restJson !== 'string') throw new Error('Tuya comparison needs a --raw live snapshot: ' + n.id);
        return Object.assign(JSON.parse(n.restJson), n.code);
    });
    // An already transformed snapshot is compared as-is, never re-whitelisted.
    if (input.some(n => originals.has(n.id) && n.type !== 'tuya-smart-device')) return live;
    const changed = transformTuya(input, registry);
    const allowed = new Set(manifest.map(n => n.id));
    if (changed.transformed.some(n => !allowed.has(n.id))) throw new Error('Unreported Tuya transformation');
    const replace = snapshot(changed.flows.filter(n => allowed.has(n.id)), null, { raw: true }).nodes;
    // Do not discard any unrelated live node, including a colliding generated ID.
    const collisions = live.nodes.filter(n => allowed.has(n.id) && !originals.has(n.id));
    if (collisions.length) throw new Error('Generated Tuya IDs already exist on live GX: ' + collisions.map(n => n.id).join(', '));
    return Object.assign({}, live, { nodes: live.nodes.filter(n => !originals.has(n.id)).concat(replace) });
}

module.exports = { validateTransformation, transformLiveSnapshot };
