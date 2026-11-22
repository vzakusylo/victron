'use strict';

const TYPES = new Set([
    'function', 'http in', 'http response', 'exec', 'inject', 'change', 'switch', 'delay', 'link in', 'link out', 'file',
    'ui_button', 'ui_dropdown', 'ui_switch', 'ui_slider', 'ui_numeric', 'ui_text_input', 'ui_date_picker',
    'ui_colour_picker', 'ui_form', 'ui_text', 'ui_gauge', 'ui_chart', 'ui_template', 'ui_audio', 'ui_toast', 'ui_ui_control'
]);
const GROUP_FIELDS = new Set(['id', 'type', 'z', 'name', 'style', 'nodes', 'x', 'y', 'w', 'h']);
const fail = (message) => { throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const describe = (node) => ({ id: node.id, type: node.type, name: node.name || '', url: node.url || '', wires: node.wires || [] });

function routeParts(url) {
    // Match Express's case-insensitive, non-strict routing. Do not guess about
    // patterns outside literal segments and whole-segment parameters.
    if (typeof url !== 'string' || !/^\/(?:(?:[a-z0-9._~-]+|:\w+)(?:\/(?:[a-z0-9._~-]+|:\w+))*\/?)?$/i.test(url)) return null;
    return url.toLowerCase().replace(/\/$/, '').slice(1).split('/');
}

function checkRoute(node, routes) {
    const method = String(node.method || '').toLowerCase();
    const parts = routeParts(node.url);
    if (!/^(get|head|post|put|delete|patch|options)$/.test(method) || !parts || node.upload || node.swaggerDoc) {
        fail(node.id + ': HTTP route needs manual review (unsupported method, path, upload or Swagger config).');
    }
    for (const other of routes) {
        const candidate = String(other.method || '').toLowerCase();
        if (candidate && candidate !== 'all' && candidate !== method && !(['get', 'head'].includes(candidate) && ['get', 'head'].includes(method))) continue;
        const theirs = routeParts(other.url);
        if (!theirs) fail(node.id + ': cannot rule out HTTP route collision with ' + other.id + '.');
        if (parts.length === theirs.length && parts.every((segment, i) => segment === theirs[i] || segment.startsWith(':') || theirs[i].startsWith(':'))) {
            fail(node.id + ': HTTP route collision with ' + other.id + '.');
        }
    }
    routes.push(node);
}

function wireLists(node) {
    const wires = Object.hasOwn(node, 'wires') ? node.wires : [];
    if (!Array.isArray(wires) || wires.some((out) => !Array.isArray(out) || out.some((id) => typeof id !== 'string'))) {
        fail(node.id + ': invalid wire lists.');
    }
    return wires;
}

function additionPlan(live, repo, allowNewNodes) {
    const byId = (nodes) => new Map(nodes.map((node) => [node.id, node]));
    const original = byId(live), source = byId(repo);
    if (original.size !== live.length || source.size !== repo.length) fail('Duplicate node IDs.');
    const removed = live.filter((node) => !source.has(node.id));
    if (removed.length) fail('Removing GX nodes is not supported: ' + removed.map((node) => node.id).join(', ') + '.');
    const additions = repo.filter((node) => !original.has(node.id));
    if (!additions.length) return { add: [], wire: [] };
    if (!allowNewNodes) fail('New nodes require --allow-new-nodes (-AllowNewNodes in PowerShell).');

    const added = byId(additions);
    const final = new Map([...original, ...added]);
    const routes = live.filter((node) => node.type === 'http in');
    const groups = new Set();
    for (const node of additions) {
        if (original.get(node.z)?.type !== 'tab') fail(node.id + ': the tab must already exist on the GX.');
        if (Object.hasOwn(node, 'credentials')) fail(node.id + ': credentials require a manual deploy.');
        if (node.type === 'group') {
            // The sixth UTCP record is an editor group, not a runtime config node.
            if (Object.keys(node).some((key) => !GROUP_FIELDS.has(key)) || !Array.isArray(node.nodes) || !node.nodes.length ||
                new Set(node.nodes).size !== node.nodes.length ||
                node.nodes.some((id) => !added.has(id) || added.get(id).g !== node.id || added.get(id).z !== node.z)) {
                fail(node.id + ': a new layout group may contain only its own new nodes on the same tab.');
            }
            continue;
        }
        if (!TYPES.has(node.type)) fail(node.id + ': cannot add node type ' + node.type + ' (config or unsupported node).');
        if (node.type.startsWith('ui_') && original.get(node.group)?.type !== 'ui_group') fail(node.id + ': the ui_group must already exist on the GX.');
        if (node.g) {
            const group = source.get(node.g);
            const liveGroup = original.get(node.g);
            if (group?.type !== 'group' || group.z !== node.z || !Array.isArray(group.nodes) ||
                group.nodes.filter((id) => id === node.id).length !== 1 ||
                (liveGroup && (liveGroup.type !== 'group' || liveGroup.z !== node.z || !Array.isArray(liveGroup.nodes)))) {
                fail(node.id + ': invalid layout group membership.');
            }
            if (liveGroup && !liveGroup.nodes.includes(node.id)) groups.add(node.g);
        }
        for (const id of wireLists(node).flat()) {
            if (!final.has(id)) fail(node.id + ': wire to missing node ' + id + '.');
            if (final.get(id).z !== node.z || ['tab', 'group'].includes(final.get(id).type)) fail(node.id + ': invalid wire target ' + id + '.');
        }
        if (node.type === 'http in') checkRoute(node, routes);
        if (node.type === 'link in' || node.type === 'link out') {
            const expected = node.type === 'link in' ? 'link out' : 'link in';
            if (!Array.isArray(node.links) || node.links.some((id) =>
                final.get(id)?.type !== expected || !final.get(id).links?.includes(node.id))) {
                fail(node.id + ': link targets must exist and already link back (or be added together).');
            }
        }
    }

    const wire = [];
    for (const node of repo) {
        const before = original.get(node.id);
        if (!before || !wireLists(node).flat().some((id) => added.has(id))) continue;
        const oldWires = wireLists(before), newWires = wireLists(node);
        const preservesWires = newWires.length >= oldWires.length && newWires.every((out, i) =>
            equal(out.filter((id) => !added.has(id)), oldWires[i] || []) && (i < oldWires.length || out.length > 0) &&
            new Set(out).size === out.length &&
            out.every((id) => !added.has(id) || (added.get(id).type !== 'group' && added.get(id).z === node.z)));
        const preservesOutputs = before.outputs === node.outputs
            ? newWires.length === oldWires.length
            : node.type === 'function' && before.outputs === oldWires.length && node.outputs === newWires.length;
        if (before.type !== node.type || before.z !== node.z || !preservesWires || !preservesOutputs) {
            fail(node.id + ': a wire patch may only add connections (and necessary function outputs) to new nodes.');
        }
        wire.push(node.id);
    }
    return { add: additions.map((node) => node.id), wire, ...(groups.size ? { groups: [...groups] } : {}) };
}

module.exports = { additionPlan, describe };
