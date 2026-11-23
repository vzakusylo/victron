'use strict';

const TYPES = new Set([
    'function', 'http in', 'http response', 'exec', 'inject', 'change', 'switch', 'delay', 'link in', 'link out', 'file',
    'ui_button', 'ui_dropdown', 'ui_switch', 'ui_slider', 'ui_numeric', 'ui_text_input', 'ui_date_picker',
    'ui_colour_picker', 'ui_form', 'ui_text', 'ui_gauge', 'ui_chart', 'ui_template', 'ui_audio', 'ui_toast', 'ui_ui_control'
]);
const removable = type => TYPES.has(type) || /^victron-input-[a-z0-9-]+$/.test(type);
const OPTIONAL_UI_GROUP = new Set(['ui_ui_control', 'ui_toast', 'ui_audio']);
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

function additionPlan(live, repo, allowNewNodes, allowNewWires = []) {
    const byId = (nodes) => new Map(nodes.map((node) => [node.id, node]));
    const original = byId(live), source = byId(repo);
    if (original.size !== live.length || source.size !== repo.length) fail('Duplicate node IDs.');
    const removed = live.filter((node) => !source.has(node.id));
    if (removed.length) fail('Removing GX nodes is not supported: ' + removed.map((node) => node.id).join(', ') + '.');
    const additions = repo.filter((node) => !original.has(node.id));
    const reviewed = new Set(allowNewWires);
    if (reviewed.size !== allowNewWires.length) fail('Duplicate source IDs in allow_new_wires.');
    if (!additions.length && !reviewed.size) return { add: [], wire: [] };
    if (additions.length && !allowNewNodes) fail('New nodes require --allow-new-nodes (-AllowNewNodes in PowerShell).');

    const added = byId(additions);
    const final = new Map([...original, ...added]);
    const routes = live.filter((node) => node.type === 'http in');
    const groups = new Map();
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
        if (node.type.startsWith('ui_') && original.get(node.group)?.type !== 'ui_group') {
            if (!OPTIONAL_UI_GROUP.has(node.type)) fail(node.id + ': the ui_group must already exist on the GX.');
            if (node.group !== undefined && node.group !== '') {
                fail(node.id + ': ui_group ' + node.group + ' does not exist on the GX.');
            }
        }
        if (node.g) {
            const group = source.get(node.g);
            const liveGroup = original.get(node.g);
            if (group?.type !== 'group' || group.z !== node.z || !Array.isArray(group.nodes) ||
                group.nodes.filter((id) => id === node.id).length !== 1 ||
                (liveGroup && (liveGroup.type !== 'group' || liveGroup.z !== node.z || !Array.isArray(liveGroup.nodes)))) {
                fail(node.id + ': invalid layout group membership.');
            }
            if (liveGroup && !liveGroup.nodes.includes(node.id)) {
                if (!groups.has(node.g)) groups.set(node.g, new Set());
                groups.get(node.g).add(node.id);
            }
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
    const newConnections = [];
    for (const node of repo) {
        const before = original.get(node.id);
        const optedIn = reviewed.has(node.id);
        if (!before || (!optedIn && !wireLists(node).flat().some((id) => added.has(id)))) continue;
        const oldWires = wireLists(before), newWires = wireLists(node);
        const preservesWires = newWires.length >= oldWires.length && newWires.every((out, i) =>
            equal(optedIn ? out.slice(0, oldWires[i]?.length || 0) : out.filter((id) => !added.has(id)), oldWires[i] || []) &&
            (i < oldWires.length || out.length > 0) &&
            new Set(out).size === out.length &&
            out.every((id) => !added.has(id) || (added.get(id).type !== 'group' && added.get(id).z === node.z)));
        const preservesOutputs = before.outputs === node.outputs
            ? newWires.length === oldWires.length
            : node.type === 'function' && before.outputs === oldWires.length && node.outputs === newWires.length;
        if (before.type !== node.type || before.z !== node.z || !preservesWires || !preservesOutputs) {
            if (optedIn) fail(node.id + ': reviewed wires must be append-only and may only grow function outputs.');
            fail(node.id + ': a wire patch may only add connections (and necessary function outputs) to new nodes. ' +
                'To add a connection to an existing node, list ' + node.id + ' in allow_new_wires after reviewing the compare.');
        }
        if (optedIn) {
            for (const [output, out] of newWires.entries()) {
                for (const dest of out.slice(oldWires[output]?.length || 0)) {
                    const target = final.get(dest);
                    if (original.get(node.z)?.type !== 'tab' || !target || target.z !== node.z || ['tab', 'group'].includes(target.type)) {
                        fail(node.id + ': invalid wire target ' + dest + '.');
                    }
                    newConnections.push({ id: node.id, output, dest, name: source.get(dest).name || '', added: added.has(dest) });
                }
            }
            if (newConnections.at(-1)?.id !== node.id) fail(node.id + ': no new connections to review in allow_new_wires.');
            reviewed.delete(node.id);
        }
        wire.push(node.id);
    }
    if (reviewed.size) fail('allow_new_wires source must exist on the GX and in the target: ' + [...reviewed].join(', ') + '.');
    const groupMembers = new Map();
    for (const [id, newMembers] of groups) {
        const liveMembers = original.get(id).nodes;
        const liveSet = new Set(liveMembers);
        const repoMembers = source.get(id).nodes;
        const repoSet = new Set(repoMembers);
        if (liveSet.size !== liveMembers.length || repoSet.size !== repoMembers.length) {
            fail(id + ': duplicate layout group members alongside addition.');
        }
        const ordered = repoMembers.filter(member => liveSet.has(member) || newMembers.has(member));
        // Fill repository-member slots in target order, leaving live-only memberships in place.
        let next = 0;
        const members = liveMembers.map(member => repoSet.has(member) ? ordered[next++] : member);
        groupMembers.set(id, members.concat(ordered.slice(next)));
    }
    return { add: additions.map((node) => node.id), wire, ...(groupMembers.size ? { groups: [...groupMembers.keys()], groupMembers } : {}),
        ...(newConnections.length ? { newConnections } : {}) };
}

function recordedCommit(info = '') {
    const records = [...info.matchAll(/<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/g)];
    if (records.length !== 1 || (info.match(/<!-- \/?victron-deployment-source -->/g) || []).length !== 2) {
        fail('The GX deployment record is missing or ambiguous.');
    }
    const record = JSON.parse(records[0][1]);
    if (!/^[a-f0-9]{40}$/.test(record?.dashboard || '') || record.dashboard !== record.automations) {
        fail('An identical Git deployment SHA for dashboard and automations is required for removals.');
    }
    return record.dashboard;
}

function removalPlan(live, target, allowed, baseline = []) {
    const byId = nodes => new Map(nodes.map(node => [node.id, node]));
    const original = byId(live), source = byId(target), previous = byId(baseline);
    if (original.size !== live.length || source.size !== target.length || previous.size !== baseline.length) fail('Duplicate node IDs.');
    const remove = live.filter(node => !source.has(node.id)).map(node => node.id);
    const removed = new Set(remove), approved = new Set(allowed);
    if (approved.size !== allowed.length || allowed.some(id => !/^[a-zA-Z0-9_.-]+$/.test(id))) fail('Invalid or duplicate removal IDs.');
    const unexpected = remove.filter(id => !approved.has(id));
    if (unexpected.length) fail('Removing GX nodes is not supported without listing every removal: ' + unexpected.join(', ') + '.');
    const unused = allowed.filter(id => !removed.has(id));
    if (unused.length) fail('Listed IDs would not be removed: ' + unused.join(', ') + '.');
    if (!removed.size) return { remove, reconnect: {} };

    for (const id of remove) {
        const node = original.get(id), known = previous.get(id);
        if (!known || !node.definition || node.definition !== known.definition) fail(id + ': GX node does not match the recorded commit.');
        if (['tab', 'group'].includes(node.type) || original.get(node.topology.z)?.type !== 'tab') {
            fail(id + ': removing tabs, groups or configuration nodes requires a manual deploy.');
        }
        if (!removable(node.type)) {
            fail(id + ': node type ' + node.type + ' is not removable by the deploy tool; remove it in the Node-RED editor or extend the list.');
        }
    }

    const reconnect = Object.create(null);
    for (const node of target) {
        const current = original.get(node.id);
        const from = current?.topology;
        const to = node.topology;
        if (Object.values(to).some(value => Array.isArray(value) && value.flat().some(id => removed.has(id)))) {
            fail(node.id + ': target still references a removed node.');
        }
        if (!from) continue;
        const fields = Object.create(null);
        for (const key of ['wires', 'links', 'nodes']) {
            const recorded = previous.get(node.id)?.topology[key];
            const groupMembers = key === 'nodes' && current.type === 'group';
            const recordedRemoval = groupMembers && Array.isArray(recorded) && recorded.some(id => removed.has(id));
            if (!recordedRemoval && !from[key]?.flat().some(id => removed.has(id))) continue;
            const old = from[key], next = to[key] || [];
            if (groupMembers) {
                const field = node.id + '.nodes';
                if (node.type !== current.type || from.z !== to.z || ![old, recorded, next].every(Array.isArray)) {
                    fail(field + ': invalid group topology alongside removal.');
                }
                const [gx, commit, targetSet] = [old, recorded, next].map(list => new Set(list));
                if (gx.size !== old.length || commit.size !== recorded.length || targetSet.size !== next.length) {
                    fail(field + ': duplicate group members alongside removal.');
                }
                const onlyGX = old.filter(id => !commit.has(id));
                const onlyCommit = recorded.filter(id => !gx.has(id));
                if (onlyGX.length || onlyCommit.length) {
                    fail(field + ': GX differs from the recorded commit: only on GX [' + onlyGX.join(', ') +
                        '], only in commit [' + onlyCommit.join(', ') + ']');
                }
                const surviving = new Set(old.filter(id => !removed.has(id)));
                const existing = next.filter(id => original.has(id));
                if (surviving.size !== existing.length || existing.some(id => !surviving.has(id))) {
                    fail(field + ': unsafe member change alongside removal.');
                }
                fields[key] = existing;
                continue;
            }
            if (node.type !== current.type || from.z !== to.z || !equal(old, recorded)) {
                fail(node.id + '.' + key + ': GX connections do not match the recorded commit.');
            }
            if (key === 'wires') {
                if (from.outputs !== to.outputs || old.length !== next.length) {
                    if (to.outputs > from.outputs || next.length > old.length) {
                        fail(node.id + ': output count cannot increase alongside removal.');
                    }
                    if (from.outputs !== previous.get(node.id)?.topology.outputs) {
                        fail(node.id + ': GX output count does not match the recorded commit.');
                    }
                    if (!Array.isArray(to.wires) || from.outputs !== old.length || to.outputs !== next.length ||
                        next.length >= old.length) {
                        fail(node.id + ': inconsistent output counts alongside removal.');
                    }
                    for (let i = next.length; i < old.length; i++) {
                        if (!Array.isArray(old[i]) || !old[i].length) {
                            fail(node.id + ': output ' + i + ' dropped but it has no approved removal destinations.');
                        }
                        const kept = old[i].filter(id => !removed.has(id));
                        if (kept.length) {
                            fail(node.id + ': output ' + i + ' dropped but it still wires to kept node(s) [' + kept.join(', ') + '].');
                        }
                    }
                    fields.outputs = to.outputs;
                }
                // Rerouting is limited to outputs that lose an approved destination.
                const valid = Array.isArray(to.wires) &&
                    next.every(out => Array.isArray(out) && new Set(out).size === out.length &&
                        out.every(id => source.get(id)?.topology.z === to.z && !['tab', 'group'].includes(source.get(id)?.type))) &&
                    old.slice(0, next.length).every((out, i) => out.some(id => removed.has(id))
                        ? equal(out.filter(id => !removed.has(id)), next[i].filter(id => out.includes(id)))
                        : equal(out, next[i].filter(id => original.has(id))));
                if (!valid) fail(node.id + ': unsafe wiring change alongside removal.');
            } else if (!equal(old.filter(id => !removed.has(id)), next.filter(id => original.has(id)))) {
                fail(node.id + '.' + key + ': unsafe connection change alongside removal.');
            }
            fields[key] = key === 'wires' ? next.map(out => out.filter(id => original.has(id))) : old.filter(id => !removed.has(id));
        }
        if (Object.keys(fields).length) reconnect[node.id] = fields;
    }
    return { remove, reconnect };
}

function cleanTopology(nodes, { remove, reconnect }) {
    const removed = new Set(remove);
    return nodes.filter(node => !removed.has(node.id)).map(node => Object.hasOwn(reconnect, node.id) ? { ...node, ...reconnect[node.id] } : node);
}

module.exports = { additionPlan, describe, recordedCommit, removalPlan, cleanTopology };
