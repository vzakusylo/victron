'use strict';

function wholeFlowTools() {
    const crypto = require('crypto');
    const code = new Set(['func', 'initialize', 'finalize', 'format', 'command']);
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    function stable(value) {
        if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
        if (value !== null && typeof value === 'object') {
            return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
        }
        return JSON.stringify(value);
    }

    function versionTab(flows) {
        const tabs = flows.filter(node => node.type === 'tab' && /d#\d+/.test(node.label || ''));
        if (tabs.length !== 1) throw new Error('Expected exactly one d# version tab.');
        return tabs[0];
    }

    function recordedBase(tab) {
        const info = tab.info || '';
        const records = [...info.matchAll(/<!-- victron-deployment-source -->\s*([\s\S]*?)\s*<!-- \/victron-deployment-source -->/g)];
        let record;
        if (records.length === 1 && (info.match(/<!-- \/?victron-deployment-source -->/g) || []).length === 2) {
            try { record = JSON.parse(records[0][1]); }
            catch { throw new Error('Invalid deployment record JSON.'); }
        }
        if (!record || Object.keys(record).length !== 2 ||
            typeof record.dashboard !== 'string' || !/^[a-f0-9]{40}$/.test(record.dashboard) ||
            record.dashboard !== record.automations) {
            throw new Error('The deployment record must contain the same Git SHA for dashboard and automations.');
        }
        return record.dashboard;
    }

    function fingerprints(flows, normalizeCode = true) {
        return flows.map(node => {
            const fields = Object.fromEntries(Object.keys(node).sort()
                .filter(key => key !== 'x' && key !== 'y')
                .map(key => {
                    const value = node.type === 'group' && key === 'nodes' && Array.isArray(node.nodes)
                        ? [...new Set(node.nodes)].sort() : node[key];
                    return [key, hash(stable(normalizeCode && code.has(key) && typeof value === 'string'
                        ? value.replace(/\r\n/g, '\n').trimEnd() : value))];
                }));
            return { id: node.id, fields };
        });
    }

    function differences(before, after) {
        const index = nodes => {
            const map = new Map(nodes.map(node => [node.id, node.fields]));
            if (map.size !== nodes.length) throw new Error('Duplicate flow node IDs.');
            return map;
        };
        const from = index(before);
        const to = index(after);
        const added = [...to.keys()].filter(id => !from.has(id));
        const removed = [...from.keys()].filter(id => !to.has(id));
        const changed = [];
        for (const [id, fields] of to) {
            if (!from.has(id)) continue;
            const previous = from.get(id);
            const keys = [...new Set([...Object.keys(previous), ...Object.keys(fields)])].sort()
                .filter(key => !Object.hasOwn(previous, key) || !Object.hasOwn(fields, key) || previous[key] !== fields[key]);
            if (keys.length) changed.push({ id, fields: keys });
        }
        return { added, removed, changed };
    }

    function checkDrift(base, live, sha, { overwrite = false, target, logEqual = true } = {}) {
        const { added, removed, changed } = differences(base, live);
        if (!added.length && !removed.length && !changed.length) {
            if (logEqual) console.log('drift gate      : live flow equals ' + sha);
            return true;
        }
        const deploy = target && differences(live, target);
        const targetAdds = new Set(deploy?.added);
        const targetRemoves = new Set(deploy?.removed);
        const targetEdits = new Map(deploy?.changed.map(({ id, fields }) => [id, new Set(fields)]));
        const blocked = [];
        const note = (id, field, adopted) => {
            const line = [id, field].map(value => String(value).replace(/[^\w.()-]/g, '?')).join(' ');
            if (adopted) console.log('adopted drift  : ' + line);
            else blocked.push(line);
        };
        for (const id of added) note(id, '(added)', deploy && !targetRemoves.has(id) && !targetEdits.has(id));
        for (const id of removed) note(id, '(missing)', deploy && !targetAdds.has(id));
        for (const { id, fields } of changed) {
            for (const field of fields) note(id, field, deploy && !targetRemoves.has(id) && !targetEdits.get(id)?.has(field));
        }
        if (!blocked.length) return true;
        const detail = `live flow differs from ${sha} (drift):\n` + blocked.slice(0, 20).join('\n');
        if (!overwrite) throw new Error(detail);
        console.log('overwrite drift : ' + detail);
        return false;
    }

    function report({ added, removed, changed }, definitions) {
        const nodes = new Map(definitions.map(node => [node.id, node]));
        const describe = id => {
            const node = nodes.get(id);
            return node ? `${id} (${node.type} ${JSON.stringify(node.name || node.label || '')})` : id;
        };
        console.log(`nodes added     : ${added.length}`);
        for (const id of added) console.log('  + ' + describe(id));
        console.log(`nodes removed   : ${removed.length}`);
        for (const id of removed) console.log('  - ' + describe(id));
        console.log(`nodes changed   : ${changed.length}`);
        for (const { id, fields } of changed) console.log('  ' + describe(id) + ': ' + fields.join(', '));
    }

    function prepared(flows, sha, prepareFlows, stampDeployment) {
        if (flows.some(node => Object.hasOwn(node, 'credentials'))) throw new Error('Refusing to send flow credentials.');
        const nodes = flows.some(node => node.type === 'tuya-smart-device') ? prepareFlows(flows) : flows;
        return stampDeployment(nodes, { dashboard: sha, automations: sha });
    }

    return { versionTab, recordedBase, fingerprints, differences, checkDrift, report, prepared };
}

if (module.id !== '[stdin]') module.exports = wholeFlowTools();
